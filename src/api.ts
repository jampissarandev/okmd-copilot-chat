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

import * as vscode from 'vscode';
import {
  MODEL_LIST_FETCH_MAX_RETRIES,
  MODEL_LIST_FETCH_RETRY_BASE_MS,
  MODEL_LIST_FETCH_TIMEOUT_MS,
  OKMD_API_BASE_URL,
  OKMD_USER_AGENT,
  PROVIDER_ID,
} from './constants';
import { OkmdHttpError } from './okmdClient';
import { OkmdModel } from './modelCache';

/**
 * Read the OKMD API key from VS Code SecretStorage.
 *
 * In VS Code 1.104+, the user configures the key via
 * `OKMD: Set API Key` (command palette) — the same pattern as
 * NVIDIA NIM. The key is stored in `context.secrets` so it is
 * available immediately in the ExtDev Host.
 *
 * Also probes `workspace.getConfiguration('language-models')`
 * as a fallback for setups that used the Copilot "Add Models"
 * dialog. Diagnostic logging at each probe is intentional.
 *
 * Returns `undefined` if the key has not been configured yet.
 */
export async function getOkmdApiKey(context?: vscode.ExtensionContext): Promise<string | undefined> {
  // Primary: context.secrets (synced via OKMD: Set API Key command)
  if (context) {
    let secret: string | undefined;
    try {
      // Wrap secrets.get with a 5-second timeout to prevent hanging.
      secret = await Promise.race([
        context.secrets.get('okmd.apiKey'),
        new Promise<undefined>((_, reject) =>
          setTimeout(() => reject(new Error('context.secrets.get timed out after 5s')), 5_000),
        ),
      ]);
    } catch {
      // Swallow — fall through to the language-models fallback.
    }
    if (secret && secret.trim().length > 0) {
      return secret.trim();
    }
  }

  // Fallback: `language-models.providers` (Copilot "Add Models" dialog)
  try {
    const config = vscode.workspace.getConfiguration('language-models');
    const providers = config.get<unknown>('providers');
    if (Array.isArray(providers)) {
      const entry = providers.find(
        (p): p is { vendor?: string; apiKey?: string } =>
          typeof p === 'object' && p !== null && (p as { vendor?: unknown }).vendor === PROVIDER_ID,
      );
      if (entry?.apiKey) {
        return entry.apiKey;
      }
    }
  } catch {
    // Configuration read failed — fall through to undefined.
  }

  return undefined;
}

/**
 * Fetch the current model list from `GET /models`.
 *
 * Throws if the API key is missing or the request fails. The
 * returned list is the same `data` array the cache uses, in
 * the same order. Errors propagate as `OkmdHttpError` (for
 * non-2xx) or plain `Error` (for missing key / malformed body).
 *
 * Maps the upstream `display_name` field to the local `name`
 * field on `OkmdModel` so the cache's `nameToId` lookup works.
 * The upstream `id` is a string (e.g. `"claude-sonnet-5"`); we
 * preserve it as a string for the picker id but the cache
 * looks up by name, not id, so the type drift is benign.
 *
 * Resilience:
 *   - Each attempt is wrapped in `AbortSignal.timeout(...)` so a
 *     hung connect cannot stall the picker for the full undici
 *     default (5 minutes).
 *   - Retries up to `MODEL_LIST_FETCH_MAX_RETRIES` times on
 *     transient errors (TypeError, 5xx, 408, 429) with
 *     exponential backoff. Non-transient 4xx responses surface
 *     immediately so the user can fix their API key.
 *   - Sends `User-Agent` + `Accept` headers so corporate
 *     firewalls / SSL-inspecting proxies (Zscaler, Netskope,
 *     Fortinet) don't drop the GET as an anonymous scanner.
 *     Mirrors opencode-copilot-chat issue #78.
 */
export async function fetchOkmdModels(apiKey: string): Promise<OkmdModel[]> {
  const url = `${OKMD_API_BASE_URL}/models`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
    'User-Agent': OKMD_USER_AGENT,
  };

  for (let attempt = 0; attempt <= MODEL_LIST_FETCH_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(MODEL_LIST_FETCH_TIMEOUT_MS),
      });
      // Branch 1: success — return the parsed list.
      if (res.ok) {
        const raw = (await res.json()) as {
          data: Array<{
            id: string;
            display_name?: string;
            name?: string;
            owned_by?: string;
          }>;
        };
        return raw.data.map((m) => ({
          id: m.id,
          name: m.display_name ?? m.name ?? m.id,
          owned_by: m.owned_by,
        }));
      }
      // Branch 2: non-retryable HTTP status (e.g. 400, 401, 403).
      // Surface immediately so the user can fix the cause.
      if (!isTransientHttpStatus(res.status)) {
        throw new OkmdHttpError(
          res.status,
          await res.text(),
          `GET /models failed: ${res.status}`,
        );
      }
      // Branch 3: retryable HTTP status (408, 429, 5xx). Throw
      // an OkmdHttpError that the catch block will recognise as
      // transient and back off before the next attempt.
      throw new OkmdHttpError(
        res.status,
        await res.text(),
        `GET /models failed: ${res.status}`,
      );
    } catch (err) {
      // Non-retryable OkmdHttpError: re-throw immediately.
      if (
        err instanceof OkmdHttpError &&
        !isTransientHttpStatus(err.status)
      ) {
        throw err;
      }
      // Otherwise classify and decide whether to retry.
      const isTransient = isTransientError(err);
      if (!isTransient || attempt >= MODEL_LIST_FETCH_MAX_RETRIES) {
        throw err;
      }
      await sleepBackoff(attempt);
    }
  }
  // Unreachable: the loop above either returns (success) or
  // throws (terminal failure). The `never` return type would
  // be ideal, but TS's control-flow analysis cannot prove it.
  throw new Error('unreachable: retry loop fell through');
}

/**
 * Classify a fetch error as transient (worth retrying) or
 * permanent. Mirrors opencode-copilot-chat's
 * `isTransientFetchError` (issue #78).
 */
function isTransientError(err: unknown): boolean {
  // AbortError from our own 15s timeout — retry with a fresh
  // signal so a transient stall does not block the picker.
  if (err instanceof DOMException && err.name === 'AbortError') {
    return true;
  }
  // undici's generic "fetch failed" wrapper (DNS, TCP reset,
  // socket reuse race). The inner cause is usually more
  // specific, but the wrapper is what reaches user code.
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) {
    return true;
  }
  // OkmdHttpError on a retryable status (408, 429, 5xx).
  if (err instanceof OkmdHttpError && isTransientHttpStatus(err.status)) {
    return true;
  }
  return false;
}

function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function sleepBackoff(attemptIndex: number): Promise<void> {
  const delay =
    MODEL_LIST_FETCH_RETRY_BASE_MS * Math.pow(2, attemptIndex);
  await new Promise((resolve) => setTimeout(resolve, delay));
}
