/**
 * Parse OpenAI-compatible SSE chunks from /chat/completions and yield
 * LanguageModelResponsePart2 (text or tool_call).
 *
 * Per decision 8: text is streamed chunk-by-chunk; tool calls are parsed
 * in non-streaming style — when a chunk contains tool_calls, we close
 * the text stream and emit a tool call part.
 */

import type * as vscode from 'vscode';
import { LanguageModelTextPart, LanguageModelToolCallPart } from 'vscode';
import { logWarn } from '../logger';
import { parseJsonSafe } from '../utils/json';

interface OpenAiChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
}

export async function* parseOpenAiStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const toolCallAccumulator: Map<number, { id: string; name: string; arguments: string }> = new Map();

  try {
    while (true) {
      if (signal.aborted) {
        return;
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, sep).trim();
        buffer = buffer.slice(sep + 1);
        if (!line.startsWith('data:')) {
          continue;
        }
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          // Flush any accumulated tool calls as a single part.
          if (toolCallAccumulator.size > 0) {
            for (const tc of toolCallAccumulator.values()) {
              yield new LanguageModelToolCallPart(tc.id, tc.name, parseJsonSafe(tc.arguments));
            }
          }
          return;
        }
        let chunk: OpenAiChunk;
        try {
          chunk = JSON.parse(data);
        } catch (err) {
          logWarn('Failed to parse OpenAI SSE chunk', data, err);
          continue;
        }
        for (const choice of chunk.choices ?? []) {
          const delta = choice.delta;
          if (!delta) {
            continue;
          }
          if (delta.content) {
            yield new LanguageModelTextPart(delta.content);
          }
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const acc = toolCallAccumulator.get(tc.index) ?? {
                id: '',
                name: '',
                arguments: '',
              };
              if (tc.id) {
                acc.id = tc.id;
              }
              if (tc.function?.name) {
                acc.name = tc.function.name;
              }
              if (tc.function?.arguments) {
                acc.arguments += tc.function.arguments;
              }
              toolCallAccumulator.set(tc.index, acc);
            }
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
