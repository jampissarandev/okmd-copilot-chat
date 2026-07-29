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
import { OkmdHttpError, postOkmd } from './okmdClient';
import { parseOpenAiStream } from './streaming/openaiParser';
import { parseAnthropicStream } from './streaming/anthropicParser';
import { logInfo } from './logger';
import { mapHttpError } from './errorMapping';

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
      await this.cache.refresh(this.fetchModelsFromApi.bind(this));
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
      await this.cache.refresh(this.fetchModelsFromApi.bind(this));
      modelId = this.cache.getIdByName(okmdName);
      if (modelId === undefined) {
        throw vscode.LanguageModelError.NotFound(`OKMD model ${okmdName} not found`);
      }
    }
    await this.dispatch(modelId, okmdName, messages, options, progress, apiKey, token);
  }

  async provideTokenCount(
    _model: LanguageModelChatInformation,
    _text: string | LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    // Rough heuristic: 1 token ≈ 4 characters for English text.
    if (typeof _text === 'string') {
      return Math.ceil(_text.length / 4);
    }
    // For request messages, sum up text parts.
    let total = 0;
    for (const part of _text.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        total += Math.ceil(part.value.length / 4);
      }
    }
    return total;
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
    if (res.status >= 400) {
      throw mapHttpError(res.status, res.bodyText, 'openai');
    }
    if (!res.bodyText) {
      throw new Error('OKMD /chat/completions returned no body');
    }
    const stream = makeStreamFromString(res.bodyText);
    for await (const part of parseOpenAiStream(stream, signal)) {
      progress.report(part);
    }
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
    if (res.status >= 400) {
      throw mapHttpError(res.status, res.bodyText, 'anthropic');
    }
    if (!res.bodyText) {
      throw new Error('OKMD /messages returned no body');
    }
    const stream = makeStreamFromString(res.bodyText);
    for await (const part of parseAnthropicStream(stream, signal)) {
      progress.report(part);
    }
  }

  private async fetchModelsFromApi(): Promise<OkmdModel[]> {
    const apiKey = await this.context.secrets.get('okmd.apiKey');
    if (!apiKey) {
      throw new Error('API key not configured');
    }
    const { OKMD_API_BASE_URL: base } = await import('./constants.js');
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      throw new OkmdHttpError(res.status, await res.text(), `GET /models failed: ${res.status}`);
    }
    const data = (await res.json()) as { data: OkmdModel[] };
    return data.data;
  }
}

function messageRole(m: vscode.LanguageModelChatRequestMessage): 'user' | 'assistant' {
  if (m.role === vscode.LanguageModelChatMessageRole.Assistant) {
    return 'assistant';
  }
  return 'user';
}

/**
 * Convert a VS Code CancellationToken to a standard AbortSignal.
 */
function cancellationTokenToAbortSignal(token: vscode.CancellationToken): AbortSignal {
  const controller = new AbortController();
  if (token.isCancellationRequested) {
    controller.abort();
  }
  token.onCancellationRequested(() => controller.abort());
  return controller.signal;
}

function makeStreamFromString(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}
