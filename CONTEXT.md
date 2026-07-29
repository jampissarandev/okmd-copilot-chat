# OKMD for Copilot Chat — Domain Glossary

This document defines the **ubiquitous language** for the project. Use these
terms exactly as defined when discussing features, writing code, or writing
documentation. If a term needs to change, update this file inline.

---

## Provider

The organization that supplies AI models. In this extension, the only
**Provider** is **OKMD** (สำนักงานบริหารและพัฒนาองค์ความรู้). The display name
in the Copilot Chat model picker is "OKMD".

The provider name is a single string, not a list — the extension is single-tenant
with respect to the upstream service.

## Model

A specific AI model exposed by OKMD, identified by both:

- A human-readable **name** (e.g. `claude-sonnet-4`) — shown in the picker
- A numeric **id** (e.g. `1`) — used in the API request body

The extension owns the mapping from name to id at runtime (see ADR-0002).
The picker shows the **name**; the API receives the **id**.

## Model Family

A grouping of models by capability. In v1 there is one family:

- **All** — every model returned by `/models`

Tool-capable models are flagged via `LanguageModelChatInformation.capabilities`,
not via a separate picker entry. The picker does not change based on family
(decision 15).

## Endpoint

The HTTP route used to call the API. In v1 the extension uses two endpoints:

- `POST /chat/completions` — OpenAI-compatible, used for non-Claude models
- `POST /messages` — Anthropic-compatible, used for `claude-*` models

Routing is decided by the `modelCapabilities` lookup table (decision 31), not
by a hardcoded prefix in code. The picker does not expose the endpoint concept
to the user (decision 14).

## Tool-Capable

A model that supports function/tool calling. Determined in v1 by a hardcoded
whitelist embedded in source. Future versions may read this from
`/models` response metadata or use a runtime probe via the
`OKMD: Refresh Tool Capability` command.

If a non-whitelisted model is requested in Copilot's Agent mode, the picker
will hide it from that mode but still allow it in plain chat.

## API Key

The user's personal OKMD API key. Acquired and stored via VS Code's
`vscode.lm` provider configuration flow: **Copilot Chat → Manage Models →
OKMD → paste key**. The extension does not provide a command-palette setter.

The extension reads the key on demand and caches it in memory; the cache is
invalidated on a 401 response (see ADR-0002 for the related decision).

## Reasoning / Thinking

Claude's extended thinking feature, exposed by OKMD's `/messages` endpoint.
**Not supported in v1** (decision 17). The `/chat/completions` endpoint
cannot forward thinking parameters. If `reasoning` arrives in a response, it
is logged to the Output Channel and dropped.
## System Prompt

In the pre-1.104 `vscode.lm` API, providers could read a `System`-role
message from Copilot and forward it to the model. In VS Code 1.104+
(`LanguageModelChatRequestMessage` and
`LanguageModelChatMessageRole = { User, Assistant }`), **no system-prompt
channel exists** between Copilot and a BYOK provider. The OKMD extension
therefore does not populate the Anthropic `body.system` field. See
ADR-0004. This is an upstream-API gap, not a bug in this extension.
