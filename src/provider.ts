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
import { PROVIDER_ID, PROVIDER_NAME, PROVIDER_VENDOR } from './constants';
import { getCapabilities } from './capabilities';
import { openaiToAnthropic } from './converters/openaiToAnthropic';
import { ModelCache, OkmdModel } from './modelCache';
import { postOkmd } from './okmdClient';
import { parseOpenAiStream } from './streaming/openaiParser';
import { parseAnthropicStream } from './streaming/anthropicParser';
import { logInfo } from './logger';
import { mapHttpError } from './errorMapping';
import { cancellationTokenToAbortSignal } from './utils/cancellation';

export class OkmdChatProvider implements LanguageModelChatProvider {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly cache: ModelCache,
  ) {}

  async provideLanguageModelChatInformation(
    _options: { readonly silent: boolean },
    _token: vscode.CancellationToken,
  ): Promise<LanguageModelChatInformation[]> {
    if (this.cache.getModels().length === 0) {
      await this.cache.refresh();
    }
    return this.cache.getModels().map((m) => this.toChatInformation(m));
  }

  async provideLanguageModelChatResponse(
    model: LanguageModelChatInformation,
    messages: readonly LanguageModelChatRequestMessage[],
    options: ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const apiKey = await this.context.secrets.get('okmd.apiKey');
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

  provideTokenCount(
    _model: LanguageModelChatInformation,
    _text: string | LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Thenable<number> {
    // v1 does not implement a real token count. The 1.104 contract
    // requires *some* `Thenable<number>`; we throw so that Copilot
    // Chat (and any future client UI that reads this number) gets a
    // loud signal that the value is unavailable, rather than a
    // silently-wrong number from a chars/4 heuristic. Per spec 0001
    // §Token counting this function **must remain a stub** until
    // issue #18 lands; any patch that silently swaps in a heuristic
    // without updating the spec is a bug.
    throw new Error('OKMD token counting is not implemented in v1');
  }

  private toChatInformation(m: OkmdModel): LanguageModelChatInformation {
    const caps = getCapabilities(m.name);
    return {
      id: `${PROVIDER_ID}/${m.name}`,
      name: `${m.name} (${PROVIDER_VENDOR})`,
      family: PROVIDER_NAME,
      version: '1',
      maxInputTokens: 128_000,
      maxOutputTokens: 8_192,
      capabilities: caps.toolCalling
        ? { toolCalling: true, imageInput: false }
        : { toolCalling: false, imageInput: false },
      // isDefault handled by the picker
    };
  }

  private async dispatch(
    modelId: number,
    modelName: string,
    messages: readonly LanguageModelChatRequestMessage[],
    _options: ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    apiKey: string,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const caps = getCapabilities(modelName);
    logInfo(`Dispatching to ${caps.endpoint} for model ${modelName}`);

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
