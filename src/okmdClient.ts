/**
 * Low-level HTTP client for the OKMD API.
 *
 * Responsibilities:
 *   - Auth header injection (Bearer for OpenAI endpoint, x-api-key for Anthropic)
 *   - Timeout enforcement via AbortController
 *   - One retry on 5xx or network error, with 1s backoff
 *   - Returns the upstream response as a `ReadableStream<Uint8Array>`
 *     so the caller (provider.ts) can stream SSE bytes into the
 *     parser as they arrive, instead of buffering the whole body
 *     up front. See issue #8.
 *
 * Not responsible for:
 *   - SSE parsing (the parsers consume `bodyStream` directly)
 *   - Request body shaping (that's in converters/)
 *   - Model-list management (that's in `modelCache.ts` / `api.ts`)
 *   - Mapping non-2xx responses to `vscode.LanguageModelError`
 *     variants — the caller inspects `res.status` and decides
 *     whether to buffer the stream into text and call
 *     `mapHttpError`, or to stream it straight to the parser.
 */

import { OKMD_API_BASE_URL, REQUEST_TIMEOUT_MS, RETRY_DELAY_MS } from './constants';

export interface OkmdRequestOptions {
  endpoint: 'openai' | 'anthropic';
  apiKey: string;
  body: unknown;
  signal: AbortSignal;
}

export interface OkmdResponse {
  status: number;
  bodyStream: ReadableStream<Uint8Array>;
}

export class OkmdHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly bodyText: string,
    message?: string,
  ) {
    super(message ?? `OKMD API returned ${status}`);
    this.name = 'OkmdHttpError';
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

export async function postOkmd(opts: OkmdRequestOptions): Promise<OkmdResponse> {
  // Short-circuit when the caller's CancellationToken is already
  // cancelled: spec 0001 Story 10 says a cancelled request must not
  // hit the network. Without this, the first `attempt()` would still
  // call `fetch` with an already-aborted signal and the fetch would
  // throw — but that wastes one event-loop tick and risks ordering
  // issues with retry. Detecting it here is cheaper and clearer.
  if (opts.signal.aborted) {
    throw new Error('aborted');
  }

  const path = opts.endpoint === 'anthropic' ? '/messages' : '/chat/completions';
  const url = `${OKMD_API_BASE_URL}${path}`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (opts.endpoint === 'anthropic') {
    headers['x-api-key'] = opts.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers['Authorization'] = `Bearer ${opts.apiKey}`;
  }

  const attempt = async (): Promise<OkmdResponse> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const onParentAbort = () => controller.abort();
    opts.signal.addEventListener('abort', onParentAbort, { once: true });

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(opts.body),
        signal: controller.signal,
      });
      // The real `Response` always has a `body` — a `ReadableStream`
      // (or, in Node 18+, possibly a `Readable`). We assert the
      // shape at the boundary because the parsers expect a
      // `ReadableStream<Uint8Array>` and any other shape (null,
      // already-locked, or a `Readable`) would silently break the
      // streaming contract pinned by `tests/streaming.test.ts`.
      //
      // The `as ReadableStream<Uint8Array>` cast is safe for the
      // platforms this extension targets: VS Code 1.104 ships on
      // Electron 30+, whose `net.fetch` (via undici) returns a
      // WHATWG `ReadableStream<Uint8Array>`. The cast is
      // belt-and-braces against a future Node where `undici` is
      // replaced with a `Readable`-returning `fetch` polyfill —
      // the parsers and tests would need adapting in that case.
      if (res.body === null) {
        throw new Error(`OKMD ${path} returned no response body`);
      }
      return { status: res.status, bodyStream: res.body as ReadableStream<Uint8Array> };
    } finally {
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onParentAbort);
    }
  };

  // Per spec 0001 §Request lifecycle: retry once on 5xx or
  // network error. 4xx (including 429) is returned to the caller
  // as-is — only 5xx and thrown errors are retried.
  const first = await runOnce(attempt, opts.signal);
  if (first.kind === 'ok') {
    return first.response;
  }
  // Either a thrown error or a 5xx response. Both qualify for a
  // single retry; if the retry also fails, surface the most
  // recent result.
  await sleep(RETRY_DELAY_MS, opts.signal);
  const second = await runOnce(attempt, opts.signal);
  if (second.kind === 'ok') {
    return second.response;
  }
  if (second.kind === 'http5xx') {
    return second.response;
  }
  // second.kind === 'thrown' — propagate.
  throw second.error;
}

/**
 * Run a single HTTP attempt and classify the result.
 *
 * Returns one of:
 *   - `{ kind: 'ok' }` for a 1xx/2xx/3xx/4xx response (the caller
 *     never has to retry 4xx — see spec 0001).
 *   - `{ kind: 'http5xx' }` for a 5xx response. The caller decides
 *     whether to retry.
 *   - `{ kind: 'thrown', error }` for a thrown error (network
 *     error, abort, etc.). The caller decides whether to retry.
 */
type AttemptResult =
  | { kind: 'ok'; response: OkmdResponse }
  | { kind: 'http5xx'; response: OkmdResponse }
  | { kind: 'thrown'; error: unknown };

async function runOnce(
  attempt: () => Promise<OkmdResponse>,
  signal: AbortSignal,
): Promise<AttemptResult> {
  try {
    const response = await attempt();
    if (response.status >= 500) {
      return { kind: 'http5xx', response };
    }
    return { kind: 'ok', response };
  } catch (error) {
    if (signal.aborted) {
      return { kind: 'thrown', error };
    }
    return { kind: 'thrown', error };
  }
}
