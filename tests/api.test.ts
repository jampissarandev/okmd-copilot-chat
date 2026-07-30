/**
 * Tests for `fetchOkmdModels` resilience.
 *
 * Background: opencode-copilot-chat issue #78 documented that
 * transient network failures (DNS wobble, TCP reset, undici
 * socket-reuse race) can break a single `fetch` call at the
 * worst possible time — when the picker is being resolved on
 * first activation. The fix is three-fold:
 *
 *   1. Hard per-attempt timeout (15s) so a hung connect cannot
 *      stall the picker for the full undici default of 5 minutes.
 *   2. Retry on transient errors with exponential backoff.
 *   3. Final failure surfaces — we do NOT swallow; the cache
 *      falls back to the bundled list, and the provider falls
 *      back to that.
 *
 * The test below pins all three behaviours against a `fetch`
 * stub. It does NOT exercise the real OKMD gateway.
 */

jest.mock('vscode');
// Override the retry back-off so the retry test completes in
// a few milliseconds instead of a full second.
jest.mock('../src/constants', () => {
  const actual = jest.requireActual('../src/constants');
  return {
    ...actual,
    MODEL_LIST_FETCH_RETRY_BASE_MS: 0,
  };
});

import { fetchOkmdModels } from '../src/api';
import { OkmdHttpError } from '../src/okmdClient';

const realFetch = global.fetch;
const notAborted = new AbortController().signal;

function makeResponse(status: number, body: unknown): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return {
    status,
    ok: status >= 200 && status < 300,
    body: stream,
    text: async () => text,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  } as unknown as Response;
}

afterEach(() => {
  global.fetch = realFetch;
});

describe('fetchOkmdModels — resilience', () => {
  test('sends Authorization header and parses the response', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(
        makeResponse(200, { data: [{ id: '1', name: 'claude-sonnet-4' }] }),
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    const models = await fetchOkmdModels('sk-abc');

    expect(models).toEqual([{ id: '1', name: 'claude-sonnet-4', owned_by: undefined }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gen.ai.kku.ac.th/okmd/api/v1/models');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-abc');
  });

  test('throws OkmdHttpError on non-2xx', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(makeResponse(401, 'unauthorized')) as unknown as typeof fetch;

    await expect(fetchOkmdModels('sk-abc')).rejects.toBeInstanceOf(OkmdHttpError);
  });

  test('retries on transient network error and eventually succeeds', async () => {
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(
        makeResponse(200, { data: [{ id: '1', name: 'claude-sonnet-4' }] }),
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    const models = await fetchOkmdModels('sk-abc');

    expect(models).toHaveLength(1);
    // 2 transient failures + 1 success = 3 total attempts.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test('gives up after the configured retry budget and throws', async () => {
    const fetchMock = jest
      .fn()
      .mockRejectedValue(new TypeError('fetch failed'));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(fetchOkmdModels('sk-abc')).rejects.toThrow(/fetch failed/);
    // 1 initial + 3 retries = 4 attempts.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  test('does NOT retry on non-transient HTTP 4xx (except 408/429)', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(makeResponse(400, 'bad request'));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(fetchOkmdModels('sk-abc')).rejects.toBeInstanceOf(OkmdHttpError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('retries on HTTP 429 (rate limit)', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(makeResponse(429, 'rate limited'))
      .mockResolvedValueOnce(makeResponse(200, { data: [] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const models = await fetchOkmdModels('sk-abc');

    expect(models).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('sends Accept and User-Agent headers (corporate firewall resilience)', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(makeResponse(200, { data: [] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await fetchOkmdModels('sk-abc');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Accept).toBe('application/json');
    expect(typeof headers['User-Agent']).toBe('string');
    expect(headers['User-Agent'].length).toBeGreaterThan(0);
  });
});
