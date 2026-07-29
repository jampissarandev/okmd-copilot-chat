/**
 * Unit tests for the HTTP client in `src/okmdClient.ts`.
 *
 * The function under test (`postOkmd`) is the only seam at the
 * HTTP boundary: it builds the request URL, sets the auth headers,
 * enforces a 60-second timeout, and retries once on a 5xx or
 * network error. Per spec 0001 §Testing Decisions, these tests are
 * black-box — they assert on what is passed to `fetch` (URL,
 * headers, body) and on the externally observable behaviour
 * (retry count, returned response). They do not assert on
 * private state.
 *
 * Strategy: replace `globalThis.fetch` with a `jest.fn()` that
 * records each call. The `okmdClient` module reads `fetch` at call
 * time (no module-level capture), so a plain `global.fetch = ...`
 * swap is sufficient — no `jest.isolateModules` dance needed.
 *
 * Timing: the production `RETRY_DELAY_MS` is 1000ms. To keep the
 * test suite fast, we mock the `constants` module and set
 * `RETRY_DELAY_MS` to 0. The 60-second `REQUEST_TIMEOUT_MS` is
 * unchanged; we test the timeout by giving `fetch` a signal that
 * is already aborted (the 60s path is an implementation detail of
 * the inner `AbortController` and is covered by the cancellation
 * tests in `tests/cancellation.test.ts`).
 *
 * Streaming: the return shape is `{ status, bodyStream }` since
 * issue #8. The mock responses build a real
 * `ReadableStream<Uint8Array>` from a string so the tests can
 * assert on `bodyStream` being a stream (and not a buffered
 * string). The integration tests that exercise partial-data
 * streaming live in `tests/streaming.test.ts`.
 */

jest.mock('vscode');
// Override the retry back-off to 0 so the retry-on-network-error
// test completes in a few milliseconds instead of one second.
jest.mock('../src/constants', () => {
  const actual = jest.requireActual('../src/constants');
  return {
    ...actual,
    RETRY_DELAY_MS: 0,
  };
});

import { postOkmd } from '../src/okmdClient';

const realFetch = global.fetch;
const notAborted = new AbortController().signal;

/**
 * Build a `Response`-like object with a real `ReadableStream<Uint8Array>`
 * body. The body is enqueued in a single chunk and the stream is closed —
 * tests for partial-data streaming live in `tests/streaming.test.ts`.
 *
 * We deliberately do NOT provide a `text()` method on the stub. The
 * production code must not call `res.text()` on the streaming path
 * (issue #8). If it does, the test will throw a clear error.
 */
function makeResponse(status: number, bodyText: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(bodyText));
      controller.close();
    },
  });
  return {
    status,
    body: stream,
  } as unknown as Response;
}

afterEach(() => {
  global.fetch = realFetch;
});

// --------------------------------------------------------------------------
// URL and headers
// --------------------------------------------------------------------------

