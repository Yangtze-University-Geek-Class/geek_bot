# 文档与规范总入口

> 所有项目规范集中在 docs；`docs/` 与 `app/`、`packages/` 严格对齐，根目录及工具文件只负责导航。

状态：`current` · 更新：2026-09-26 · 适用：全仓库

## AI 第一操作

Agent 进入仓库的第一件事是**确认当前分支**（`git branch --show-current`），第二件事是停止业务操作并完整读取 [AGENT-START](conventions/AGENT-START.md)、[PROJECT](conventions/PROJECT.md)、[BRANCHING](conventions/BRANCHING.md)、[CONTRIBUTING](conventions/CONTRIBUTING.md)、[CODE-REVIEW](conventions/CODE-REVIEW.md)、[RELEASES](conventions/RELEASES.md)、[TRACKING](conventions/TRACKING.md) 和任务适用文档，再开始实施。根 [AGENTS](../AGENTS.md) 保存硬门禁摘要；不能先执行再补读。

## 目录 ↔ docs ↔ 规范 地图

| 仓库路径 | `docs/` 路径 | 管辖规范 |
|---|---|---|
| `app/control/` | [services/control](services/control/README.md) | [MODULAR-DEVELOPMENT](conventions/MODULAR-DEVELOPMENT.md)、[SECURITY](architecture/SECURITY.md)、[API](architecture/API.md) |
| `app/console/` | [services/console](services/console/README.md) | [DESIGN](design/DESIGN.md)、[Tuffex 使用政策](components/tuffex/USAGE-POLICY.md)、[TESTING](conventions/TESTING.md) |
| `app/node/` | [services/node](services/node/README.md) | [SECURITY](architecture/SECURITY.md)、NODES（#11 写入） |
| `app/runner/` | [services/runner](services/runner/README.md) | [SECURITY](architecture/SECURITY.md)、[MODULAR-DEVELOPMENT](conventions/MODULAR-DEVELOPMENT.md) |
| `packages/protocol/` | [services/protocol](services/protocol/README.md) | [MODULAR-DEVELOPMENT](conventions/MODULAR-DEVELOPMENT.md)、[API](architecture/API.md)、[节点协议](services/node/protocol.md) |
| `deploy/`（计划中，#7 加入） | DEPLOY、ENVIRONMENTS（#7 写入）· [ops/CICD](ops/CICD.md) | [RELEASES](conventions/RELEASES.md)、[BRANCHING](conventions/BRANCHING.md) |
| `docs/`（本文档树） | [INDEX](INDEX.md)（生成物） | [DOCUMENTATION](conventions/DOCUMENTATION.md) |
| `scripts/`、`tests/` | [TESTING](conventions/TESTING.md) · [ops/LOCAL-DEV](ops/LOCAL-DEV.md) · [ops/CICD](ops/CICD.md) | [CONTRIBUTING](conventions/CONTRIBUTING.md)、[CODE-REVIEW](conventions/CODE-REVIEW.md) |
| `.github/`（工作流、issue 与 PR 模板、标签声明） | [ops/CICD](ops/CICD.md) | [ISSUES](conventions/ISSUES.md)、[PULL-REQUESTS](conventions/PULL-REQUESTS.md)、[TRACKING](conventions/TRACKING.md) |

**硬规则**：新增包 = 新增 `app/<name>` 或 `packages/<name>` + 新增 `docs/services/<name>/README.md`，两处缺一视为未完成（`pnpm check:docs` 强制）；模块细节放同目录子文档（见 [MODULAR-DEVELOPMENT](conventions/MODULAR-DEVELOPMENT.md) 与 [DOCUMENTATION](conventions/DOCUMENTATION.md)）。

## 阅读地图

