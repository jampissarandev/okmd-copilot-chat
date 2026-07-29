/**
 * Unit tests for `parseAnthropicStream` in
 * `src/streaming/anthropicParser.ts`.
 *
 * Per spec 0001 §Testing Decisions: feed a fake
 * `ReadableStream<Uint8Array>` of Anthropic-shaped SSE bytes,
 * assert the `LanguageModelTextPart` and
 * `LanguageModelToolCallPart` sequence.
 *
 * The tests cover the happy path (text deltas + tool-use
 * accumulation), the malformed-JSON failure path, and the
 * cancellation contract (issue #16 / spec 0001 Story 10).
 */

jest.mock('vscode');

import { LanguageModelTextPart, LanguageModelToolCallPart } from 'vscode';
import { parseAnthropicStream } from '../../src/streaming/anthropicParser';
import { makeStream, collect } from './helpers';

const notAborted = new AbortController().signal;

describe('parseAnthropicStream', () => {
  test('a content_block_delta with text_delta emits a text part', async () => {
    const sse = [
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    const parts = await collect(parseAnthropicStream(makeStream(sse), notAborted));
    expect(parts).toHaveLength(1);
    expect(parts[0]).toBeInstanceOf(LanguageModelTextPart);
    expect((parts[0] as LanguageModelTextPart).value).toBe('hi');
  });

  test('content_block_start with type=tool_use + input_json_deltas → tool_call at message_stop', async () => {
    // The two partial_json values concatenate to `{"city":
    // "Bangkok"}`. Use JSON.stringify on the data line to get the
    // escaping right.
    const sse = [
      'event: content_block_start',
      'data: ' +
        JSON.stringify({
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'tu_1', name: 'get_weather' },
        }),
      '',
      'event: content_block_delta',
      'data: ' +
        JSON.stringify({
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"city":' },
        }),
      '',
      'event: content_block_delta',
      'data: ' +
        JSON.stringify({
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: ' "Bangkok"}' },
        }),
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      // Trailing blank line so the final event is `\n\n`-terminated,
      // matching how real Anthropic streams end.
      '',
    ].join('\n');
    const parts = await collect(parseAnthropicStream(makeStream(sse), notAborted));
    expect(parts).toHaveLength(1);
    const tu = parts[0] as LanguageModelToolCallPart;
    expect(tu).toBeInstanceOf(LanguageModelToolCallPart);
    expect(tu.callId).toBe('tu_1');
    expect(tu.name).toBe('get_weather');
    expect(tu.input).toEqual({ city: 'Bangkok' });
  });

  test('a `message_stop` event ends the generator', async () => {
    // The parser must return at message_stop, not wait for the
    // stream to close. We send a `message_stop` followed by more
    // events; only the events before `message_stop` should
    // produce parts.
    const sse = [
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"y"}}',
      '',
    ].join('\n');
    const parts = await collect(parseAnthropicStream(makeStream(sse), notAborted));
    expect(parts.map((p) => (p as LanguageModelTextPart).value)).toEqual(['x']);
  });

  test('skips tool-use parts whose input is malformed JSON', async () => {
    // The concatenated `partial_json` is `{"x":` — not a valid
    // JSON object. JSON.parse must throw and the parser must log
    // + skip.
    const sse = [
      'event: content_block_start',
      'data: ' +
        JSON.stringify({
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'tu_bad', name: 'bad_tool' },
        }),
      '',
      'event: content_block_delta',
      'data: ' +
        JSON.stringify({
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"x":' },
        }),
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      '',
    ].join('\n');
    const parts = await collect(parseAnthropicStream(makeStream(sse), notAborted));
    expect(parts).toHaveLength(0);
  });

  test('malformed JSON in a single SSE event is logged and skipped, not thrown', async () => {
    // The contract: malformed JSON in a non-tool-use event is
    // logged via `logWarn` and skipped. Subsequent valid events
    // still produce parts.
    const sse = [
      'event: content_block_delta',
      'data: not-json',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    const parts = await collect(parseAnthropicStream(makeStream(sse), notAborted));
    expect(parts.map((p) => (p as LanguageModelTextPart).value)).toEqual(['ok']);
  });

  test('already-aborted signal: the generator returns without yielding parts', async () => {
    const controller = new AbortController();
    controller.abort();
    const sse = 'event: content_block_delta\ndata: {"delta":{"text":"x"}}\n\n';
    const parts: LanguageModelTextPart[] = [];
    for await (const part of parseAnthropicStream(makeStream(sse), controller.signal)) {
      parts.push(part as LanguageModelTextPart);
    }
    expect(parts).toHaveLength(0);
  });

  test('cancellation between events: no further parts after abort', async () => {
    // Multi-chunk stream. We abort AFTER receiving the first text
    // part; the next event read must see `signal.aborted` and
    // return.
    const encoder = new TextEncoder();
    const controller = new AbortController();
    const sse1 = [
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"alpha"}}',
      '',
      '',
    ].join('\n');
    const sse2 = [
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"beta"}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      '',
    ].join('\n');
    let secondEnqueued = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (!secondEnqueued) {
          secondEnqueued = true;
          c.enqueue(encoder.encode(sse1));
        } else {
          c.enqueue(encoder.encode(sse2));
          c.close();
        }
      },
    });
    const gen = parseAnthropicStream(stream, controller.signal);
    const seen: string[] = [];
    for await (const part of gen) {
      seen.push((part as LanguageModelTextPart).value);
      controller.abort();
    }
    expect(seen).toEqual(['alpha']);
  });
});
