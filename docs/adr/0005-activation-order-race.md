### Follow-up #2 (2026-07-30 — picker still hidden, root cause is `toolCalling: false`)

After the EventEmitter was removed, the user re-ran the smoke
test. The alternating pattern persisted, and the picker still
showed zero OKMD models. The user's hypothesis: the model
capability was wrong. Reading
[microsoft/vscode#296786](https://github.com/microsoft/vscode/issues/296786)
confirmed it:

> "For a model to be available when using agents, it must
> support tool calling. If the model doesn't support tool
> calling, it won't be shown in the model picker."
> — Albert-King, Mar 10 2026

The OKMD provider was previously gating `toolCalling: true` on
a hardcoded `TOOL_CAPABLE_MODELS` whitelist of four names
(`claude-sonnet-4`, `claude-opus-4`, `gpt-5`, `gemini-2.5-pro`).
The other 19 models in the OKMD cache were registered with
`toolCalling: false` and were filtered out of the Agent-mode
picker. In the user's session the picker is in **Agent mode**
(the default for any chat), so 19/23 models were invisible.

The fix: **report every model as `toolCalling: true`.** The
OKMD gateway forwards tool calls to the underlying model for
every name we expose — the same Claude, GPT-5, Gemini family
that we already whitelist, just under different version names
(sonnet-4.5, opus-4.1, gpt-5-mini, etc.). If a future model
genuinely does not support tools, the dispatch path will log
a warning and the upstream call will fail loudly with a
non-2xx response, which `mapHttpError` already surfaces.

#### Implementation

- [src/capabilities.ts](../../src/capabilities.ts): `getCapabilities`
  now returns `toolCalling: true` unconditionally. The
  `TOOL_CAPABLE_MODELS` whitelist is no longer consulted by
  the routing table; it is kept in `constants.ts` for the
  diagnostic command `okmd.refreshToolCapability` (decision
  3/D), which is the only remaining consumer.
- [src/provider.ts](../../src/provider.ts): the `dispatch`
  method logs an info line when the incoming request contains
  tool calls, so a future regression that drops a model's
  tool support is observable in the Output Channel.
- [tests/capabilities.test.ts](../../tests/capabilities.test.ts):
  the table tests assert `toolCalling: true` for every input,
  and a new regression guard iterates a list of representative
  names and asserts the same. The "whitelist drift" tests are
  removed (the whitelist is no longer load-bearing for the
  picker).

#### Trade-off

Models that the OKMD gateway happens to forward tool calls to
but that the underlying model does not support (e.g. a future
embedding model) will be advertised as tool-capable and the
dispatch will pass the tool call through. The upstream will
return a 4xx; `mapHttpError` will surface it to the chat UI
as a `NotFound` or `InvalidRequest` error. The user will see
the failure immediately and can report it. The trade-off
(picker shows the model, dispatch may fail) is preferred over
the alternative (picker hides the model, user has no signal
that the model exists at all).

#### Re-introducing the whitelist

If the OKMD gateway ever returns a per-model capability field
(e.g. `supports_tools: boolean` in the `/models` response),
the whitelist should be removed entirely and `getCapabilities`
should read the field directly. The placeholder
`okmd.refreshToolCapability` command is the seam where that
migration will land.
### Follow-up #2 (2026-07-30 — picker still hidden, root cause is `toolCalling: false`)

After the EventEmitter was removed, the user re-ran the smoke
test. The alternating pattern persisted, and the picker still
showed zero OKMD models. The user's hypothesis: the model
capability was wrong. Reading
[microsoft/vscode#296786](https://github.com/microsoft/vscode/issues/296786)
confirmed it:

> "For a model to be available when using agents, it must
> support tool calling. If the model doesn't support tool
> calling, it won't be shown in the model picker."
> — Albert-King, Mar 10 2026

The OKMD provider was previously gating `toolCalling: true` on
a hardcoded `TOOL_CAPABLE_MODELS` whitelist of four names
(`claude-sonnet-4`, `claude-opus-4`, `gpt-5`, `gemini-2.5-pro`).
The other 19 models in the OKMD cache were registered with
`toolCalling: false` and were filtered out of the Agent-mode
picker. In the user's session the picker is in **Agent mode**
(the default for any chat), so 19/23 models were invisible.

The fix: **report every model as `toolCalling: true`.** The
OKMD gateway forwards tool calls to the underlying model for
every name we expose — the same Claude, GPT-5, Gemini family
that we already whitelist, just under different version names
(sonnet-4.5, opus-4.1, gpt-5-mini, etc.). If a future model
genuinely does not support tools, the dispatch path will log
a warning and the upstream call will fail loudly with a
non-2xx response, which `mapHttpError` already surfaces.

#### Implementation

- [src/capabilities.ts](../../src/capabilities.ts): `getCapabilities`
  now returns `toolCalling: true` unconditionally. The
  `TOOL_CAPABLE_MODELS` whitelist is no longer consulted by
  the routing table; it is kept in `constants.ts` for the
  diagnostic command `okmd.refreshToolCapability` (decision
  3/D), which is the only remaining consumer.
- [src/provider.ts](../../src/provider.ts): the `dispatch`
  method logs an info line when the incoming request contains
  tool calls, so a future regression that drops a model's
  tool support is observable in the Output Channel.
- [tests/capabilities.test.ts](../../tests/capabilities.test.ts):
  the table tests assert `toolCalling: true` for every input,
  and a new regression guard iterates a list of representative
  names and asserts the same. The "whitelist drift" tests are
  removed (the whitelist is no longer load-bearing for the
  picker).

#### Trade-off

Models that the OKMD gateway happens to forward tool calls to
but that the underlying model does not support (e.g. a future
embedding model) will be advertised as tool-capable and the
dispatch will pass the tool call through. The upstream will
return a 4xx; `mapHttpError` will surface it to the chat UI
as a `NotFound` or `InvalidRequest` error. The user will see
the failure immediately and can report it. The trade-off
(picker shows the model, dispatch may fail) is preferred over
the alternative (picker hides the model, user has no signal
that the model exists at all).

#### Re-introducing the whitelist

If the OKMD gateway ever returns a per-model capability field
(e.g. `supports_tools: boolean` in the `/models` response),
the whitelist should be removed entirely and `getCapabilities`
should read the field directly. The placeholder
`okmd.refreshToolCapability` command is the seam where that
migration will land.