| 主题 | 规范文档 |
|---|---|
| 分支模型、不变量、task worktree、合并后删分支 | [BRANCHING](conventions/BRANCHING.md) |
| diff 审查清单与结论格式 | [CODE-REVIEW](conventions/CODE-REVIEW.md)、[code-review 技能](../.agents/skills/code-review/SKILL.md) |
| 打 tag 发版、人工验收、版本展示、回滚 | [RELEASES](conventions/RELEASES.md)、[验收记录模板](ops/RELEASE-ACCEPTANCE-TEMPLATE.md) |
| 项目身份、范围、授权边界与完成定义 | [PROJECT](conventions/PROJECT.md) |
| agent 开工门禁 | [AGENT-START](conventions/AGENT-START.md) |
| 环境准备、开发与贡献流程 | [CONTRIBUTING](conventions/CONTRIBUTING.md)、[LOCAL-DEV](ops/LOCAL-DEV.md) |
| 提交格式与 scope | [COMMITS](conventions/COMMITS.md) |
| Issue（开发前必开）与 PR | [ISSUES](conventions/ISSUES.md)、[PULL-REQUESTS](conventions/PULL-REQUESTS.md) |
| issue ↔ 分支 ↔ PR 的生命周期、追踪记录格式 | [TRACKING](conventions/TRACKING.md)、[ADR-0010](decisions/0010-tracking-record-prefix.md) |
| 测试、隔离、验收证据 | [TESTING](conventions/TESTING.md) |
| 文档结构、状态词表与事实来源 | [DOCUMENTATION](conventions/DOCUMENTATION.md) |
| 包边界与模块拆分 | [MODULAR-DEVELOPMENT](conventions/MODULAR-DEVELOPMENT.md) |
| 官方标准、采用范围与核对日期 | [REFERENCES](conventions/REFERENCES.md) |
| 各包的契约与源码地图 | [services](services/README.md)：[control](services/control/README.md)、[console](services/console/README.md)、[node](services/node/README.md)、[runner](services/runner/README.md)、[protocol](services/protocol/README.md) |
| 系统架构（草案） | [architecture](architecture/README.md)、[ARCHITECTURE](architecture/ARCHITECTURE.md) |
| 安全不变量（草案） | [SECURITY](architecture/SECURITY.md) |
| API 契约及错误、幂等约定 | [API](architecture/API.md)、[节点协议](services/node/protocol.md) |
| 界面设计与技术栈 | [design](design/README.md)、[DESIGN](design/DESIGN.md)、[STACK](design/STACK.md) |
| Tuffex 组件文档、AI 检索与使用政策 | [components](components/README.md)、[Tuffex 文档库](components/tuffex/README.md)、[使用政策](components/tuffex/USAGE-POLICY.md) |
| 本机开发、`pnpm verify`、task worktree | [LOCAL-DEV](ops/LOCAL-DEV.md) |
| CI 工作流与仓库平台设置 | [CICD](ops/CICD.md) |
| 运维文档目录 | [ops](ops/README.md) |
| 部署、回滚、环境与 env 模板、主机前置条件、故障处理 | DEPLOY、ENVIRONMENTS、HOST-PREREQS（#7 写入）、RUNBOOK（#7 起草，#20 补全） |
| 加节点、槽位与节点健康 | NODES（#11 写入） |
| 备份与恢复演练、告警与观测 | BACKUP、OBSERVABILITY（#20 写入） |
| 架构决策 | [decisions](decisions/README.md)：[ADR-0001](decisions/0001-standalone-product.md)、[ADR-0010](decisions/0010-tracking-record-prefix.md)；ADR-0002 至 ADR-0009 见目录表 |

## 文档类别与优先级

`conventions/` 规定如何协作，`services/` 规定每个包的边界与实现位置，`architecture/` 描述系统设计，`design/` 规定交互与选型，`components/` 保存第三方组件参考，`ops/` 记录操作流程，`decisions/` 保存已接受的决策。

同一规则只在一个规范源定义，其余文档链接过去。状态词表只有 `current` / `accepted` / `proposed` / `historical`（见 [DOCUMENTATION](conventions/DOCUMENTATION.md)）：`historical` 与 `proposed` 文档不覆盖 current 规范，也不得被当作现行操作依据。还没实现的服务契约、架构和运维文档标 `proposed`，并写明由哪个 issue 实现。路由表和地图里列为「管辖规范」的 `proposed` 文档（例如 [SECURITY](architecture/SECURITY.md)）的含义是：它们是对应 issue 的实现目标，也是审查时不得放宽的基线（由 current 的 [CODE-REVIEW](conventions/CODE-REVIEW.md) 强制，放宽按阻塞处理）；它们不代表功能已经实现，不能拿来证明现状。代码与 current 文档不一致是缺陷，必须在改动中说明并同步修正；不能通过随意选择某份文档掩盖冲突。

仓库以后可能公开：任何文档都不写组织名、真实仓库名、内部主机、内网或组网地址、网关地址和真实账号，需要时写占位（见 [ADR-0001](decisions/0001-standalone-product.md)）；引用 issue 与 PR 一律写 `#n`。

完整目录见 [INDEX](INDEX.md)。索引由 `pnpm docs:index`（`node scripts/docs-index.mjs`）生成，不手工维护。文档标题、摘要、路径变更必须重新生成索引。英文首页见 [README.en.md](../README.en.md)。
