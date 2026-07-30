# F5 Smoke Test — OKMD for Copilot Chat

> Manual end-to-end verification of the OKMD provider in the VS Code
> Extension Development Host. Linked from [Issue #9](../../issues/9).
> Run **before** opening a PR that touches activation / picker
> visibility, and after any change to `src/extension.ts` or
> `src/provider.ts`.
>
> **Source of truth:** this file is the canonical smoke-test
> checklist. The shorter checklist embedded in
> [Issue #9](../../issues/9) is a summary; the more detailed
> log-line assertions in this file are the source of truth. If
> the two drift, update this file and reference it from the
> issue. (See ADR-0005 Follow-up #2 for why the Agent-mode
> whitelist assertion in #9 is no longer accurate.)

---

## 0. Prerequisites

- [ ] **Host VS Code ≥ 1.120** (the 1.104 baseline should also work, but
      the picker behaviour differs — re-verify if downgrading)
- [ ] **`GitHub.copilot`** and **`GitHub.copilot-chat`** installed and
      signed in on the host (see `.vscode/extensions.json` for the
      recommended set)
- [ ] An **OKMD API key** from `playground.okmd.or.th → API Platform`
- [ ] Internet access to `https://gen.ai.kku.ac.th/okmd/api/v1`

## 1. Launch

- [ ] `npm install` (if not already)
- [ ] `npm run compile` exits 0
- [ ] `npm test` — all tests pass (regression guard)
- [ ] Open this folder in VS Code
- [ ] **Press F5** — the "Run Extension" launch config (see
      `.vscode/launch.json`) opens the Extension Development Host
      ([launch.json](../../.vscode/launch.json) sets
      `--extensionDevelopmentPath=${workspaceFolder}`)
- [ ] The ExtDev Host opens in a new window with `[Extension Development Host]`
      in the title bar
- [ ] No red error toast appears

## 2. Watch the activation log

Open **View → Output → select "OKMD for Copilot Chat"** in the
ExtDev Host. You should see this sequence within ~2 s on a
**fresh install** (no API key stored yet):

```
[INFO] Activating OKMD for Copilot Chat
[INFO] [activate:step1] disk cache loaded: N models      ← N = 0 on fresh install
[INFO] [activate:step2] no API key yet — vendor will show in picker but as 0 models until user adds key
[INFO] [activate:step3] starting background network refresh
[INFO] [activate:done] cache has 0 models
```

If a key was already stored from a previous run, the step2 lines
change to:

```
[INFO] [activate:step1] disk cache loaded: N models      ← N > 0 from previous run's cache
[INFO] [activate:step2] migrating API key to LM provider group
[INFO] [activate:step2] migration result: ok
[INFO] [activate:step3] starting background network refresh
[INFO] [activate:done] cache has N models                ← N > 0
```

If the picker still shows nothing after step 4 below, the
sequence is wrong; see [Troubleshooting](#no-okmd-in-picker).

## 3. Add the API key (BYOK)

- [ ] In the ExtDev Host, open the Copilot Chat view (the chat
      icon in the activity bar)
- [ ] Click the **⋯** menu → **Manage Models** → **Add Models**
- [ ] **OKMD** should appear in the list of providers
      - ✅ **If OKMD appears** → proceed to step 4
      - ❌ **If OKMD does NOT appear** → see [Troubleshooting](#no-okmd-in-picker)
- [ ] Select **OKMD** → enter the API key → save
- [ ] Watch the Output Channel for **the `okmd.manageApiKey`
      command path** (NOT the activation path in step 2 — this
      is a separate code path that runs `migrateLanguageModelProviderGroup`
      + the `okmd.refreshModelList` command):
  ```
  [INFO] OKMD API key saved.
  [INFO] [activate:step2] migrating API key to LM provider group
  [INFO] [activate:step2] migration result: ok
  [INFO] [manual-refresh] start
  [INFO] [manual-refresh] done — cache now has N models
  ```
  where `N` is the number of models OKMD returned (typically 4-23)

## 4. Verify the picker

- [ ] In the Copilot Chat input box, click the model name (e.g.
      "GPT-4o") at the bottom-left
- [ ] The dropdown shows an **OKMD** section
- [ ] At least 3 OKMD models are listed, each formatted `<name> (OKMD)`
      (e.g. `claude-sonnet-4 (OKMD)`, `gpt-5 (OKMD)`)
- [ ] Pick a non-Claude model (e.g. `gpt-5 (OKMD)`)
- [ ] Send a message; reply streams chunk-by-chunk
- [ ] Output Channel shows: `Dispatching to openai for model gpt-5`
- [ ] Pick a Claude model (e.g. `claude-sonnet-4 (OKMD)`)
- [ ] Send a message; reply streams chunk-by-chunk
- [ ] Output Channel shows: `Dispatching to anthropic for model claude-sonnet-4`

### 4.1. Token count hint

VS Code's chat input box shows a live token count (e.g. "X tokens"
near the model picker) that is fed by `provideTokenCount`. After
landing the v1 chars/4 heuristic (issue #19), the hint must
appear for **both** plain text and a `LanguageModelChatRequestMessage`,
and the chat step must not throw `OKMD token counting is not
implemented in v1`.

- [ ] Click into the chat input box and type a short message
      (e.g. `hello world`) — the token-count hint appears
      (≈ 3 tokens with the v1 chars/4 heuristic). It updates
      live as characters are added or removed.
- [ ] Clear the input box — the hint reads 0 tokens, no
      `Error: OKMD token counting is not implemented in v1`
      appears in the Output Channel or as a chat error toast.
- [ ] Paste a multi-line prompt — the hint grows roughly
      proportionally to the character count. The exact number
      is an approximation; the assertion is that **some
      non-zero number is shown and no error fires**.
- [ ] Pick a Claude model and repeat — the same hint appears;
      no error fires. (Claude goes through the Anthropic
      endpoint but the token-count heuristic is
      endpoint-agnostic.)
- [ ] Output Channel does **not** contain
      `OKMD token counting is not implemented in v1` at any
      point during the smoke test.

## 5. Cancellation

- [ ] Send a long prompt
- [ ] Mid-response, click the **stop / cancel** button in the chat UI
- [ ] Network request stops (no further text arrives)
- [ ] Output Channel shows an `aborted` line (or `request aborted`)

## 6. Agent mode shows all OKMD models

- [ ] Switch the chat to **Agent** mode (model picker → Agent)
- [ ] The OKMD section should show **all** OKMD models — the
      `TOOL_CAPABLE_MODELS` whitelist was removed in
      ADR-0005 Follow-up #2 because the OKMD gateway forwards
      tool calls for every model. VS Code 1.120+ no longer
      filters any of them out of the Agent-mode picker.
- [ ] If only a subset appears, the model capability is being
      mis-reported — check that
      `capabilities.toolCalling === true` is on every
      `LanguageModelChatInformation` returned by
      `provideLanguageModelChatInformation`.

## 7. Error mapping

- [ ] Temporarily corrupt the stored API key: in the ExtDev Host
      use the **OKMD: Set API Key** command (or
      `okmd.manageApiKey` from the command palette) to overwrite
      the stored key with a wrong one
- [ ] Send a message; chat shows **"Invalid OKMD API key"** (or
      equivalent `NoPermissions` error) — the surface is
      `errorMapping.ts:54` which returns
      `vscode.LanguageModelError.NoPermissions('Invalid OKMD API key')`,
      and Copilot renders `error.message` in the chat UI
- [ ] Restore the correct key with the same command; the next
      request succeeds

## 8. Cleanup

- [ ] Close the ExtDev Host
- [ ] Note any failures in the issue body, with the relevant
      Output Channel log line

---

## Troubleshooting

### "No OKMD in picker"

Run through this checklist in order. Each step is a single
hypothesis to rule out before moving to the next.

1. **Is the host signed in to Copilot?** Open Copilot Chat
   itself; if it shows a "sign in" prompt, do that first.
2. **Did activation complete?** Check the Output Channel — is
   there a `[activate:done]` line? If not, the activation
   crashed; check for `[ERROR]` lines.
3. **Is there a stale provider group?** Open
   `~/.config/Code/User/globalStorage` (or the platform
   equivalent) and look for a folder named like
   `github.copilot-*`. If `languageModels.json` in there
   references `okmd` with `models: []`, the activation-order
   race hit. Restart the host.
4. **Did the migration return `ok`?** The log should say
   `migration result: ok`. If it says `skipped`, the
   `lm.migrateLanguageModelsProviderGroup` command threw an
   "already exists" error — the provider group is registered
   but the API key is not. Re-run the
   `okmd.manageApiKey` command.
5. **Is the disk cache populated?** The log says
   `disk cache loaded: 0 models` on a fresh install — that is
   expected. After step 3 the cache should fill. If it stays at
   0, the network call is failing; check the Output Channel
   for `fetch failed` or `Model list refresh failed`.
6. **Is `provideLanguageModelChatInformation` returning
   anything?** The log line `[picker] returning N models`
   shows the count. If `N === 0` after the cache fills, the
   BYOK discriminator is rejecting the call. The log just
   before it should say `no apiKey yet` or
   `cache still empty after refresh — falling back to BUNDLED_FALLBACK_MODELS`.
7. **Run `Developer: Reload Window`** in the ExtDev Host, then
   re-run the picker check. If OKMD now appears, the original
   activation was a one-off race.

### "Picking a model does nothing"

The picker accepts the model but the chat UI does not send a
request. Likely cause: the model id (`okmd/<name>`) does not
match what the platform expects. Verify in the Output Channel
that `[picker] provideLanguageModelChatInformation called` fires
**and** that the returned `id` starts with `${PROVIDER_ID}/`
(see `src/provider.ts` `toChatInformation`).

### "Reply comes all at once, not streaming"

The SSE parser is not getting chunks. Check the Output Channel
for `[streaming]` lines. Likely cause: the OKMD endpoint is
returning a non-streaming response (it ignored the `stream: true`
flag). Compare with the OpenAI streaming contract in
[`src/streaming/openaiParser.ts`](../src/streaming/openaiParser.ts).

---

## Recording results

Tick the boxes above, paste any failure logs into the issue
body, and link the issue. Do **not** close the issue until all
sections pass on a clean rebuild.

**Milestone:** when filing results, tag the result with the
`picker-fix-2026q3` milestone (per
[docs/agents/issue-tracker.md](../../docs/agents/issue-tracker.md))
so that the smoke-test evidence rolls up under the same
release as the picker fix.
