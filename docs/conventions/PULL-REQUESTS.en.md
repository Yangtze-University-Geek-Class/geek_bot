# Pull Requests — English overview

> English navigation companion; the linked Chinese document is the canonical policy.

状态：`current` · 更新：2026-09-26 · 适用：English-speaking readers; the rules live in PULL-REQUESTS.md.

The current, complete policy is [PULL-REQUESTS.md](PULL-REQUESTS.md). This overview does not define a second set of rules.

- PRs target `stage` only. One issue, one `task/<issue>/<slug>` branch, one PR; merging does not deploy.
- The body starts from `.github/pull_request_template.md` and keeps all nine `###` sections with their Chinese names verbatim: 目的, 关联, 变更范围, 解决链路, 验证命令与结果, 验收证据, 人工验收步骤, 审查结论, 风险与回滚. The CI check `pr-contract` requires `Closes #<issue>` matching the branch number, non-empty sections, evidence (or `无界面变化：<reason>`), and a `**结论：通过**` / `**结论：有条件通过**` / `**结论：阻塞**` line on its own (lines inside HTML comments or code blocks do not count; the same applies to `Closes #<issue>`).
- The repository may become public: evidence must not show private target repositories, tokens, internal addresses or real account names.
- PRs opened by the bot account always end the review section with `**结论：阻塞**` until a human reviewer rewrites it. The bot only posts `COMMENT` reviews and never approves or merges.
- `pnpm verify` must pass. A task PR also needs a complete execution-record chain in `notes/` with start, commit, PR and review entries referencing its issue, and new entries added by the PR itself (CI `branch-guard`, see [NOTES](NOTES.md)). Merging, releasing and deploying are separate authorized actions.
