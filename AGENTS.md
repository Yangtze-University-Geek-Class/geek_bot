# Agent entry point — geek_bot

> 本文件是仓库唯一的 agent 入口，只写规范与硬门禁。规则正文全部在 `docs/`，这里不写教程、不复制第二套规则。

状态：`current` · 更新：2026-09-26 · 适用：进入本仓库的所有维护者与 agent

## 0. 首步门禁：先确认分支，再读完规范

**AI / Agent 进入本仓库的第一件事是 `git branch --show-current`，然后按顺序读完下面这些文档；没读完不许动手。**

1. [docs 总入口](docs/README.md)
2. [AGENT-START](docs/conventions/AGENT-START.md)
3. [PROJECT](docs/conventions/PROJECT.md)
4. [BRANCHING](docs/conventions/BRANCHING.md)
5. [CONTRIBUTING](docs/conventions/CONTRIBUTING.md)
6. [CODE-REVIEW](docs/conventions/CODE-REVIEW.md)
7. [RELEASES](docs/conventions/RELEASES.md)
8. [TRACKING](docs/conventions/TRACKING.md)
9. [NOTES](docs/conventions/NOTES.md)

再按任务读取适用规范与服务契约（`docs/services/` 下的服务文档、[TESTING](docs/conventions/TESTING.md)、安全与运维文档等）。

读完之前禁止：编辑文件、安装依赖、执行项目脚本、操作业务数据、启动或停止服务、任何 Git 写操作（提交、推送、切分支、建分支、合并）。只允许读规范必需的只读操作：`git branch --show-current`、`git status`、读取文档。

文档被截断就继续读到完整；文件缺失、读不到或规范互相冲突时停下来报告阻塞，不凭记忆继续。上下文压缩或恢复后同样适用。

## 1. 分支硬门禁

**长期分支只有两条：`main`（正式）与 `stage`（预发布）；其余分支必须是短生命周期。**

- `stage` 必须包含 `main`：`git merge-base --is-ancestor origin/main origin/stage` 必须成功；`main` 不得领先 `stage`，写进 `main` 的提交必须已经存在于 `stage`。
- 禁止直接向 `main` 提交或推送；`main` 只能由 `stage` 合并进入。
- 分支名一律不用 `-`，只用 `/` 分层，段内多词用 `_`（正则见 [BRANCHING](docs/conventions/BRANCHING.md)）。
- 任务分支命名 `task/<issue>/<slug>`（例 `task/12/review_queue`），**只能从 `stage` 拉出**；PR 合并后必须立即删除，不得残留死分支。
- `dev/<github-username>`（例 `dev/alice`）是个人自由开发区，不作为进入 `stage` 的凭据，也不部署。
- 推送分支不部署：push `stage`/`main` 只跑 CI。发版只靠打 tag：`vX.Y.Z-rc.N` 打在 `stage` 的提交上 → 预发布实例；`vX.Y.Z` 打在 `main` 的同一提交上 → 正式实例。本机 localhost 只是本地开发，不是预发布。
- 规则存在不等于远程保护已生效：本仓库是免费计划下的私有仓库，GitHub 不提供分支保护、rulesets 和 Environments（见 [CICD](docs/ops/CICD.md)）。分支不变量由两道机器检查核对：本地 pre-push 钩子（`pnpm hooks:enable`）和 CI 的 `branch-guard`；合并前再由审查者和 `issue-lifecycle` 的 `pr-base`（PR 只能指向 `stage`）、`pr-contract` 把关。部署文件齐全也不代表实例、CI 或部署已经落地。

细节见 [BRANCHING](docs/conventions/BRANCHING.md)。

## 2. 工作流硬门禁

**先 issue → 从 `stage` 拉 task 分支 → PR 回 `stage` → 在 `stage` 的提交上打 `vX.Y.Z-rc.N` 发预发布 → 所有者验收 → `main` 快进到同一提交 → 打 `vX.Y.Z` 发正式。**

