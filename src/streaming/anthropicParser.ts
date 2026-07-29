/**
 * Parse Anthropic-style SSE chunks from /messages and yield
 * LanguageModelResponsePart2.
 *
 * Anthropic SSE events:
 *   event: message_start     → { message: { ... } }
 *   event: content_block_start → { index, content_block: { type: "text" | "tool_use", ... } }
 *   event: content_block_delta  → { index, delta: { type: "text_delta" | "input_json_delta", text } }
 *   event: content_block_stop
 *   event: message_delta
 *   event: message_stop
 */

import type * as vscode from 'vscode';
import { LanguageModelTextPart, LanguageModelToolCallPart } from 'vscode';
import { logWarn } from '../logger';

interface AnthropicEvent {
  type: string;
  index?: number;
  content_block?: {
    type: 'text' | 'tool_use';
    text?: string;
    id?: string;
    name?: string;
  };
  delta?: {
    type: 'text_delta' | 'input_json_delta';
    text?: string;
    partial_json?: string;
  };
}

export async function* parseAnthropicStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const toolUseAccumulator: Map<number, { id: string; name: string; input: string }> = new Map();

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

      // Anthropic SSE separates events with blank lines; each event has
      // `event:` and `data:` lines.
      let eventEnd: number;
      while ((eventEnd = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, eventEnd);
        buffer = buffer.slice(eventEnd + 2);
        const lines = raw.split('\n');
        let eventType = '';
        let dataLine = '';
        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            dataLine = line.slice(5).trim();
          }
        }
        if (!dataLine) {
          continue;
        }
        let evt: AnthropicEvent;
        try {
          evt = JSON.parse(dataLine);
        } catch (err) {
          logWarn('Failed to parse Anthropic SSE event', dataLine, err);
          continue;
        }

        if (eventType === 'content_block_start' && evt.content_block) {
          if (evt.content_block.type === 'tool_use' && evt.index !== undefined) {
            toolUseAccumulator.set(evt.index, {
              id: evt.content_block.id ?? '',
              name: evt.content_block.name ?? '',
              input: '',
            });
          }
        } else if (eventType === 'content_block_delta' && evt.delta) {
          if (evt.delta.type === 'text_delta' && evt.delta.text) {
            yield new LanguageModelTextPart(evt.delta.text);
          } else if (
            evt.delta.type === 'input_json_delta' &&
            evt.delta.partial_json &&
            evt.index !== undefined
          ) {
            const acc = toolUseAccumulator.get(evt.index);
            if (acc) {
              acc.input += evt.delta.partial_json;
            }
          }
        } else if (eventType === 'message_stop') {
          for (const tu of toolUseAccumulator.values()) {
            yield new LanguageModelToolCallPart(tu.id, tu.name, tu.input);
          }
          return;
        }
        // unused: eventType for context only
        void eventType;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
