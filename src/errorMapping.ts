/**
 * Map OKMD HTTP error responses to `vscode.LanguageModelError` variants.
 *
 * This is the only place in the codebase that knows about OKMD's
 * status-code/body-text → VS Code error mapping. Keep it pure: a function
 * of (status, body, endpoint) → LanguageModelError. The `vscode` parameter
 * exists for testability; production callers should pass the real
 * `import * as vscode from 'vscode'`.
 *
 * Per spec 0001 §Error handling (decision 13): trust the status code first,
 * then parse the body for known keywords. OKMD quirk: many distinct
 * failure modes return 401, so the keyword parse disambiguates them.
 */

import * as realVscode from 'vscode';
import { logWarn as realLogWarn } from './logger';

/**
 * The subset of the `vscode` namespace this module actually uses.
 * Tests pass a stub that conforms to this shape.
 */
export interface VscodeLike {
  LanguageModelError: {
    NoPermissions(message?: string): unknown;
    Blocked(message?: string): unknown;
    NotFound(message?: string): unknown;
  };
}

export type ErrorEndpoint = 'openai' | 'anthropic';

export type LogFn = (message: string, ...args: unknown[]) => void;

/**
 * Map OKMD HTTP errors to `vscode.LanguageModelError` variants.
 *
 * `vscode` and `log` are injectable for testability; production callers
 * omit them and get the real `vscode` module and the real Output
 * Channel logger. Tests pass a stub and a no-op.
 */
export function mapHttpError(
  status: number,
  bodyText: string,
  endpoint: ErrorEndpoint,
  vscode: VscodeLike = realVscode,
  log: LogFn = realLogWarn,
): Error {
  log(`OKMD ${endpoint} error ${status}: ${bodyText.slice(0, 500)}`);

  // OKMD quirk: it returns 401 for many distinct failure modes. Try to
  // disambiguate by message body.
  if (status === 401 || status === 403) {
    if (/invalid api key/i.test(bodyText)) {
      return vscode.LanguageModelError.NoPermissions('Invalid OKMD API key') as Error;
    }
    if (/invalid model/i.test(bodyText)) {
      return vscode.LanguageModelError.NotFound('Invalid OKMD model') as Error;
    }
    if (/reached daily limit/i.test(bodyText)) {
      return vscode.LanguageModelError.Blocked('Model daily quota reached') as Error;
    }
    return vscode.LanguageModelError.NoPermissions(
      `OKMD auth failed (${status})`,
    ) as Error;
  }
  if (status === 429) {
    return vscode.LanguageModelError.Blocked('OKMD rate limit hit') as Error;
  }
  if (status >= 500) {
    return vscode.LanguageModelError.Blocked(`OKMD server error (${status})`) as Error;
  }
  // 400 + "messages is required" is a client-side validation failure
  // (the extension sent an empty `messages` array), not a missing
  // resource. In VS Code 1.104 the only error variants are
  // `NoPermissions`, `Blocked`, and `NotFound`; there is no
  // `InvalidRequest`. The closest semantic fit is `Blocked` ("the
  // requestor is blocked from using this language model" — the server
  // refused the request). `NotFound` is reserved for missing-resource
  // conditions (e.g. `Invalid model`, model id not in the cache).
  if (status === 400 && /messages is required/i.test(bodyText)) {
    return vscode.LanguageModelError.Blocked(
      'OKMD rejected the request: empty messages array sent to the provider',
    ) as Error;
  }
  // Fallback for any other unrecognised status. `NotFound` is reserved
  // for missing-resource conditions; using it here would mislead users
  // (e.g. a 500 that didn't match the `>= 500` branch above would
  // surface as "model not found"). `Blocked` is the closest generic
  // variant in 1.104 for "the request was rejected by the server".
  return vscode.LanguageModelError.Blocked(
    `OKMD rejected the request (${status}): ${bodyText.slice(0, 200)}`,
  ) as Error;
}