- **一件事 = 一个 issue = 一个 `task/<issue>/<slug>` 分支 = 一个 git worktree = 一个 PR**，生命周期跟着 issue 走（[TRACKING](docs/conventions/TRACKING.md)）。开工用 `node scripts/task.mjs start <issue> <slug>` 从最新 `stage` 建分支和独立 worktree，所有开发都在 worktree 里做，不在主工作区切分支；合并后 `node scripts/task.mjs finish <issue>` 删 worktree 与本地分支（[BRANCHING](docs/conventions/BRANCHING.md)「task worktree」）。开发前先按 [ISSUES](docs/conventions/ISSUES.md) 开 issue；PR 按 [PULL-REQUESTS](docs/conventions/PULL-REQUESTS.md) 的正文契约写（`Closes #<issue>`、解决链路、验收证据截图 / 录屏、人工验收步骤），CI 的 `pr-contract` 核对；**合并进 `stage` 即删分支、关 issue**，issue 与 PR 两边都要留记录。
- 每个阶段的进展按 [TRACKING](docs/conventions/TRACKING.md) 的「追踪记录」格式写成 issue / PR 评论，记录头是 `<!-- track v1 kind=<类型> stage=<阶段> -->`（[ADR-0010](docs/decisions/0010-tracking-record-prefix.md)）；恢复上下文先读 issue 正文和最后几条追踪记录，不凭记忆续做。
- **执行记录前后必须写**（[NOTES](docs/conventions/NOTES.md)）：每一步按北京时间记进 `notes/<日期>/<GitHub 用户名>/<链路>.md`，入口是 `notes/INDEX.md`。开发前由 `task.mjs start` 记「开工」（要带 `GEEK_NOTES_USER` 与 `GEEK_NOTES_BY` 身份），开发中每次提交、开 PR、审查、返工都记，合并、发布、验收照记，`task.mjs finish` 记「收尾」。task PR 的链路缺「开工」「提交」「PR」「审查」时 CI 的 `branch-guard` 不通过，不能合并。
- 任何进入 `stage` 的内容必须走 [CODE-REVIEW](docs/conventions/CODE-REVIEW.md)：按 [code-review 技能](.agents/skills/code-review/SKILL.md) 逐项核对 diff，并把审查结论贴进 PR。**没有审查结论的 PR 不允许合并。**
- 进入 `main` 和打正式 tag 前，必须有所有者在预发布实例对同一提交的真实验收记录；自动化 PASS 只是机器验证，不能代替人工验证。
- 提交信息只遵循 [COMMITS](docs/conventions/COMMITS.md)；提交、推送、合并、打 tag、部署分别需要对应授权。发版流程、tag 规则与回滚见 [RELEASES](docs/conventions/RELEASES.md)。

## 3. 部署硬门禁

**只用 Docker。控制面每个环境一套完整 Docker 栈：`preview`（预发布实例）与 `production`（正式实例），各自 compose 项目、网络、卷，互不共享数据；工作节点另跑 node 栈，不算在这两套里。**

- 部署文件（compose、env 模板、部署与回滚脚本、`release.yml`）随 #7 加入。在那之前仓库里没有可部署的东西，任何人都不部署。
- 环境变量只走 `deploy/env/.env.production` / `deploy/env/.env.preview`（随 #7 加入），由 `docker compose --env-file` 消费；不得另建环境文件或在别处定义第二份环境变量。根 `.env.example` 只用于本机开发。
- **env 模板只放占位符和通用默认值**：实例的真实非密值（origin、主机、端口、路径）只在目标机的 `.env.<环境>` 里；**密钥一律用 `*_FILE` 指向目标机上的密钥文件，模板里的密钥项只能留空或写 `*_FILE` 路径**。理由（[ADR-0001](docs/decisions/0001-standalone-product.md)）：仓库以后可能公开，模板随仓库公开、也会被每个部署者原样拿去用，写进实例值就等于公开内部主机和网段；免费计划的私有仓库也没有 Environments，CI 没法按环境填值。#22 第 3 项按推荐推进（所有者未提出修改），#1 的 PR 里再请所有者确认一次。
- 密钥不得入库、不得进镜像、不得进日志或发布记录。
- CI 只构建和推镜像，不部署：发布 tag 触发 `release.yml`（随 #7 加入），`vX.Y.Z-rc.N` 构建一次并推到 ghcr，`vX.Y.Z` 给同一 digest 加别名、不重新构建。部署由维护者在所有者授权后到目标机运行部署脚本，按 digest 拉取。
- AI 不得自行部署，不得创建/推送/移动/删除发布 tag，不得修改版本号、镜像 tag 或 digest，不得触发流水线。
- 发布 tag 不可移动、不可删除；创建发布 tag 需要所有者对该版本的明确授权，正式 tag 还需要所有者对同一提交的预发布验收记录。
- 禁止用 systemd、pm2 或手工 `node` 进程替代 Docker 栈；禁止在目标机手工修改运行中的栈。

## 4. 证据硬门禁

- 每个改动都要有可复现的验证证据（命令 + 真实输出）；没验证就写「未验证」，不得写「应该没问题」。
- 未验证项必须在 PR 和审查结论里显式列出；未完成的环境验收不得标为 PASS。
- 类型检查、构建成功、mock 预览、浏览器验证、线上验收是不同证据，不能互相替代。见 [TESTING](docs/conventions/TESTING.md)。

