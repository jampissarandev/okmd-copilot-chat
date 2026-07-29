# ADR-0003: Model List Cache in `globalState` with TTL

- Status: Accepted
- Date: 2026-07-29

## Context

The model list returned by `GET /models` changes whenever OKMD adds,
removes, or renumbers a model. Re-fetching on every Copilot Chat open is
slow and burns user quota. But if we never refresh, the user can be stuck
on a stale list with no signal to update.

The extension must be fast at activation, offline-tolerant (a user who
opens VS Code on a plane should still see their previously known models),
and eventually consistent with `/models`.

## Decision

Cache the model list in VS Code's `globalState` under a single key
(`okmd.modelList`). Each entry is `{ fetchedAt: number, models: OkmdModel[] }`.

On activation:

1. Load the cached list. If present, register its models with `vscode.lm`
   immediately so the picker is populated.
2. If the cache is older than 1 hour (TTL), kick off a background refresh.
3. If the cache is fresh, do not refresh.
4. Always expose the `OKMD: Refresh Model List` command, which forces an
   immediate refresh regardless of TTL.

A refresh failure (network error, 5xx) is logged to the Output Channel and
the previous cache is retained. The user is not notified; the next
activation will try again.

The `globalState` write is debounced — many rapid calls to the refresh
command collapse into one network request.

## Consequences

Positive:

- Activation is fast even with a cold cache (read from disk, register, done).
- Offline-first: the picker still shows the last known models.
- Manual refresh gives users a recovery path when something looks wrong.
- TTL bounds staleness to 1 hour without forcing unnecessary network calls.

Negative:

- Up to 1 hour of staleness possible.
- The `globalState` entry is shared across all workspaces; users who want
  per-workspace model lists cannot get them in v1.
- Cache invalidation on model renumbering is implicit (the next refresh
  fetches new ids); the user may see a 401 in the meantime.

## Alternatives considered

- **`globalState` with no TTL** — eventually consistent in theory, but in
  practice users forget to refresh and report bugs.
- **No cache, fetch on every activation** — slow on flaky networks, fails
  when offline.
- **In-memory cache only** — restart on every VS Code reload, painful for
  users who keep VS Code open for days.
- **`workspaceState` instead of `globalState`** — would scope per-workspace,
  but a user typically wants the same model list everywhere; rejected for v1.
