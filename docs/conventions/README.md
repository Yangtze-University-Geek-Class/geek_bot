# conventions/

> 强制遵守的协作规范：分支、审查、提交、Issue、PR、追踪记录、执行记录、发版、测试与文档。违反的改动会被 CODE-REVIEW 退回。

状态：`current` · 更新：2026-09-26 · 适用：本仓库的所有维护者、贡献者与 AI/Agent。

| 文件 | 什么时候读 |
|---|---|
| [`AGENT-START.md`](./AGENT-START.md) | 作为 AI/Agent 进入仓库的第一件事（确认分支 + 读规范） |
| [`PROJECT.md`](./PROJECT.md) | 确认产品身份、五个包、授权边界、公开就绪约束、完成定义与 agent 入口政策 |
| [`BRANCHING.md`](./BRANCHING.md) | 任何提交、推送、切分支之前；确认自己在 `main`/`stage`/`task/<issue>/<slug>` 上 |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | 第一次参与，或需要确认安装、分支、环境与沟通约定 |
| [`CODE-REVIEW.md`](./CODE-REVIEW.md) | 审查别人的 diff，或提交 PR 想合入 `stage` 之前 |
| [`RELEASES.md`](./RELEASES.md) | 打发布 tag、把 `main` 快进到被验收的提交、改版本号或准备部署之前 |
| [`TRACKING.md`](./TRACKING.md) | 在 issue 或 PR 上发任何进展、审查、返工、验收、关闭评论之前；恢复上下文时 |
| [`NOTES.md`](./NOTES.md) | 开工之前（设好身份）；每完成一步、每次提交、开 PR、收到审查、合并、发布、收尾时；恢复上下文时 |
| [`COMMITS.md`](./COMMITS.md) | 写 commit message 之前 |
| [`ISSUES.md`](./ISSUES.md) | 开 issue、分配 issue 或打 `bot:*` 标签之前（开发前必须先有 issue） |
| [`PULL-REQUESTS.md`](./PULL-REQUESTS.md) | 开 PR 之前；审查机器人开的 PR 之前 |
| [`TESTING.md`](./TESTING.md) | 写测试、报告验收结果之前 |
| [`MODULAR-DEVELOPMENT.md`](./MODULAR-DEVELOPMENT.md) | 新增包、跨包引用或改动依赖方向之前 |
| [`DOCUMENTATION.md`](./DOCUMENTATION.md) | 新增或移动文档、同步路径、改状态标注之前 |
| [`REFERENCES.md`](./REFERENCES.md) | 需要外部依据或核对采用范围时 |

英文导航概要：[COMMITS.en](./COMMITS.en.md)、[CONTRIBUTING.en](./CONTRIBUTING.en.md)、[ISSUES.en](./ISSUES.en.md)、[PULL-REQUESTS.en](./PULL-REQUESTS.en.md)。它们只做导航，规则以中文版为准。

这些规范是**强制**的。根 [AGENTS.md](../../AGENTS.md) §0 把 AGENT-START、PROJECT、BRANCHING、CONTRIBUTING、CODE-REVIEW、RELEASES、TRACKING、NOTES 列为首步必读，其余按 [AGENT-START](AGENT-START.md) 的任务表读取；改某项内容前必须先读对应那篇。服务级文档见 [docs/services](../services/README.md)。
