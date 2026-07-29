/**
 * Unit tests for `parseOpenAiStream` in
 * `src/streaming/openaiParser.ts`.
 *
 * Per spec 0001 §Testing Decisions: feed a fake
 * `ReadableStream<Uint8Array>` of SSE bytes, assert the
 * `LanguageModelTextPart` and `LanguageModelToolCallPart` sequence.
 *
 * The tests cover the happy path (text + tool calls emit
 * correctly), the malformed-JSON failure path, and the
 * cancellation contract (issue #16 / spec 0001 Story 10).
 */

jest.mock('vscode');

import { LanguageModelTextPart, LanguageModelToolCallPart } from 'vscode';
import { parseOpenAiStream } from '../../src/streaming/openaiParser';
import { makeStream, collect, type AnyPart } from './helpers';

const notAborted = new AbortController().signal;

describe('parseOpenAiStream', () => {
  test('a single chunk with delta.content emits one text part', async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n';
    const parts = await collect(parseOpenAiStream(makeStream(sse), notAborted));
    expect(parts).toHaveLength(1);
    expect(parts[0]).toBeInstanceOf(LanguageModelTextPart);
    expect((parts[0] as LanguageModelTextPart).value).toBe('hello');
  });

  test('multiple text chunks emit text parts in order', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"hello "}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"world"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const parts = await collect(parseOpenAiStream(makeStream(sse), notAborted));
    expect(parts).toHaveLength(2);
    expect(parts.map((p) => (p as LanguageModelTextPart).value)).toEqual(['hello ', 'world']);
  });

  test('a `data: [DONE]` line ends the generator', async () => {
    // After [DONE], the parser must return — even if the upstream
    // sent more lines after it. We use a [DONE] followed by a
    // non-terminating line: the parser should not yield the trailing
    // text. (In practice, the upstream closes the stream after
    // [DONE]; this test pins the parser's behaviour, not the
    // upstream's.)
    const sse = [
      'data: {"choices":[{"delta":{"content":"x"}}]}',
      '',
      'data: [DONE]',
      '',
      'data: {"choices":[{"delta":{"content":"y"}}]}',
      '',
    ].join('\n');
    const parts = await collect(parseOpenAiStream(makeStream(sse), notAborted));
    expect(parts.map((p) => (p as LanguageModelTextPart).value)).toEqual(['x']);
  });

  test('tool-call chunks are accumulated and emitted as a single part on [DONE]', async () => {
    // The two chunks together concatenate to `{"city": "Bangkok"}` —
    // a valid JSON object. JSON.stringify on the data-line string
    // gives us the correct escaping (escapes inside the `arguments`
    // value).
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
                tool_calls: [{ index: 0, function: { arguments: ' "Bangkok"}' } }],
              },
            },
          ],
        }),
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const parts = await collect(parseOpenAiStream(makeStream(sse), notAborted));
    expect(parts).toHaveLength(1);
    const tc = parts[0] as LanguageModelToolCallPart;
    expect(tc).toBeInstanceOf(LanguageModelToolCallPart);
    expect(tc.callId).toBe('call_1');
    expect(tc.name).toBe('get_weather');
    expect(tc.input).toEqual({ city: 'Bangkok' });
  });

  test('skips tool-call parts whose arguments are malformed JSON', async () => {
    // The concatenated `arguments` is not a valid JSON object —
    // it's a partial object with a trailing colon. JSON.parse must
    // throw and the parser must log + skip rather than emit a `{}`
    // placeholder.
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
    const parts = await collect(parseOpenAiStream(makeStream(sse), notAborted));
    expect(parts).toHaveLength(0);
  });

  test('malformed JSON in a non-tool-call chunk is logged and skipped, not thrown', async () => {
    // Pin the contract from issue #12: malformed JSON in the SSE
    // payload is logged via `logWarn` and skipped, not rethrown.
    // The subsequent valid chunk still produces a text part. The
    // assertion below checks that the parser does not throw and
    // the rest of the stream is processed.
    const sse = [
      'data: not-json',
      '',
      'data: {"choices":[{"delta":{"content":"ok"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const parts = await collect(parseOpenAiStream(makeStream(sse), notAborted));
    expect(parts.map((p) => (p as LanguageModelTextPart).value)).toEqual(['ok']);
  });

  test('already-aborted signal: the generator returns without yielding parts', async () => {
    // The pre-aborted short-circuit in the parser: the first
    // iteration of the outer `while` loop sees `signal.aborted`
    // and returns immediately.
    const controller = new AbortController();
    controller.abort();
    const sse = 'data: {"choices":[{"delta":{"content":"never emitted"}}]}\n\n';
    const parts: AnyPart[] = [];
    for await (const part of parseOpenAiStream(makeStream(sse), controller.signal)) {
      parts.push(part as AnyPart);
    }
    expect(parts).toHaveLength(0);
  });

  test('cancellation between chunks: no parts after the abort', async () => {
    // Multi-chunk stream. We abort AFTER receiving the first part;
    // the next `read()` must see `signal.aborted` and return.
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

  test('cancellation inside a single chunk: no further parts after abort', async () => {
    // The whole SSE is in one chunk. The contract is: as soon as
    // the signal is observed (the inner-loop `if (signal.aborted)`
    // check), the parser must not yield more parts.
    const controller = new AbortController();
    const sse = [
      'data: {"choices":[{"delta":{"content":"alpha"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"beta"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const gen = parseOpenAiStream(makeStream(sse), controller.signal);
    const seen: string[] = [];
    let aborted = false;
    for await (const part of gen) {
      seen.push((part as LanguageModelTextPart).value);
      if (!aborted) {
        aborted = true;
        controller.abort();
      }
    }
    // The first part is yielded (we are in the inner loop
    // already). The inner-loop abort check on the next choice must
    // prevent `beta` from being emitted.
    expect(seen).toEqual(['alpha']);
  });
});
