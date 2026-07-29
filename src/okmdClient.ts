/**
 * Low-level HTTP client for the OKMD API.
 *
 * Responsibilities:
 *   - Auth header injection (Bearer for OpenAI endpoint, x-api-key for Anthropic)
 *   - Timeout enforcement via AbortController
 *   - One retry on 5xx or network error, with 1s backoff
 *
 * Not responsible for:
 *   - SSE parsing
 *   - Request body shaping (that's in converters/)
 *   - Model-list management (that's in modelCache.ts)
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
  bodyText: string;
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
      const bodyText = await res.text();
      return { status: res.status, bodyText };
    } finally {
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onParentAbort);
    }
  };

  try {
    return await attempt();
  } catch (err) {
    // Network error or timeout — retry once.
    if (opts.signal.aborted) {
      throw err;
    }
    await sleep(RETRY_DELAY_MS, opts.signal);
    return await attempt();
  }
}
