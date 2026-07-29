/**
 * Top-level fetchers for the OKMD API.
 *
 * This is the only place in the codebase that calls `fetch`
 * against `${OKMD_API_BASE_URL}` for the model-list endpoint.
 * It is a top-level function (not a method on a class) so the
 * cache can pass it as a function reference without bracket-
 * access into a private method — see issue #3.
 *
 * Kept separate from `modelCache.ts` so the cache module owns
 * only cache state, not I/O. Kept separate from `okmdClient.ts`
 * because the `/models` endpoint has a different shape (GET, no
 * body, no timeout/retry, no streaming) and conflating them
 * would muddy the responsibilities documented at the top of
 * `okmdClient.ts`.
 */

import { OKMD_API_BASE_URL } from './constants';
import { OkmdHttpError } from './okmdClient';
import { OkmdModel } from './modelCache';

/**
 * Fetch the current model list from `GET /models`.
 *
 * Throws if the API key is missing or the request fails. The
 * returned list is the same `data` array the cache uses, in
 * the same order. Errors propagate as `OkmdHttpError` (for
 * non-2xx) or plain `Error` (for missing key / malformed body).
 */
export async function fetchOkmdModels(apiKey: string): Promise<OkmdModel[]> {
  const res = await fetch(`${OKMD_API_BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new OkmdHttpError(
      res.status,
      await res.text(),
      `GET /models failed: ${res.status}`,
    );
  }
  const data = (await res.json()) as { data: OkmdModel[] };
  return data.data;
}
