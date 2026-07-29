- Status: Accepted
- Date: 2026-07-29
- Supersedes: Story 20 of Spec 0001 ("system messages from Copilot to be forwarded to the OKMD API")
- Closes: #13

## Context

Spec 0001 Story 20 was written against the pre-1.104 `vscode.lm` API, where
`LanguageModelChatMessage` had a `System` role on `message.role`. The
pre-1.104 `openaiToAnthropic` converter split messages with role `System`
out of the `messages` array and into the Anthropic `body.system` string.
This matched the Anthropic `/messages` contract, which carries the system
prompt as a top-level field, not as a message.

When commit `f55c63c` (closes #2) aligned the extension to VS Code 1.104:

- `LanguageModelChatMessage` was renamed to `LanguageModelChatRequestMessage`.
- `LanguageModelChatMessageRole` was reduced from `{ User, Assistant, System }`
  to `{ User, Assistant }` only. Verified against `node_modules/@types/vscode/index.d.ts`:

  ```ts
  export enum LanguageModelChatMessageRole {
    User = 1,
    Assistant = 2
  }
  ```

- `ProvideLanguageModelChatResponseOptions` has `modelOptions` (model-specific),
  `tools`, and `toolMode`, but no top-level system-prompt field.

There is no remaining channel in 1.104 for Copilot to deliver a system
prompt to a BYOK provider.

## Decision

**Do not forward a system prompt in 1.104+.** The Anthropic request body
produced by `openaiToAnthropic` never sets `body.system`. Story 20 of
Spec 0001 is reclassified as **not implementable** until VS Code adds a
system-prompt channel to the `vscode.lm` contract.

Implications:

- Copilot's internal system prompts (e.g. "you are a coding assistant…")
  are not delivered to OKMD models through this extension. OKMD / Claude
  receives no `system` field and falls back to its own defaults.
- The OpenAI-compatible path is unaffected — OKMD's `/chat/completions`
  accepts `role: "system"` mixed into `messages`, but since the upstream
  provider never sends a System-role message to us, no such message
  appears on the wire.
- Story 21 ("image attachments in messages to be forwarded to OKMD with
  a log warning") is unchanged. Image data flows through
  `LanguageModelDataPart`, which is still part of the 1.104 contract.

## Consequences

Positive:

- Honest about a real gap in the contract. The previous code could
  pretend to support Story 20 only because the pre-1.104 types had a
  `System` role. After 1.104, that pretence is impossible.
- A future VS Code release that adds a system-prompt channel (e.g. a
  `system` field on `ProvideLanguageModelChatResponseOptions`) can be
  wired up in one place: the `openaiToAnthropic` converter. The rest of
  the stack does not need to know.

Negative:

- OKMD Claude models behave less helpfully than they could when Copilot
  would have set a system prompt. There is no workaround inside this
  extension; users who need the system prompt delivered have to switch
  to a different chat surface until VS Code adds the channel.
- The regression in commit `f55c63c` (the silent removal of the
  `body.system` branch) is now codified as the correct behaviour, not a
  bug. Issue #13 is therefore closed as `wontfix` rather than fixed.

## Alternatives considered

- **Always inject a hardcoded system string** ("You are a helpful
  assistant."). Rejected: this is not the system prompt Copilot would
  have sent, so it does not satisfy Story 20 — it just adds a different
  fixed prompt. Better to send nothing than the wrong thing.
- **Read system from `options.modelOptions?.system`** in 1.104.
  `modelOptions` is untyped (`{ [name: string]: any }`); no part of
  Copilot populates a `system` key today. Adding a private convention
  here would create a non-portable API between this extension and any
  future Copilot changes. Rejected.
- **Wait for a 1.105+ system-prompt channel and implement Story 20
  then.** Accepted as the long-term path. Tracked implicitly by the
  "not implementable" tag on Story 20.
- **Send a fake "system" message with role `user` instead of
  `body.system`.** Already what the buggy code does, after the
  refactor. Breaks Claude's expectation that `system` is a top-level
  field, not a message in the conversation. Rejected.

## References

- VS Code 1.104 `vscode.d.ts` — `LanguageModelChatMessageRole` and
  `ProvideLanguageModelChatResponseOptions` interfaces.
- Commit `f55c63c` (closes #2) — the refactor that exposed the gap.
- Issue #13 — the follow-up ticket that surfaced this ADR.
- Spec 0001, Story 20 — the story this ADR supersedes.
