# OKMD for Copilot Chat

Use [OKMD AI Playground](https://playground.okmd.or.th/) models directly inside
VS Code's GitHub Copilot Chat. The extension registers an OKMD provider with
Copilot Chat so that all OKMD models appear in the model picker.

## Requirements

- VS Code **1.104.0** or later
- GitHub Copilot Chat extension installed and active
- An OKMD API key from [playground.okmd.or.th](https://playground.okmd.or.th/) → API Platform

## Setup

1. Open **Copilot Chat** in VS Code.
2. Open the model picker and choose **Manage Models**.
3. Add **OKMD** and paste your API key.
4. Pick an OKMD model from the picker and start chatting.

You do not need to run any command to set the key — VS Code stores it securely
through the Copilot provider configuration flow.

## Supported Models

The extension dynamically fetches the model list from
`https://gen.ai.kku.ac.th/okmd/api/v1/models`. It does not ship a hardcoded
fallback catalog. Models with names starting with `claude-` are routed to
OKMD's Anthropic-compatible `/messages` endpoint; all other models use the
OpenAI-compatible `/chat/completions` endpoint.

Tool-capable models are flagged in the picker. The v1 whitelist is hardcoded
in `src/constants.ts`; future versions will read this from `/models` metadata
or use a runtime probe.

## Usage

1. Open Copilot Chat (`Ctrl+Alt+I` / `Cmd+Alt+I`).
2. Pick an OKMD model.
3. Send a message.

Available commands:

| Command | Description |
| --- | --- |
| `OKMD: Refresh Model List` | Force-refresh the cached model list from OKMD |
| `OKMD: Refresh Tool Capability` | Re-emit the tool-capable whitelist (v1 placeholder) |
| `OKMD: Show Logs` | Open the Output Channel for diagnostics |

## Development

```sh
bun install --ignore-scripts
bun run compile
bun run lint
bun run test -- --runInBand
```

Press `F5` in VS Code to launch the Extension Development Host.

## Architecture

See [`CONTEXT.md`](CONTEXT.md) for the domain glossary and
[`docs/adr/`](docs/adr/) for the architecture decision records:

- [ADR-0001](docs/adr/0001-mixed-endpoint-routing.md) — Mixed-endpoint routing
- [ADR-0002](docs/adr/0002-id-mapping-lookup.md) — Picker ID and runtime name-to-id lookup
- [ADR-0003](docs/adr/0003-model-list-cache.md) — Model list cache in `globalState`

## Privacy

- Your API key is stored by VS Code's `vscode.lm` provider configuration.
- Chat completions and model discovery requests are sent to
  `https://gen.ai.kku.ac.th/okmd/api/v1`.
- The extension does not send telemetry anywhere.

## License

[MIT](LICENSE)
