# Contributing — English overview

> English navigation companion; the linked Chinese document is the canonical policy.

状态：`current` · 更新：2026-09-26 · 适用：English-speaking readers; the rules live in CONTRIBUTING.md.

The current, complete policy is [CONTRIBUTING.md](CONTRIBUTING.md). This overview does not define a second set of rules.

- First run `git branch --show-current`, then read the documents listed in [AGENT-START](AGENT-START.md) before running anything.
- Node 22 (`>=22.13.0 <23`) and `pnpm@9.15.9`. Install with `pnpm install --frozen-lockfile`; enable the repository hooks with `pnpm hooks:enable`. `pnpm dev:console` (console sample-data mode, #4) and `pnpm dev:control` (local control plane with throwaway local keys, #3) run things locally; see [LOCAL-DEV](../ops/LOCAL-DEV.md).
- Open an issue first ([ISSUES](ISSUES.md)), then `node scripts/task.mjs start <issue> <slug>` creates `task/<issue>/<slug>` from `stage` in its own worktree. Open the PR against `stage` following [PULL-REQUESTS](PULL-REQUESTS.md); after the merge run `node scripts/task.mjs finish <issue>`.
- Record every step in `notes/<date>/<GitHub username>/<chain>.md` (Beijing time) following [NOTES](NOTES.md): `task.mjs start` / `finish` write the first and last entries and need an identity (`GEEK_NOTES_USER`, `GEEK_NOTES_BY`, or `--user` / `--by`); commits, the PR, reviews and rework are recorded with `node scripts/note.mjs add`. A task PR without its start, commit, PR and review entries fails CI.
- Before a PR: `pnpm verify` must pass, with real output in the PR. VM tests that need `/dev/kvm` are optional; if you did not run them, mark them as unverified (未验证) in the PR.
- Keep changes scoped, preserve other people's uncommitted work, and never commit secrets, tokens, organization names, internal hosts or network ranges.
- Real bot-account tokens and writes to real repositories are not part of normal contribution; they need the owner's explicit authorization for the specific repository, account and action. Committing, pushing, merging, tagging and deploying each need their own authorization.
