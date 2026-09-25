# Commits — English overview

> English navigation companion; the linked Chinese document is the canonical policy.

状态：`current` · 更新：2026-09-26 · 适用：English-speaking readers; the rules live in COMMITS.md.

The current, complete policy is [COMMITS.md](COMMITS.md). This overview does not define a second set of rules.

- Format: `<type>(<scope>): <Chinese subject>`, a body explaining why, what changed and how it was verified, and a closing `Refs #<issue>`. First line at most 72 characters, ASCII colon, no trailing period, no emoji.
- Types: `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `build`, `ci`, `chore`, `style`.
- Scopes: `control`, `console`, `node`, `runner`, `protocol`, `deploy`, `docs`, `notes`, `tooling`, `deps`, `release`, `security`. Pick the one that owns the change; `notes` is only for commits that add execution records under `notes/` alone (`docs(notes): …`, see [NOTES](NOTES.md)).
- One commit is one purpose that can be understood and reverted on its own; code, contract, tests and docs travel together. Breaking changes use `!` or a `BREAKING CHANGE:` body.
- A commit is not a release: versions and deployments follow [BRANCHING](BRANCHING.md) and [RELEASES](RELEASES.md), never the commit type. Agents do not create or push commits without explicit authorization.
