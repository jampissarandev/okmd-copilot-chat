# Specs

This directory holds spec documents (sometimes called PRDs) for features
that cross multiple issues or that need shared context beyond a single
ticket.

- [0001 — OKMD for Copilot Chat](0001-okmd-provider.md) — the BYOK
  provider for OKMD AI models in GitHub Copilot Chat.

## Conventions

- One spec per feature. The filename is `NNNN-<kebab-case-slug>.md`.
- The status of a spec is informal: it is either **active** (the team
  is still building toward it) or **shipped** (the feature exists in
  the published extension).
- A spec is the input to `/to-tickets`, which produces a sequence of
  blocking-edge tickets in the issue tracker. Once tickets exist, the
  spec becomes a navigation aid rather than a source of truth.
- Do not edit a spec in place after tickets have been cut. If the
  feature changes, write an ADR for the new decision and link it from
  the spec.
