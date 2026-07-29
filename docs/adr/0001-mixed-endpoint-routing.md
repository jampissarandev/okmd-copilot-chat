# ADR-0001: Mixed-Endpoint Routing by Model

- Status: Accepted
- Date: 2026-07-29

## Context

OKMD's API exposes two endpoints that both complete chat requests:

- `POST /chat/completions` — OpenAI-compatible. Accepts `messages` array with
  `role: "system"` mixed in. Header: `Authorization: Bearer <key>`. No
  `thinking` parameter.
- `POST /messages` — Anthropic-compatible. Accepts `messages` array plus a
  separate top-level `system` string. Header: `x-api-key: <key>`. Supports
  `thinking`, `top_k`, `stop_sequences`.

`vscode.lm` always sends requests in OpenAI shape (`messages` array, no
separate `system` field). The extension must either:

1. Use one endpoint for everything (and lose features from the other), or
2. Convert between shapes per-model.

## Decision

**Use a mixed strategy, routed by the `modelCapabilities` lookup table**:

- Models whose entry has `endpoint: "anthropic"` → call `/messages`,
  converting from OpenAI shape to Anthropic shape and parsing the
  Anthropic-style SSE stream.
- Models whose entry has `endpoint: "openai"` (the default) → call
  `/chat/completions` with the OpenAI shape directly.

The default is `openai`. The table is constructed at extension activation by
matching model names against known families (e.g. any name starting with
`claude-` is marked `anthropic`).

## Consequences

Positive:

- Claude users get `thinking` and other Anthropic-specific features.
- Single extension serves both OpenAI-shape and Anthropic-shape models.
- Adding a new endpoint (e.g. Gemini native) is a matter of adding another
  converter, not changing the routing logic.

Negative:

- Two request-body converters, two SSE parsers, two error-mappers.
- Test surface roughly doubles.
- Future maintainers must read both code paths.

## Alternatives considered

- **`/chat/completions` for everything** — simpler, but loses Claude's
  flagship `thinking` feature. Rejected because Claude is the most prominent
  model family in OKMD's catalog.
- **Hardcoded `claude-*` prefix check at the call site** — works but spreads
  routing knowledge across the codebase. The lookup table keeps it in one
  place.
- **`/messages` for everything** — would break OpenAI-shape models that OKMD
  exposes (e.g. `gpt-5`, `gemini-2.5-pro`).
