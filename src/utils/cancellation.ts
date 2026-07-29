/**
 * Adapters between VS Code's `CancellationToken` and the web standard
 * `AbortSignal`.
 *
 * The VS Code `vscode.lm` contract hands providers a
 * `vscode.CancellationToken`; the web `fetch` API expects an
 * `AbortSignal`. They are not the same shape, so the extension has to
 * bridge them.
 *
 * This module is the single place that knows about the bridge. Both
 * the HTTP client (`okmdClient.ts`) and the SSE parsers consume
 * `AbortSignal`s produced here.
 *
 * Implements spec 0001 Story 10 ("I want to cancel a long-running
 * response and have the network request stop"). See issue #16.
 */

import type * as vscode from 'vscode';

/**
 * Convert a VS Code `CancellationToken` into a standard `AbortSignal`.
 *
 * If the token is already cancelled at the time of the call, the
 * returned signal is *already aborted* — the caller can detect this
 * with `signal.aborted` and short-circuit without ever starting the
 * underlying `fetch`. Otherwise, the signal aborts when the token
 * fires.
 */
export function cancellationTokenToAbortSignal(
  token: vscode.CancellationToken,
): AbortSignal {
  const controller = new AbortController();
  if (token.isCancellationRequested) {
    controller.abort();
    return controller.signal;
  }
  token.onCancellationRequested(() => controller.abort());
  return controller.signal;
}