describe('postOkmd — URL and headers', () => {
  test('OpenAI endpoint: POST to /chat/completions with Bearer auth', async () => {
    const fetchMock = jest.fn().mockResolvedValue(makeResponse(200, '{"ok":1}'));
    global.fetch = fetchMock as unknown as typeof fetch;

    const body = { model: 1, messages: [] };
    const res = await postOkmd({
      endpoint: 'openai',
      apiKey: 'sk-abc',
      body,
      signal: notAborted,
    });

    expect(res.status).toBe(200);
    expect(res.bodyStream).toBeInstanceOf(ReadableStream);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gen.ai.kku.ac.th/okmd/api/v1/chat/completions');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-abc');
    expect(headers['x-api-key']).toBeUndefined();
    expect(headers['anthropic-version']).toBeUndefined();
    expect(headers['Content-Type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify(body));
  });

  test('Anthropic endpoint: POST to /messages with x-api-key and anthropic-version', async () => {
    const fetchMock = jest.fn().mockResolvedValue(makeResponse(200, '{"ok":1}'));
    global.fetch = fetchMock as unknown as typeof fetch;

    const body = { model: 1, messages: [] };
    const res = await postOkmd({
      endpoint: 'anthropic',
      apiKey: 'sk-ant-xyz',
      body,
      signal: notAborted,
    });

    expect(res.status).toBe(200);
    expect(res.bodyStream).toBeInstanceOf(ReadableStream);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gen.ai.kku.ac.th/okmd/api/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-xyz');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['Authorization']).toBeUndefined();
  });
});

// --------------------------------------------------------------------------
// Response handling
// --------------------------------------------------------------------------

describe('postOkmd — response handling', () => {
  test('a 200 response returns { status, bodyStream }', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(makeResponse(200, '{"choices":[{"message":{"content":"hi"}}]}'));
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await postOkmd({
      endpoint: 'openai',
      apiKey: 'k',
      body: {},
      signal: notAborted,
    });
    expect(res.status).toBe(200);
    expect(res.bodyStream).toBeInstanceOf(ReadableStream);
    // Drain the stream so the test does not leak an open reader.
    await res.bodyStream.cancel();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// --------------------------------------------------------------------------
// Retry behaviour
// --------------------------------------------------------------------------

describe('postOkmd — retry behaviour', () => {
  test('4xx response is NOT retried and returned as-is', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(makeResponse(400, 'bad request'))
      .mockResolvedValueOnce(makeResponse(401, 'invalid api key'))
      .mockResolvedValueOnce(makeResponse(404, 'not found'));
    global.fetch = fetchMock as unknown as typeof fetch;

    for (const status of [400, 401, 404]) {
      const res = await postOkmd({
        endpoint: 'openai',
        apiKey: 'k',
        body: {},
        signal: notAborted,
      });
      expect(res.status).toBe(status);
      // Drain the stream so the test does not leak an open reader.
      await res.bodyStream.cancel();
    }
    // Each call hits fetch exactly once. The 400, 401, and 404
    // results are pre-loaded in `mockResolvedValueOnce` order; we
    // only ever pull the first of each set.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test('5xx response triggers exactly one retry; second 5xx is returned to the caller', async () => {
    // Per spec 0001 §Request lifecycle: "retries once on 5xx or
    // network error with a 1-second back-off". The first 5xx
    // triggers the retry; if the retry also returns 5xx, the
    // caller sees the second 5xx (not a thrown error) so that
    // `provider.ts`'s `mapHttpError` mapping is preserved.
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(makeResponse(500, 'first server error'))
      .mockResolvedValueOnce(makeResponse(502, 'second bad gateway'));
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await postOkmd({
      endpoint: 'openai',
      apiKey: 'k',
      body: {},
      signal: notAborted,
    });
    expect(res.status).toBe(502);
    await res.bodyStream.cancel();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('5xx on the first attempt + success on retry returns the success response', async () => {
    // The first 5xx triggers a retry; the second attempt is
    // successful and the caller sees the 200.
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(makeResponse(500, 'transient'))
      .mockResolvedValueOnce(makeResponse(200, '{"ok":1}'));
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await postOkmd({
      endpoint: 'openai',
      apiKey: 'k',
      body: {},
      signal: notAborted,
    });
    expect(res.status).toBe(200);
    expect(res.bodyStream).toBeInstanceOf(ReadableStream);
    await res.bodyStream.cancel();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('network error on first attempt triggers exactly one retry; success on retry wins', async () => {
    // The implementation retries when `attempt()` throws (network
    // error, abort, JSON parse failure, etc.). A 5xx response is
    // *not* thrown — see the test above. So a "5xx retry" must
    // come from the *thrown* path, not the returned-5xx path. We
    // simulate a thrown network error on the first call and a
    // successful response on the second.
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(makeResponse(200, '{"ok":1}'));
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await postOkmd({
      endpoint: 'openai',
      apiKey: 'k',
      body: {},
      signal: notAborted,
    });
    expect(res.status).toBe(200);
    await res.bodyStream.cancel();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('a thrown error on the retry attempt is propagated (no further retry)', async () => {
    // The contract is "retry once, then return". If the retry
    // also throws, the error bubbles up. This pins the count:
    // exactly two fetch calls even when both fail.
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new Error('ECONNRESET again'));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      postOkmd({
        endpoint: 'openai',
        apiKey: 'k',
        body: {},
        signal: notAborted,
      }),
    ).rejects.toThrow(/ECONNRESET/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// --------------------------------------------------------------------------
// Cancellation (regression pin for the spec 0001 Story 10 path)
// --------------------------------------------------------------------------

describe('postOkmd — already-aborted signal', () => {
  test('skips the network entirely and throws "aborted"', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const controller = new AbortController();
    controller.abort();
    await expect(
      postOkmd({
        endpoint: 'openai',
        apiKey: 'k',
        body: {},
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('an already-aborted signal does not retry', async () => {
    // Even though the post-abort code path raises an error, the
    // retry block is gated on `!opts.signal.aborted`. A
    // pre-aborted signal therefore never reaches the retry
    // attempt — only the short-circuit.
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const controller = new AbortController();
    controller.abort();
    try {
      await postOkmd({
        endpoint: 'openai',
        apiKey: 'k',
        body: {},
        signal: controller.signal,
      });
    } catch {
      // expected
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
