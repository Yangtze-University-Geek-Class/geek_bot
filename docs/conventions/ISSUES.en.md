# Issues — English overview

> English navigation companion; the linked Chinese document is the canonical policy.

状态：`current` · 更新：2026-09-25 · 适用：English-speaking readers; the rules live in ISSUES.md.

The current, complete policy is [ISSUES.md](ISSUES.md). This overview does not define a second set of rules.

- Every `task/<issue>/<slug>` branch needs an issue first, urgent fixes included: open a one-line issue, start with `node scripts/task.mjs start <issue> <slug>`, and fill in the body later. Search existing issues (including closed ones) before opening a new one; one issue describes one thing that can be accepted on its own.
- Title: `<module>：<symptom or request>`, where the module is the 端 (side) value, one of `control`, `console`, `node`, `runner`, `protocol`, `deploy`, `docs`, `tooling` (the same values as the issue form and the labels).
- Bugs state the symptom, reproduction steps, expected result, impact, environment (branch and full SHA, instance version, deployment), evidence and acceptance criteria. Never paste tokens, sessions, private repository content or internal addresses.
- Progress is recorded as tracking comments ([TRACKING](TRACKING.md)). Merging the PR into `stage` closes the issue automatically.
- Assignment and the bot: assign the issue to the bot account to have the bot take it first; assign it to a person, or add `bot:manual`, and the bot stays out. `bot:blocked` means the bot has asked a question and is waiting for a reply. The full default behavior lives in the [control service contract](../services/control/README.md).
- Report security problems privately, never in an issue, PR or comment. There is no formal private channel yet (`SECURITY.md` and GitHub private vulnerability reporting arrive with #21); until then, contact the repository owner directly.
