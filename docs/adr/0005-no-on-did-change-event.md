# ADR-0005: Drop `onDidChangeLanguageModelChatInformation` to defeat the VS Code 1.120+ picker regression

- Status: Accepted
- Date: 2026-07-30
- Closes: the picker-regression investigation behind the diagnostic log
  `console.ts:139 [Extension Host] [OKMD] provideLanguageModelChatInformation() — returning 23 models`

## Context

The OKMD provider's `provideLanguageModelChatInformation()` returns 23
models on the user's ExtDev Host, but the Copilot Chat model picker
hides all of them ("ยังไม่ขึ้นให้เลือกเหมือนเดิม" — "still not showing up to
choose from, same as before"). The provider code in the working tree
already follows the NVIDIA NIM Provider (hidenobunagai/nvidia-nim-provider)
pattern: it sets `isUserSelectable: true`, embeds `apiKey` on every model
info, exposes a `displayName` and `vendor` in `package.json`, and migrates
the API key via `lm.migrateLanguageModelsProviderGroup`. None of that is
enough on the user's build of VS Code 1.120+.

The two relevant upstream issues are:

- [`microsoft/vscode#296786`](https://github.com/microsoft/vscode/issues/296786)
  — "Custom Foundry Local models do not appear in VS Code Copilot Chat
  model picker". The original report. Proposes either exposing
  `isUserSelectable` on the public API (the fix NVIDIA NIM Provider and
  OKMD already apply) or auto-enabling third-party models. The reporter's
  May 2026 update lists LM Studio (76 models hidden) and OpenCode Go as
  further victims of the same regression.
- [`microsoft/vscode#317414`](https://github.com/microsoft/vscode/issues/317414)
  — "VS Code 1.120+ `onDidChangeLanguageModelChatInformation` EventEmitter
  presence causes all LM providers to collapse into 'Azure'". The
  confirmed workaround, in the reporter's own words:

  > Commenting out or removing the `onDidChangeLanguageModelChatInformation`
  > EventEmitter property entirely fixes the issue. Models then appear
  > under the correct vendor label.

The OKMD provider was carrying an `onDidChangeLanguageModelChatInformation`
EventEmitter that relayed `ModelCache.onDidChange` into the platform. Per
#317414 that is the exact trigger. The comment in the previous
`provider.ts` dismissed #317414 as "likely a transient platform bug —
confirmed fixed or never blocked NVIDIA NIM", but the user's evidence is
that it is **not** fixed in the user's VS Code 1.120+ build. The dismissal
was wrong: NVIDIA NIM Provider working does not mean every other third-
party provider works.

## Decision

`OkmdChatProvider` no longer exposes `onDidChangeLanguageModelChatInformation`.
The `ModelCache.onDidChange` relay is removed. `provider.fireModelInfoChanged()`
is removed (the only callers were `extension.ts` after the API-key
migration and after `OKMD: Set API Key`; both are now handled by
re-running the `okmd.refreshModelList` command, which shows the model
count to the user as a side effect).

Refresh-after-key-change UX: after `okmd.manageApiKey` saves a new key,
`extension.ts` runs `vscode.commands.executeCommand('okmd.refreshModelList')`.
That command is the one wired up in the existing block; its info message
("OKMD model list refreshed (N models)") becomes the user-visible
feedback that the picker is up to date. To pick up new models the user
opens the Copilot Chat picker, which re-invokes
`provideLanguageModelChatInformation` and reads the cache. Because
`extension.ts` already calls `cache.refresh()` before the command runs
on the `Set API Key` path, the cache is current by the time the picker
re-asks.

A regression guard in `tests/pickerVisibility.test.ts` pins the new
contract: the provider must NOT have an `onDidChangeLanguageModelChatInformation`
property. The other NVIDIA-NIM-parity assertions (every model has
`isUserSelectable: true`, `detail`, `tooltip`) remain.

## Consequences

Positive:

- The Copilot Chat model picker should now show the 23 models the
  provider returns, in the user's VS Code 1.120+ build. The platform
  trigger for #317414 is gone.
- A regression test guards against a future contributor silently
  re-adding the EventEmitter.
- The single `OKMD: Refresh Model List` command is the only refresh
  surface, which is simpler to reason about than "automatic refresh
  via an event that the platform then misuses".

Negative:

- If the OKMD `/models` list changes while the user is sitting in a
  long-running session, the picker will not auto-refresh. They have to
  invoke `OKMD: Refresh Model List`. This is acceptable: the existing
  cache TTL is one hour, the cache also refreshes on the next extension
  activation, and a long-running session that needs a brand-new model
  is rare.
- We are working around a VS Code platform bug. When Microsoft ships
  the fix in a future VS Code release (a PR was proposed in
  #316843), the workaround can be lifted. The ADR notes the
  precondition for doing so: a VS Code release where
  `vscode.lm.registerLanguageModelChatProvider(...)` +
  `onDidChangeLanguageModelChatInformation` no longer hides models.

## Alternatives considered

- **Keep the EventEmitter and rely on `isUserSelectable: true` + embedded
  `apiKey` to defeat the filter.** This is what the previous code did,
  and the user evidence shows it does not work in their build. NVIDIA
  NIM Provider may benefit from additional platform wiring that the
  OKMD provider does not match. Rejected.
- **Drop the embedded `apiKey` from every model info, keep the
  EventEmitter.** This is the lighter-touch variant of the same fix,
  based on the hypothesis that the runtime-extension fields on the
  model info are what trip the picker filter. Not pursued because the
  workaround in #317414 is specifically about the EventEmitter
  property's *presence* on the provider instance, not on the model
  info records. We can revisit if dropping the EventEmitter does not
  restore visibility.
- **Prompt the user to reload the VS Code window after saving the API
  key.** A heavier workaround that is known to work in 1.120+ but
  costs the user their workspace state. Rejected because the lighter
  fix is sufficient if the EventEmitter really is the trigger.
- **Wait for microsoft/vscode#316843 to land in a stable VS Code
  release.** The PR is still under review as of 2026-05; relying on
  the user to upgrade is not acceptable when the workaround is two
  lines of code.

## Follow-up

- After rebuilding the extension and reloading the ExtDev Host, the
  user should see the 23 OKMD models in the Copilot Chat picker. If
  they do not, the next hypothesis to test is "drop the embedded
  `apiKey` from every model info" (the `apiKey` field on the model
  info is what the platform's permission filter may key off). Add a
  config flag or a second test branch to bisect if needed.
- When VS Code ships a release where the regression is fixed, lift
  the workaround: re-add the EventEmitter to `OkmdChatProvider`, flip
  the regression-guard test, and document the removal in this ADR's
  "Supersedes" line.
