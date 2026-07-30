# ADR-0005: Fix the activation-order race that hid the OKMD picker

- Status: **Superseded by follow-up (2026-07-30)**
- Date: 2026-07-30
- Follow-up: see `## Follow-up` at the bottom of this file. The
  EventEmitter hypothesis (microsoft/vscode#317414) was the primary
  cause after all; the activation-order race is a secondary
  contributor. The current code removes the EventEmitter entirely.

## Context

The OKMD provider's `provideLanguageModelChatInformation()` returns 23
models on the user's ExtDev Host, but the Copilot Chat model picker
still hides all of them ("ยังไม่โผล่" — "still not showing up to
choose from"). The user-confirmed evidence:

- `provideLanguageModelChatInformation` returns 23 models (logged
  on every call: `[picker] returning 23 models`).
- `Copilot Chat → ⋯ → Manage Models` shows an `OKMD` entry — the
  provider group **is** registered, so `lm.migrateLanguageModelsProviderGroup`
  succeeded and the platform knows about the vendor.
- The model picker in the chat input shows no `OKMD` vendor at all
  — but the Manage Models entry is there.

So the platform has the vendor registered, the migration worked, but
the picker shows nothing.

## Decision (original — activation order race)

Fix the activation-order race in [src/extension.ts](src/extension.ts).
The current code runs the disk-cache load (`cache.activate()`) and
the API-key migration (`migrateLanguageModelProviderGroup`) in
parallel as two fire-and-forget promises. The migration command
internally invokes the provider's `provideLanguageModelChatInformation`
once, with the configured API key. If the cache is still empty at
that moment (the `cache.activate()` promise hasn't started yet, or
its first `await` on disk is still pending), the provider falls
through to `await this.cache.refresh()` — a network round trip
inside the platform's call. The platform's call may complete
(empty), or may time out, or may record "no models" before the
network refresh returns. Either way, the provider group is
registered with zero models, and the picker hides the vendor.

The correct order — the one NVIDIA NIM's
`initializeStoredApiKey` already follows — is:

1. **Synchronously load the disk cache** into memory
   (`cache.applyPersisted()`). This populates `cache.models` from
   `globalState` without any network I/O. Any subsequent
   `provideLanguageModelChatInformation` call now finds the cache
   non-empty.
2. **Migrate the API key** to the VS Code LM provider group. The
   platform's internal call to the provider now finds the disk
   cache populated and returns the model list.
3. **Kick off a background network refresh** (`cache.activate()`
   minus the disk-load step) to update the cache from `/models`.
   This is a non-blocking improvement, not a prerequisite for
   picker visibility.

To make step 1 possible, the new `ModelCache.applyPersisted()` is a
synchronous method that reads `globalState` and calls the
already-private `applyModels()`. The original `activate()` is
updated to call `applyPersisted()` first if the cache is empty
(preserving the standalone "just call `activate()`" use case for
test code), then refresh from the network if stale, then schedule
the next periodic refresh.

## Consequences

Positive:

- The activation sequence is deterministic. The platform's first
  `provideLanguageModelChatInformation` call (from the migration)
  finds the disk cache populated and returns 23 models. The
  provider group is registered with the full model list, the
  picker shows the vendor with all 23 entries.
- The `onDidChangeLanguageModelChatInformation` EventEmitter
  remains exposed (matching NVIDIA NIM), so the picker auto-
  refreshes when the cache updates in the background.
- The order is easy to reason about: load → migrate → refresh.
  Each step has a single observable side-effect.

Negative:

- Activation is now strictly serialised. If `globalState.get` is
  very slow for some reason, the migration runs slightly later.
  In practice `globalState.get` is synchronous and fast, so the
  cost is negligible.
- The `cache.activate()` API now has an implicit contract that it
  expects the caller to have called `applyPersisted()` first if
  the cache might be needed immediately. This is documented on
  both methods and is exercised by `extension.ts`; the test
  suite still treats `activate()` as the standalone entry point.

## Alternatives considered

- **Drop the EventEmitter per microsoft/vscode#317414.** This was
  the proposal in the earlier draft of this ADR. Probes in the
  user's ExtDev Host showed it does not fix the symptom: OKMD was
  registered in Manage Models, the picker was still empty, and
  NVIDIA NIM ships the same EventEmitter and is selectable. The
  EventEmitter has been restored.
- **Drop the embedded `apiKey` from each model info record.**
  Microsoft's canonical BYOK provider
  ([`abstractLanguageModelChatProvider.ts`](https://github.com/microsoft/vscode/tree/main/extensions/copilot/src/extension/byok/vscode-node/abstractLanguageModelChatProvider.ts))
  embeds `apiKey` and `configuration` on every model info record,
  as does NVIDIA NIM. The picker filter keys on
  `isUserSelectable: true`, not on the presence of `apiKey`.
  Rejected — would diverge from the working pattern.
- **Block the entire `activate()` on the network refresh before
  migrating.** Simplest, but pushes a 5–10 s network round trip
  into the extension host's startup. The current change avoids
  that by splitting the disk load (synchronous, free) from the
  network refresh (async, deferrable).
- **Trigger the migration from a `setTimeout` after a delay.**
  Worked-around the race but is fragile (delay is a magic
  number) and adds dead time to startup. The current change
  resolves the race structurally instead of masking it.

## Follow-up

- The user should rebuild the extension and reload the ExtDev
  Host. Expected: 23 models appear under the `OKMD` vendor in
  the Copilot Chat model picker.
- If the picker is still empty after the rebuild, the next
  hypothesis is that the platform's migration call is hitting
  the provider *before* the extension's `activate()` even
  starts. In that case, the fix is to call
  `migrateLanguageModelProviderGroup` from a `vscode.commands.registerCommand`
  the user runs explicitly, not from `activate()`. This is the
  heaviest UX but the most robust fallback.
- If `#316843` (a proposed upstream fix for the picker filter)
  lands in a future VS Code stable release and changes the
  semantics of provider-group visibility, the EventEmitter and
  the migration logic should be re-evaluated. Until then, this
  workaround is the minimum needed to make OKMD visible in
  VS Code 1.120+.
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
