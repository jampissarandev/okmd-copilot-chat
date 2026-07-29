/**
 * Unit tests for the cancellation adapter.
 *
 * Implements spec 0001 Story 10: "I want to cancel a long-running
 * response and have the network request stop, so that I do not burn
 * quota on a response I no longer need."
 *
 * The adapter is the bridge between VS Code's `CancellationToken`
 * (used by `vscode.lm`) and the web `AbortSignal` (used by `fetch`
 * and the SSE parsers). These tests cover:
 *
 *   1. The adapter itself — synchronous, deterministic behaviour.
 *   2. End-to-end abort through `okmdClient.postOkmd` — confirms
 *      that a cancelled token causes the `fetch` call to see an
 *      aborted signal.
 *   3. The short-circuit in `postOkmd` when the token is already
 *      cancelled at call time.
 *   4. The SSE parsers honour the abort signal and stop yielding
 *      parts.
 */

jest.mock('vscode');

import {
  cancellationTokenToAbortSignal,
} from '../src/utils/cancellation';
import { CancellationTokenSource } from 'vscode';
import { parseOpenAiStream } from '../src/streaming/openaiParser';
import { parseAnthropicStream } from '../src/streaming/anthropicParser';
import { postOkmd } from '../src/okmdClient';

function streamFromString(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

// --------------------------------------------------------------------------
// Adapter
// --------------------------------------------------------------------------

describe('cancellationTokenToAbortSignal', () => {
  test('returns a non-aborted signal when the token is not cancelled', () => {
    const src = new CancellationTokenSource();
    const signal = cancellationTokenToAbortSignal(src.token);
    expect(signal.aborted).toBe(false);
  });

  test('returns an already-aborted signal when the token is cancelled at call time', () => {
    const src = new CancellationTokenSource();
    src.cancel();
    const signal = cancellationTokenToAbortSignal(src.token);
    expect(signal.aborted).toBe(true);
  });

  test('signal aborts when the token fires after the call', () => {
    const src = new CancellationTokenSource();
    const signal = cancellationTokenToAbortSignal(src.token);
    expect(signal.aborted).toBe(false);
    src.cancel();
    expect(signal.aborted).toBe(true);
  });
});

// --------------------------------------------------------------------------
// okmdClient: end-to-end abort
// --------------------------------------------------------------------------

describe('postOkmd — cancellation (spec 0001 Story 10)', () => {
  // Replace `fetch` with a stub that captures the request and the
  // signal so we can assert that the abort propagates from the
  // CancellationToken to the underlying network call. The
  // `okmdClient` module reads `fetch` from the global at call time
  // (no module-level capture), so a plain `global.fetch` swap is
  // sufficient — no `jest.isolateModules` dance needed.
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
  });

  test('token already cancelled at call time: no fetch is made', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const src = new CancellationTokenSource();
    src.cancel();
    const signal = cancellationTokenToAbortSignal(src.token);
    await expect(
      postOkmd({
        endpoint: 'openai',
        apiKey: 'test',
        body: { test: true },
        signal,
      }),
    ).rejects.toThrow(/aborted/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('token fires mid-request: fetch sees an aborted signal', async () => {
    // Fetch mock that captures the request's signal and hangs until
    // the signal aborts. The test cancels the token, the signal
    // propagates to the inner AbortController via the parent's
    // abort listener, and the mocked `fetch` rejects with
    // "aborted".
    const fetchMock = jest.fn(
      (
        _url: string,
        init: { signal: AbortSignal | null } = { signal: null },
      ): Promise<Response> => {
        return new Promise((resolve, reject) => {
          const sig = init.signal;
          if (sig?.aborted) {
            reject(new Error('aborted'));
            return;
          }
          sig?.addEventListener('abort', () => reject(new Error('aborted')));
          // Never resolve on success; only the abort path returns.
        });
      },
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const src = new CancellationTokenSource();
    const signal = cancellationTokenToAbortSignal(src.token);
    const pending = postOkmd({
      endpoint: 'openai',
      apiKey: 'test',
      body: { test: true },
      signal,
    });
    // Let `postOkmd` start the request.
    await new Promise((r) => setImmediate(r));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Now cancel. The signal propagates to the inner AbortController
    // (which is what fetch sees) via the onParentAbort listener.
    src.cancel();
    await expect(pending).rejects.toThrow(/aborted/i);
  });
});

// --------------------------------------------------------------------------
// SSE parsers: stop iterating on abort
// --------------------------------------------------------------------------

describe('SSE parsers — stop iterating on abort (spec 0001 Story 10)', () => {
  test('OpenAI: no parts yielded after the signal aborts', async () => {
    const controller = new AbortController();
    const sse = [
      'data: {"choices":[{"delta":{"content":"first"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"second"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const gen = parseOpenAiStream(streamFromString(sse), controller.signal);
    const seen: string[] = [];
    for await (const part of gen) {
      // Cancel AFTER receiving the first part. The next read on the
      // stream must short-circuit, so no `second` arrives.
      if (seen.length === 0) {
        controller.abort();
      }
      if ('value' in (part as { value?: string })) {
        seen.push((part as { value: string }).value);
      }
    }
    // The first part was already buffered in the same chunk as
    // `second`, so the test is timing-sensitive: cancel between
    // chunks instead. This test asserts the simpler contract —
    // *no further progress after cancel* — and the parser is
    // expected to bail at the next read.
    expect(seen).toEqual(['first']);
  });

  test('Anthropic: no parts yielded after the signal aborts', async () => {
    const controller = new AbortController();
    const sse = [
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"alpha"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"beta"}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    const gen = parseAnthropicStream(streamFromString(sse), controller.signal);
    const seen: string[] = [];
    for await (const part of gen) {
      controller.abort();
      if ('value' in (part as { value?: string })) {
        seen.push((part as { value: string }).value);
      }
    }
    // The whole payload is in one chunk, so the parser may yield the
    // buffered text-delta before the next read sees the abort. The
    // contract we assert here is: at most one text part is emitted
    // after the cancel (the one that was already in the buffer when
    // we cancelled). `beta` must NOT appear.
    expect(seen).not.toContain('beta');
  });
});
