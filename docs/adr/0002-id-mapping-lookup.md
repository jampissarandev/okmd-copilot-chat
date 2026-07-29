# ADR-0002: Picker ID and Runtime Name-to-NumberId Lookup

- Status: Accepted
- Date: 2026-07-29

## Context

The OKMD `/models` endpoint returns objects shaped like
`{ id: 1, object: "model", created: 1761053047, owned_by: "claude-sonnet-4" }`.
The `id` is a **number**, not the human-readable name.

`/chat/completions` (and `/messages`) require the body field `model` to be
**that number**, not a string. Example from the docs:

```json
{ "model": 1, "messages": [...] }
```

`vscode.lm` requires every registered model to have an `id` (string) and a
`name` (string) at registration time.

If the extension simply forwards the OKMD `id` as a string (e.g. `"1"`), the
model picker works but two providers registering `"1"` would collide and the
user cannot distinguish them. If the extension forwards the OKMD `name`
directly, the API rejects the request with `Invalid model`.

## Decision

Construct VS Code model IDs as `"okmd/" + <OKMD name>`, e.g. `okmd/claude-sonnet-4`.
The display name shown in the picker is `<OKMD name> (OKMD)`, e.g.
`claude-sonnet-4 (OKMD)`.

At runtime, maintain a `Map<string, number>` (name → numberId) populated from
the latest `/models` response. On every chat request:

1. Look up the chosen model's name in the map.
2. Send the number to the OKMD API.
3. If the map has no entry, fail loudly — refresh the model list and retry
   once. If still missing, return a `LanguageModelError` with a clear message.

The map is repopulated on extension activation, on TTL expiry (1 hour), and
on the `OKMD: Refresh Model List` command. The map is not persisted; it is
rebuilt from `/models` on every activation.

## Consequences

Positive:

- IDs are namespaced (`okmd/...`) so multiple LM providers can coexist.
- Picker display is human-readable.
- The OKMD API receives exactly what it expects.

Negative:

- An in-memory map that must be refreshed periodically.
- If OKMD reassigns a numberId for a given name between refreshes, ongoing
  chat sessions will fail until refresh. The error path is loud (logged +
  surfaced), so the user notices and can refresh manually.
- The map is empty on the very first request after activation if `/models`
  has not yet responded. Activation blocks on the initial fetch.

## Alternatives considered

- **Use OKMD's number directly as the VS Code ID** (`"1"`). Simpler but
  collides with other providers' numeric IDs and confuses users.
- **Use OKMD's name as the VS Code ID** (`"claude-sonnet-4"`) and call the
  API with the name string. The API rejects this with `Invalid model`.
- **Persist the map to disk and trust it forever**. Risky if OKMD
  reorganises its model numbering.
