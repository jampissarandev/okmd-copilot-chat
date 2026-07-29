# Domain docs: single-context

This repo has a single bounded context. Domain terminology lives in
**`CONTEXT.md`** at the repo root. Architecture decisions live in
**`docs/adr/`** as Markdown files named `NNNN-<slug>.md`.

## Reading order

When the skill is asked to ground itself in the domain, it reads in this order:

1. `CONTEXT.md` — the ubiquitous-language glossary. This is the first stop
   for any terminology question.
2. `docs/adr/` — read only the ADRs whose status is **Accepted** and whose
   scope overlaps the question. ADRs in other statuses (Proposed, Superseded)
   are historical context, not current truth.

## Writing rules

- `CONTEXT.md` is a **glossary**. Do not add implementation details,
  code snippets, or product specs there.
- Each new ADR adds value when it is **hard to reverse**, **surprising
  without context**, and **the result of a real trade-off**. Skip the ADR
  if any of those is missing.
- ADRs are append-only. Mark a changed decision as **Superseded** and write
  a new one; do not edit the old one in place.
