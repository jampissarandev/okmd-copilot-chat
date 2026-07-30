/**
 * OKMD provider implementation — registers with vscode.lm and handles
 * chat requests.
 */

import * as vscode from 'vscode';
import {
  LanguageModelChatInformation,
  LanguageModelChatProvider,
  LanguageModelChatRequestMessage,
  ProvideLanguageModelChatResponseOptions,
} from 'vscode';
import {
  BUNDLED_FALLBACK_MODELS,
  PROVIDER_ID,
  PROVIDER_NAME,
  PROVIDER_VENDOR,
} from './constants';
import { getCapabilities } from './capabilities';
import { openaiToAnthropic } from './converters/openaiToAnthropic';
import { ModelCache, OkmdModel } from './modelCache';
import { postOkmd } from './okmdClient';
import { parseOpenAiStream } from './streaming/openaiParser';
import { parseAnthropicStream } from './streaming/anthropicParser';
import { logInfo, logWarn } from './logger';
import { mapHttpError } from './errorMapping';
import { cancellationTokenToAbortSignal } from './utils/cancellation';
import { getOkmdApiKey } from './api';

export class OkmdChatProvider implements LanguageModelChatProvider {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly cache: ModelCache,
  ) {
    // VS Code 1.120+ has a confirmed bug
    // (microsoft/vscode#317414): the mere *presence* of an
    // `onDidChangeLanguageModelChatInformation` EventEmitter on
    // the provider instance — even if never fired — causes the
    // LM picker to mis-render the vendor. The user confirmed
    // this on the ExtDev Host with an alternating pattern of
    // `provideLanguageModelChatInformation` calls (14+
    // alternations in one activation) where every call returned
    // 23 models but the picker never showed OKMD. Removing the
    // EventEmitter eliminates the trigger.
    //
    // Trade-off: the picker no longer auto-refreshes when the
    // cache changes. The user runs the `okmd.refreshModelList`
    // command (or reloads the window) to pick up new models.
    // The ADR-0005 activation-order race hypothesis is the
    // secondary contributor; the EventEmitter is the primary
    // cause, and this is the documented workaround. See
    // ADR-0005 Follow-up.
  }

  async provideLanguageModelChatInformation(
    options: { readonly silent: boolean },
    _token: vscode.CancellationToken,
  ): Promise<LanguageModelChatInformation[]> {
    logInfo(
      `[picker] provideLanguageModelChatInformation called: silent=${options.silent} cache=${this.cache.getModels().length}`,
    );
    // 1. BYOK path — VS Code 1.104+ may pass the API key in
    //    `options.configuration`. Mirror the opencode-copilot-chat
    //    `getConfiguredApiKey` pattern so the vendor does not
    //    need to be re-resolved through secret storage when VS
    //    Code has the key in hand.
    const configured = (options as { configuration?: unknown }).configuration;
    let apiKey: string | undefined;
    if (configured && typeof configured === 'object') {
      const fromConfig = (configured as { apiKey?: unknown }).apiKey;
      if (typeof fromConfig === 'string' && fromConfig.trim().length > 0) {
        apiKey = fromConfig.trim();
      }
    }

    // 2. Fallback — secret storage. Only read when (a) the BYOK
    //    path did not yield a key AND (b) VS Code actually called
    //    us with a configuration object, not an undefined one.
    //    The discriminator matters:
    //    • configuration=undefined → VS Code is still resolving;
    //      return [] and let it call again with the real BYOK key.
    //    • configuration={apiKey:"sk-..."} → BYOK key resolved above.
    //    • configuration={} → empty config (VS Code 1.126+ on
    //      non-BYOK providers); fall through to secret storage.
    if (!apiKey && configured !== undefined) {
      apiKey = await getOkmdApiKey(this.context);
    }

    // 3. Not yet ready — return [] so the platform re-queries
    //    us after the user completes the BYOK flow. Returning a
    //    non-empty list with no apiKey would cause VS Code to
    //    mark the provider group as "0 models" and hide it from
    //    the picker (the same root cause ADR-0005 fixes on the
    //    activation side).
    if (!apiKey) {
      logInfo(
        '[picker] no apiKey yet (configuration=undefined) — returning [] and waiting for VS Code to re-query after BYOK resolves',
      );
      return [];
    }

    // 4. If the cache is empty when the platform calls (e.g. on
    //    the very first invocation after a fresh install) refresh
    //    once. On subsequent calls the cache is populated from
    //    `globalState` synchronously during activation, so this
    //    branch is a no-op in the common case.
    //
    //    3-tier fallback (mirrors opencode-copilot-chat):
    //    • cache hit        → use it
    //    • network refresh  → try; on failure fall through
    //    • bundled fallback → last resort so the vendor is never
    //                          empty just because the network is
    //                          flaky on a fresh install.
    if (this.cache.getModels().length === 0) {
      try {
        await this.cache.refresh();
      } catch (err) {
        // The cache already logs its own warning. Swallow here
        // so we can fall through to the bundled list and keep
        // the picker visible.
        logWarn(
          'OKMD model-list refresh failed; falling back to bundled snapshot',
          err,
        );
      }
    }
    let models = this.cache.getModels();
    if (models.length === 0) {
      logWarn(
        '[picker] cache still empty after refresh — falling back to BUNDLED_FALLBACK_MODELS',
      );
      models = BUNDLED_FALLBACK_MODELS;
    }
    const result = await Promise.all(
      models.map((m) => this.toChatInformation(m, apiKey)),
    );
    logInfo(`[picker] returning ${result.length} models`);
    return result;
  }

  async provideLanguageModelChatResponse(
    model: LanguageModelChatInformation,
    messages: readonly LanguageModelChatRequestMessage[],
    options: ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const apiKey = await getOkmdApiKey(this.context);
    if (!apiKey) {
      throw vscode.LanguageModelError.NoPermissions(
        'OKMD API key not configured. Open Copilot → Manage Models → OKMD to add it.',
      );
    }

    // Reconstruct the OKMD name from the VS Code id (`okmd/<name>`).
    const okmdName = model.id.startsWith(`${PROVIDER_ID}/`)
      ? model.id.slice(PROVIDER_ID.length + 1)
      : model.id;
    let modelId = this.cache.getIdByName(okmdName);
    if (modelId === undefined) {
      // Cache miss — refresh once and retry.
      await this.cache.refresh();
      modelId = this.cache.getIdByName(okmdName);
      if (modelId === undefined) {
        throw vscode.LanguageModelError.NotFound(`OKMD model ${okmdName} not found`);
      }
    }
    await this.dispatch(modelId, okmdName, messages, options, progress, apiKey, token);
  }

  // The model id is now a string (per upstream), but the dispatch
  // helper in the private section below still passes it through
  // unchanged to the request body. No type cast needed; the request
  // body accepts `unknown`.

  provideTokenCount(
    _model: LanguageModelChatInformation,
    text: string | LanguageModelChatRequestMessage,
    token: vscode.CancellationToken,
  ): Thenable<number> {
    // v1 token-counting strategy: chars/4 heuristic.
    //
    // `Math.ceil(text.length / 4)` for plain text, summed across
    // `LanguageModelTextPart`s for a `LanguageModelChatRequestMessage`.
    // Non-text parts (image, tool call, tool result) are skipped —
    // the heuristic has no way to count them, and silently inflating
    // the number would be worse than ignoring them.
    //
    // Limitations: ~30% off on non-English text and on code, and
    // 0 for any image-only or tool-only message. Documented in
    // spec 0001 §Token counting. This is intentionally
    // cheap-to-compute and easy to swap out: a future v2 can replace
    // this body with a `/tokenize` probe or a `usage.prompt_tokens`
    // lookup without changing the function signature.
    return new Promise<number>((resolve, reject) => {
      if (token.isCancellationRequested) {
        reject(new Error('cancelled'));
        return;
      }
      resolve(countTokens(text));
    });
  }

  private async toChatInformation(
    m: OkmdModel,
    apiKey?: string,
  ): Promise<LanguageModelChatInformation> {
    const caps = getCapabilities(m.name);
    // The `apiKey`, `detail`, `tooltip`, and `isUserSelectable: true`
    // fields mirror the NVIDIA NIM Provider pattern. The public
    // TypeScript type for `LanguageModelChatInformation` does not
    // declare them in 1.104, so we cast through `unknown` to
    // inject them at runtime. VS Code reads them from the
    // returned object even though TypeScript can't see them.
    //
    // The `apiKey` argument is resolved by the caller (the BYOK
    // discriminator in `provideLanguageModelChatInformation`)
    // so we never need to read secret storage here. This keeps
    // the model-info path synchronous in `Promise.all` and
    // avoids the N-times secret-storage round trip the previous
    // implementation had.
    return {
      id: `${PROVIDER_ID}/${m.name}`,
      name: `${m.name} (${PROVIDER_VENDOR})`,
      detail: PROVIDER_NAME,
      tooltip: `${PROVIDER_NAME} ${m.name}`,
      family: PROVIDER_NAME,
      version: '1',
      maxInputTokens: 128_000,
      maxOutputTokens: 8_192,
      capabilities: caps.toolCalling
        ? { toolCalling: true, imageInput: false }
        : { toolCalling: false, imageInput: false },
      isUserSelectable: true,
      ...(apiKey ? { apiKey } : {}),
    } as unknown as LanguageModelChatInformation;
  }

  private async dispatch(
    modelId: string,
    modelName: string,
    messages: readonly LanguageModelChatRequestMessage[],
    _options: ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    apiKey: string,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const caps = getCapabilities(modelName);
    logInfo(`Dispatching to ${caps.endpoint} for model ${modelName}`);

    // Per microsoft/vscode#296786, the picker is gated on
    // `capabilities.toolCalling === true`. The OKMD gateway
    // forwards tool calls to the underlying model for every
    // name we expose, so we advertise all models as tool-capable
    // in `getCapabilities`. If a future model genuinely does
    // not support tools, the upstream will return a 4xx which
    // `mapHttpError` surfaces to the chat UI.
    const hasTools = messages.some((m) =>
      m.content.some((p) => p instanceof vscode.LanguageModelToolCallPart),
    );
    if (hasTools) {
      logInfo(`[dispatch] model=${modelName} received tool call(s); relying on OKMD gateway forwarding`);
    }

    if (caps.endpoint === 'anthropic') {
      const body = openaiToAnthropic(modelId, messages);
      await this.streamAnthropic(body, progress, apiKey, token);
    } else {
      const body = {
        model: modelId,
        messages: messages.map((m) => ({
          role: messageRole(m),
          content: m.content
            .map((p) => (p instanceof vscode.LanguageModelTextPart ? p.value : ''))
            .join(''),
        })),
        stream: true,
      };
      await this.streamOpenAI(body, progress, apiKey, token);
    }
  }

  private async streamOpenAI(
    body: unknown,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    apiKey: string,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const signal = cancellationTokenToAbortSignal(token);
    const res = await postOkmd({
      endpoint: 'openai',
      apiKey,
      body,
      signal,
    });
    await this.streamResponse('openai', res, progress, signal);
  }

  private async streamAnthropic(
    body: unknown,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    apiKey: string,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const signal = cancellationTokenToAbortSignal(token);
    const res = await postOkmd({
      endpoint: 'anthropic',
      apiKey,
      body,
      signal,
    });
    await this.streamResponse('anthropic', res, progress, signal);
  }

  /**
   * Stream an OKMD response into the parser. On a non-2xx status
   * the body is buffered into text so `mapHttpError` can inspect
   * it; on a 2xx the body is consumed lazily by the parser, so
   * the user sees text as it arrives. The two paths are
   * deliberately split at the seam where `postOkmd` returns
   * `{ status, bodyStream }` (see issue #8) so that a single
   * dispatch function can serve both endpoints.
   */
  private async streamResponse(
    endpoint: 'openai' | 'anthropic',
    res: { status: number; bodyStream: ReadableStream<Uint8Array> },
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    signal: AbortSignal,
  ): Promise<void> {
    if (res.status >= 400) {
      // On the error path we need the body as text so
      // `mapHttpError` can inspect it for keywords (e.g. "Invalid
      // API key"). This is the only place we buffer; the happy
      // path streams straight to the parser.
      const bodyText = await readStreamToText(res.bodyStream);
      throw mapHttpError(res.status, bodyText, endpoint);
    }
    const source =
      endpoint === 'anthropic'
        ? parseAnthropicStream(res.bodyStream, signal)
        : parseOpenAiStream(res.bodyStream, signal);
    for await (const part of source) {
      progress.report(part);
    }
  }
}

function messageRole(m: vscode.LanguageModelChatRequestMessage): 'user' | 'assistant' {
  if (m.role === vscode.LanguageModelChatMessageRole.Assistant) {
    return 'assistant';
  }
  return 'user';
}

/**
 * Drain a `ReadableStream<Uint8Array>` into a UTF-8 string. Used
 * only on the error path in `streamResponse` so that
 * `mapHttpError` can read the body text. The happy path never
 * calls this — it streams the body straight to the parser.
 */
async function readStreamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Approximate token count for the v1 chars/4 heuristic.
 *
 * Plain strings are measured as `Math.ceil(length / 4)`. A
 * `LanguageModelChatRequestMessage` is the sum of its text parts,
 * skipping every non-text part (images, tool calls, tool results).
 */
function countTokens(
  text: string | vscode.LanguageModelChatRequestMessage,
): number {
  if (typeof text === 'string') {
    return Math.ceil(text.length / 4);
  }
  let total = 0;
  for (const part of text.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      total += Math.ceil(part.value.length / 4);
    }
  }
  return total;
}
