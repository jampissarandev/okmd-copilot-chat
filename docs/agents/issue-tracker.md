# Issue tracker: GitHub

This repo uses **GitHub Issues** as its issue tracker. Skills like `to-tickets`,
`to-spec`, and `qa` will read from and write to GitHub via the `gh` CLI.

## Conventions

- One issue per unit of work (feature, bug, chore).
- Title format: `[<area>] <imperative summary>` — e.g. `[provider] handle
  Anthropic tool_use streaming`.
- Body: short context, the decision or behaviour change, acceptance criteria.
- Use the milestone field to group issues by release.

## PRs as a request surface

PRs are NOT in the triage queue. The skill will only consider issues, not PRs.

## Prerequisites

- `gh` CLI installed and authenticated (`gh auth status`).
- The local clone has a remote pointing at the GitHub repo.
- `gh repo view` works from the repo root.

If any of these are missing, the skill will fail with a clear error rather
than silently falling back.
