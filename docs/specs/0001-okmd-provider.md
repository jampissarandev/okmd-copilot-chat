# Spec 0001: OKMD for Copilot Chat

## Problem Statement

Users of the [OKMD AI Playground](https://playground.okmd.or.th/) who also
use VS Code's GitHub Copilot Chat have to switch between two interfaces
when they want to chat with an OKMD model. They must open the OKMD web
playground in a browser, copy the model output, and paste it back into their
editor. This breaks flow, especially when iterating on code.

The same users already pay for an OKMD API quota, but cannot put that quota
behind VS Code's Copilot Chat, which is where their day-to-day AI work
happens.

## Solution

Ship a VS Code extension that registers OKMD as a **BYOK language model
provider** for GitHub Copilot Chat. Once installed, every model exposed by
OKMD's `/models` endpoint appears in the Copilot Chat model picker. The
extension proxies chat completions to the OKMD API in the background.

The user installs the extension, enters their API key through the standard
Copilot provider-management flow, and immediately sees OKMD models in the
picker. There is no separate command palette for key management in v1.

## User Stories

1. As a Copilot Chat user with an OKMD API key, I want OKMD models to
   appear in the model picker, so that I can choose them like any other
   Copilot model.
2. As a Copilot Chat user, I want to see the OKMD model name in the picker,
   not a number or a code, so that I can pick the right model intuitively.
3. As a Copilot Chat user, I want my OKMD API key to be stored securely by
   VS Code, so that I do not have to enter it on every restart.
4. As a Copilot Chat user, I want to enter my OKMD API key through the
   standard Copilot provider-management UI, so that the workflow is the
   same as for any other BYOK provider.
5. As a Copilot Chat user, I want streaming text responses from OKMD models,
   so that the UX feels the same as built-in Copilot models.
6. As a Copilot Chat user in Agent mode, I want to see only tool-capable
   OKMD models when I open the picker in Agent mode, so that I do not pick
   a model that fails on tool calls.
7. As a Copilot Chat user, I want to use Claude models through OKMD and
   get the same UX as other models, so that I have a consistent experience
   across model families.
8. As a Copilot Chat user who picked a Claude model, I want the extension
   to call the right OKMD endpoint behind the scenes, so that I do not
   have to know about endpoint differences.
9. As a Copilot Chat user on a flaky network, I want the extension to
   retry once on a transient failure, so that one bad packet does not
   kill my chat.
10. As a Copilot Chat user, I want to cancel a long-running response and
    have the network request stop, so that I do not burn quota on a
    response I no longer need.
11. As a Copilot Chat user who is offline, I want the previously known
    OKMD models to still appear in the picker, so that the extension is
    not useless on a plane.
12. As a Copilot Chat user, I want the model list to refresh automatically
    once an hour, so that I do not have to remember to update it manually.
13. As a Copilot Chat user, I want a manual "Refresh Model List" command,
    so that I can force a refresh when I suspect the list is stale.
14. As a Copilot Chat user, I want to see error messages from OKMD in a
    readable form, so that I can fix the problem (e.g. add funds, fix the
    key) instead of seeing an opaque network error.
15. As a Copilot Chat user, I want to see the extension's logs through a
    command, so that I can debug a problem without opening the developer
    tools.
16. As a Copilot Chat user, I want the extension to log unusual responses
    to the Output Channel, so that future versions can improve from real
    data.
17. As a Copilot Chat user in Agent mode, I want tool-call responses from
    OKMD models to be handled correctly, so that Agent can use Claude or
    GPT models through OKMD without errors.
18. As a Copilot Chat user, I want the model display name to follow the
    `<name> (OKMD)` convention, so that the source of the model is clear
    in the picker.
19. As a Copilot Chat user, I want responses to time out after 60 seconds,
    so that a hung OKMD server does not lock up my chat.
20. As a Copilot Chat user, I want system messages from Copilot to be
    forwarded to the OKMD API, so that Copilot's internal prompts still
    work.

    **Not implementable in 1.104+.** VS Code 1.104's `vscode.lm` contract
    exposes only `User` and `Assistant` roles on
    `LanguageModelChatRequestMessage.role`; there is no system-message
    channel from Copilot to the provider. See ADR-0004. Future versions
    may add a system-prompt field; until then, Anthropic models served via
    this extension receive no `system` field. Documented here so the gap is
    visible — not silently dropped.
21. As a Copilot Chat user, I want image attachments in messages to be
    forwarded to OKMD with a log warning, so that I find out if a model
    supports images without silent failure.
22. As a VS Code marketplace browser, I want to see clear documentation
    about the extension's setup, supported models, and architecture, so
    that I can decide whether to install it.

## Implementation Decisions

### Provider registration

- The extension registers as a VS Code language model provider through
  `vscode.lm.registerLanguageModelChatProvider`, under the provider id
  `okmd`. Activation is lazy: the extension only loads when Copilot Chat
  needs the OKMD provider.
- Each model is registered with an id shaped `okmd/<okmd-name>`, so that
  it cannot collide with ids from other providers. See ADR-0002.
- The display name of each model is `<okmd-name> (OKMD)`, e.g.
  `claude-sonnet-4 (OKMD)`. See decision 16.
- The provider is **global** — registered once per VS Code, available in
  every workspace. See decision 11.

### Model discovery and routing

- The extension fetches the model catalog from `GET /models` on the OKMD
  API. The response is cached in `globalState` for one hour, with a
  manual `OKMD: Refresh Model List` command to force a refresh. See
  ADR-0003.
- A `Map<string, number>` translates each OKMD name to its numeric id,
  rebuilt on every successful `/models` fetch. The map is in-memory
  only and is repopulated on activation. See ADR-0002.
- A model-capability table decides, per model name, which OKMD endpoint
  is used:
  - `claude-*` → Anthropic-compatible `/messages`
  - everything else → OpenAI-compatible `/chat/completions`
  The default is OpenAI-compatible. See ADR-0001.
- The capability table also decides whether a model is marked
  `toolCalling: true` in `LanguageModelChatInformation`. The v1 source of
  truth is a hardcoded whitelist in `constants.ts`. The
  `OKMD: Refresh Tool Capability` command is reserved for a future
  runtime-probe implementation but is a no-op in v1.

### Request lifecycle

- On every chat request, the extension reads the API key from VS Code's
  provider credentials. The key is cached in memory and invalidated when
  the upstream returns 401. See decision 12.
- The request body is built per endpoint:
  - For OpenAI-compatible models, `vscode.lm` messages are forwarded with
    minimal restructuring.
  - For Anthropic-compatible models, the OpenAI-shaped messages are
    converted to Anthropic shape (message content becomes a string or
    content blocks). The Anthropic `system` field is **not** populated —
    see ADR-0004 for the reason. See decision 33.
- Forwarded body parameters are filtered per endpoint. The OpenAI
  endpoint receives `temperature`, `max_tokens`, `stream`. The Anthropic
  endpoint receives `temperature`, `max_tokens`, `top_p`, `top_k`,
  `stop_sequences`, `thinking`, `tools`, `tool_choice`, `stream`. See
  decision 38.
- The request always sets `stream: true` and returns an async iterable of
  response parts. Text parts are streamed chunk-by-chunk; tool-call parts
  are emitted at the end of the stream, parsed from accumulated chunks.
  See decision 8.
- The HTTP client enforces a 60-second read timeout per attempt and
  retries once on 5xx or network error with a 1-second back-off. See
  decisions 36 and 37.
- The `CancellationToken` from `vscode.lm` is forwarded to an
  `AbortController` so that the user can stop a response and free the
  HTTP request immediately. See decision 9.

### Error handling

- HTTP errors are mapped to `vscode.LanguageModelError` variants by
  status code first, then by parsing the response body for known
  keywords (`Invalid API key`, `Invalid model`, `reached daily limit`,
  `messages is required`). OKMD quirk: many distinct failure modes
  return 401; the keyword parse disambiguates them. See decision 13.
- All non-2xx responses are logged to the Output Channel with a 500-char
  preview of the body.

### Authentication storage

- v1 stores the API key exclusively through VS Code's `vscode.lm`
  provider configuration. There is no command-palette key setter and no
  `SecretStorage` access. See decision 6 (option B).
- The extension reads the key from the provider configuration on demand
  and never persists it to its own storage.

### Unsupported features in v1

- Thinking / extended reasoning is not requested from Claude. The
  `/chat/completions` endpoint cannot forward the `thinking` parameter,
  and the v1 strategy is to use the OpenAI endpoint for everything except
  models explicitly routed to `/messages`. See decision 17.
- Daily-quota tracking is not exposed in the UI. If OKMD returns a
  quota-exhausted error, the error is surfaced to the user through
  `LanguageModelError.Blocked`. See decision 7.
- The `OKMD: Refresh Tool Capability` command is a placeholder that
  confirms the whitelist, not a real probe. See decision 3.
- No per-workspace model configuration. The model list is global. See
  decision 11.

## Testing Decisions

- **What makes a good test**: assert the externally observable contract
  of a unit — the request body shape sent to `fetch`, the response
  parts emitted from a parser, or the error type returned from a
  mapper. Do not assert on internal state, private fields, or call
  order unless that order is itself part of the contract.
- **Modules to test in v1** (unit-level, no VS Code runtime):
  - `okmdClient.postOkmd` — request URL, headers, body, retry behavior,
    timeout. Use a `fetch` mock.
  - `parseOpenAiStream` — feed a fake `ReadableStream<Uint8Array>` of
    SSE bytes, assert the `LanguageModelTextPart` and
    `LanguageModelToolCallPart` sequence.
  - `parseAnthropicStream` — same, with Anthropic-shaped SSE events.
  - `openaiToAnthropic` — snapshot the converted body for representative
    inputs (pure system prompt, mixed system+user, image content, multiple
    system messages).
  - `getCapabilities` — table-driven test of name → endpoint +
    toolCalling flag.
  - `mapHttpError` (when extracted from `provider.ts`) — table-driven
    test of status × body keyword → `LanguageModelError` variant.
- **Modules NOT to test in v1**:
  - `OkmdChatProvider.provideLanguageModelChatResponse` — requires the
    VS Code test runner and an Extension Development Host. Belongs in a
    v2 integration-test suite.
  - `ModelCache.activate` / `refresh` — requires `globalState`, which
    is a VS Code API. Test through a thin adapter in v2.
- **Prior art**: the reference project
  [hidenobunagai/nvidia-nim-provider](https://github.com/hidenobunagai/nvidia-nim-provider)
  uses Jest with `ts-jest` and a `__mocks__/` directory. v1 follows the
  same shape, with the addition of `ReadableStream`-friendly parser
  tests.

## Out of Scope

- Distribution through the VS Code Marketplace (the build is packaged
  as a `.vsix`, but publishing is left to the user).
- Quota tracking, daily-limit warnings, or any proactive quota UI.
- Thinking / extended-reasoning parameter forwarding.
- Routing Claude traffic through Anthropic's native SDK (we use the
  OpenAI-shaped converter).
- Local fine-tuning or self-hosted OKMD instances (the API base URL is
  hardcoded; not configurable in v1).
- Per-workspace model lists or per-workspace API keys.
- Native Anthropic / OpenAI SDKs — we use raw `fetch` and SSE parsing
  to keep dependencies minimal and the bundle small.

## Further Notes

- The extension name and publisher in `package.json` are
  `okmd-for-copilot-chat` and `JamPissaran` respectively. Display name
  in the Marketplace: "OKMD for Copilot Chat".
- The minimum supported VS Code version is `1.104.0` because
  `vscode.lm.registerLanguageModelChatProvider` and the
  provider-management UI require it.
- The OKMD API base URL is hardcoded as
  `https://gen.ai.kku.ac.th/okmd/api/v1`. If OKMD publishes a different
  base URL in the future, the change is one line in `constants.ts`.
- The extension depends only on the runtime fetch, so the bundle ships
  with zero third-party runtime dependencies.
- The four existing ADRs (mixed-endpoint routing, id-mapping lookup,
  model-list cache, no-system-prompt-channel) define the highest-risk
  decisions in the design. Future changes to those areas must update or
  supersede the ADRs.
