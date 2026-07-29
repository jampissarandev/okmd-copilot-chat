/**
 * Unit tests for the SSE stream parsers in `src/streaming/`.
 *
 * Per spec 0001 §Testing Decisions: feed a fake
 * `ReadableStream<Uint8Array>` of SSE bytes, assert the
 * `LanguageModelTextPart` and `LanguageModelToolCallPart` sequence.
 *
 * The tests cover both the happy path (text + tool calls emit
 * correctly) and the malformed-JSON failure path (issue #12 AC:
 * "Unit tests for both parsers cover the failure case: malformed JSON
 * in the tool-call payload.").
 */

jest.mock('vscode');

import { parseOpenAiStream } from '../src/streaming/openaiParser';
import { parseAnthropicStream } from '../src/streaming/anthropicParser';

/**
 * Build a `ReadableStream<Uint8Array>` from a string. The parsers
 * accept this directly; the production code uses
 * `makeStreamFromString` for the same purpose.
 */
function streamFromString(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

// An AbortSignal that is never aborted. Used by happy-path tests.
const notAborted = new AbortController().signal;

type AnyPart = { value?: string; callId?: string; name?: string; input?: object };

async function collect(gen: AsyncGenerator<unknown>): Promise<AnyPart[]> {
  const out: AnyPart[] = [];
  for await (const part of gen) {
    out.push(part as AnyPart);
  }
  return out;
}

// --------------------------------------------------------------------------
// OpenAI parser
// --------------------------------------------------------------------------

describe('parseOpenAiStream', () => {
  test('emits text parts in order', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"hello "}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"world"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const parts = await collect(parseOpenAiStream(streamFromString(sse), notAborted));
    expect(parts.map((p) => p.value)).toEqual(['hello ', 'world']);
  });

  test('emits a single tool-call part with parsed arguments at [DONE]', async () => {
    // The two chunks together concatenate to `{"city": "Bangkok"}` — a
    // valid JSON object. JSON.stringify on the data-line string gives
    // us the correct escaping (escapes inside the `arguments` value).
    const sse = [
      'data: ' +
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    function: { name: 'get_weather', arguments: '{"city":' },
                  },
                ],
              },
            },
          ],
        }),
      '',
      'data: ' +
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: ' "Bangkok"}' } },
                ],
              },
            },
          ],
        }),
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const parts = await collect(parseOpenAiStream(streamFromString(sse), notAborted));
    expect(parts).toHaveLength(1);
    expect(parts[0].callId).toBe('call_1');
    expect(parts[0].name).toBe('get_weather');
    expect(parts[0].input).toEqual({ city: 'Bangkok' });
  });

  test('skips tool-call parts whose arguments are malformed JSON', async () => {
    // The concatenated `arguments` is not a valid JSON object — it's a
    // partial object with a trailing colon. JSON.parse must throw and
    // the parser must log + skip rather than emit a `{}` placeholder.
    const sse = [
      'data: ' +
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'bad',
                    function: { name: 'bad_tool', arguments: '{"x":' },
                  },
                ],
              },
            },
          ],
        }),
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const parts = await collect(parseOpenAiStream(streamFromString(sse), notAborted));
    expect(parts).toHaveLength(0);
  });

  test('skips individual malformed SSE chunks but keeps the rest', async () => {
    const sse = [
      'data: not-json',
      '',
      'data: {"choices":[{"delta":{"content":"ok"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const parts = await collect(parseOpenAiStream(streamFromString(sse), notAborted));
    expect(parts.map((p) => p.value)).toEqual(['ok']);
  });

  test('stops iterating when the signal aborts between chunks', async () => {
    // Build a multi-chunk stream. Each `read()` returns one chunk
    // and the parser yields its text. We abort AFTER receiving the
    // first part — the next `read()` must see `signal.aborted` and
    // return without yielding the second chunk's content.
    const encoder = new TextEncoder();
    const controller = new AbortController();
    const sse1 = 'data: {"choices":[{"delta":{"content":"first"}}]}\n\n';
    const sse2 = 'data: {"choices":[{"delta":{"content":"second"}}]}\n\ndata: [DONE]\n\n';
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
    const gen = parseOpenAiStream(stream, controller.signal);
    const parts: AnyPart[] = [];
    for await (const part of gen) {
      parts.push(part as AnyPart);
      controller.abort();
    }
    expect(parts.map((p) => p.value)).toEqual(['first']);
  });

  test('stops iterating when the signal aborts inside a single chunk', async () => {
    // The whole SSE is in one chunk. Without an inner-loop
    // `signal.aborted` check, the parser would process every line
    // in the chunk before returning. The contract is: as soon as the
    // signal is observed, the parser must not yield more parts. We
    // abort on the first `for await` iteration, then expect no more
    // parts to arrive.
    const controller = new AbortController();
    const sse = [
      'data: {"choices":[{"delta":{"content":"alpha"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"beta"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const gen = parseOpenAiStream(streamFromString(sse), controller.signal);
    const seen: string[] = [];
    let aborted = false;
    for await (const part of gen) {
      seen.push((part as { value: string }).value);
      if (!aborted) {
        aborted = true;
        controller.abort();
      }
    }
    // The first part is yielded (we are in the inner loop already).
    // The inner-loop abort check on the next choice must prevent
    // `beta` from being emitted.
    expect(seen).toEqual(['alpha']);
  });
});

// --------------------------------------------------------------------------
// Anthropic parser
// --------------------------------------------------------------------------

describe('parseAnthropicStream', () => {
  test('emits text deltas', async () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start"}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi "}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"there"}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    const parts = await collect(parseAnthropicStream(streamFromString(sse), notAborted));
    expect(parts.map((p) => p.value)).toEqual(['hi ', 'there']);
  });

  test('emits a tool-use part with parsed input at message_stop', async () => {
    // The two partial_json values concatenate to `{"city": "Bangkok"}`.
    // Use JSON.stringify on the data line to get the escaping right.
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
    const parts = await collect(parseAnthropicStream(streamFromString(sse), notAborted));
    expect(parts).toHaveLength(1);
    expect(parts[0].callId).toBe('tu_1');
    expect(parts[0].name).toBe('get_weather');
    expect(parts[0].input).toEqual({ city: 'Bangkok' });
  });

  test('skips tool-use parts whose input is malformed JSON', async () => {
    // The concatenated `partial_json` is `{"x":` — not a valid JSON
    // object. JSON.parse must throw and the parser must log + skip.
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
    const parts = await collect(parseAnthropicStream(streamFromString(sse), notAborted));
    expect(parts).toHaveLength(0);
  });

  test('skips individual malformed SSE events but keeps the rest', async () => {
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
    const parts = await collect(parseAnthropicStream(streamFromString(sse), notAborted));
    expect(parts.map((p) => p.value)).toEqual(['ok']);
  });
});