## 5. 禁止事项（黑名单）

- 没读完第 0 节的规范就开始开发、安装依赖、跑脚本或操作数据。
- 在 `main` 上直接提交/推送，或让 task/dev 分支直接进 `main`。
- task 分支合并后残留死分支或死 worktree，或新建 `main`/`stage` 之外的长期分支。
- 在主工作区里切 task 分支开发，或在同一个 worktree 里做两个 issue。
- 把真实密钥、令牌、生产数据或完整 `.env` 写进仓库、镜像、日志、PR。
- 绕过或放宽 CI 与校验：`|| true`、`continue-on-error`、`[skip ci]`、删断言、改校验器、放宽既有校验来换绿色。
- 删除、覆盖或 reset 他人未提交的工作；在脏工作区自行 `reset`/`clean`/切分支。
- 用 systemd、pm2、手工进程替代 Docker 栈部署，或手工改目标机运行中的栈。
- 把 `proposed`/`historical` 文档当现行规范执行；规范冲突时自己挑一份照做而不报告。`proposed` 的架构、安全不变量和服务契约只是实现目标和审查时不得放宽的基线，不能拿来证明功能已经实现（见 [docs 总入口](docs/README.md)「文档类别与优先级」）。
- 伪造审查结论、验收证据、测试结果或审批记录。
- 不写执行记录就开发、合并或发布；改写、删除已写的记录，手填时间，或补写没发生过的事。
- 未经所有者授权创建或推送发布 tag，或者移动、删除已推送的发布 tag。
- 在代码、文档、测试或夹具里写死组织名、真实仓库名、内部主机、内网或组网网段、网关地址或真实账号（唯一的例外是 `notes/` 里负责人的 GitHub 用户名，见 [NOTES](docs/conventions/NOTES.md) §7）；需要时写 `<owner>`、`<org>/<repo>`、`https://geek-bot.example.com`、`203.0.113.10` 这类占位。`pnpm check:public-safety` 只拦截已登记的地址段、主机名形式和被禁词哈希，通过不等于没有泄漏，审查时逐句看新增字符串（[CODE-REVIEW](docs/conventions/CODE-REVIEW.md) 第 9 项）。
- 放宽 publisher 的 GitHub 写入白名单或机器人令牌的权限范围，却不按阻塞级问题走 [CODE-REVIEW](docs/conventions/CODE-REVIEW.md)。
- 让预发布实例用正式机器人账号写真实仓库；预发布实例只写沙盒仓库，或只演练不写。

## 6. 文档路由表

服务代码与文档严格对齐，一个包一份契约；完整地图（含 `deploy/`、`docs/`、`notes/`、`scripts/`、`.github/` 行）见 [docs/README.md](docs/README.md)，冲突时以它为准：

| 包目录 | 服务契约 | 管辖规范 |
|---|---|---|
| `app/control`（控制面） | [docs/services/control/README.md](docs/services/control/README.md) | `MODULAR-DEVELOPMENT`、`SECURITY`、`API`（#2、#3 写入） |
| `app/console`（管理后台，Vue 3 + Tuffex） | [docs/services/console/README.md](docs/services/console/README.md) | `DESIGN`、Tuffex 使用政策、`TESTING` |
| `app/node`（工作节点代理） | [docs/services/node/README.md](docs/services/node/README.md) | `SECURITY`、`NODES`（#11 写入） |
| `app/runner`（sandbox / VM 里的 omp 驱动） | [docs/services/runner/README.md](docs/services/runner/README.md) | `SECURITY`、`MODULAR-DEVELOPMENT` |
| `packages/protocol`（类型与 JSON Schema） | [docs/services/protocol/README.md](docs/services/protocol/README.md) | `MODULAR-DEVELOPMENT`、`API`（#2、#3 写入） |

新增包 = 新增 `app/<name>` 或 `packages/<name>` + 新增 `docs/services/<name>/README.md`，两处缺一视为未完成（`pnpm check:docs` 强制）；模块细节放同目录子文档。完整目录清单见生成物 [docs/INDEX.md](docs/INDEX.md)，不要手工编辑。

**工具适配器政策**：本仓只有 `AGENTS.md` 一个 agent 入口。`CLAUDE.md`、`GEMINI.md`、`CONVENTIONS.md`、`.clinerules`、`.cursorrules`、`.windsurfrules`、`.cursor/rules/*`、`.github/copilot-instructions.md` 以及所有模块级 `AGENTS.md` 一律不再保留（连指针也不留）。技能只有一个实现放在 `.agents/skills/`，其它 CLI 用自己的目录符号链接过去（`.omp/skills/<name>`、`.claude/skills/<name>`），禁止复制内容形成第二份规则。
