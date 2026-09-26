# 文档索引

> 本文件由 `node scripts/docs-index.mjs` 生成，**请勿手工编辑**。
> 改了文档标题或摘要后重新生成；提交前用 `node scripts/docs-index.mjs --check` 自查。

任务与规范导航见 [`README.md`](./README.md) 和 [`../AGENTS.md`](../AGENTS.md)。Tuffex 完整组件索引见 [`COMPONENTS.md`](./components/tuffex/COMPONENTS.md)，不在总索引重复展开。

## conventions/

强制遵守的协作规范：分支、审查、提交、Issue、PR、追踪记录、执行记录、发版、测试与文档。违反的改动会被 CODE-REVIEW 退回。

| 文档 | 说明 | EN |
|---|---|---|
| [`AGENT-START.md`](./conventions/AGENT-START.md) | AI 进入 geek_bot 的第一步：确认当前分支，并完整读取 docs 中的适用规范；不能以记忆、任务紧急或测试通过代替。 | — |
| [`BRANCHING.md`](./conventions/BRANCHING.md) | 只有 `main`（正式）与 `stage`（预发布）两条长期分支；task 分支合并后必须立即删除，任何操作前先确认当前分支。 | — |
| [`CODE-REVIEW.md`](./conventions/CODE-REVIEW.md) | 本仓库专属的 diff 审查清单：触发时机、逐项检查、结论格式、审查记录位置，以及机器审查的边界。 | — |
| [`COMMITS.md`](./conventions/COMMITS.md) | Conventional Commits 结构，中文说明，一次提交一个可回滚目的。 | [EN](./conventions/COMMITS.en.md) |
| [`CONTRIBUTING.md`](./conventions/CONTRIBUTING.md) | 统一入口、最小变更、可审查的提交与资源隔离。 | [EN](./conventions/CONTRIBUTING.en.md) |
| [`DOCUMENTATION.md`](./conventions/DOCUMENTATION.md) | 区分当前事实、已接受决策、未实施提议和历史材料；`docs/` 与 `app/`、`packages/` 严格对齐；仓库可能公开，docs 里任何内容都要能公开。 | — |
| [`ISSUES.md`](./conventions/ISSUES.md) | issue 是一件事的主档：开发前先开 issue，写清现象、复现、环境与验收条件；之后每一步进展都以追踪记录留在评论里，PR 合并即关闭。 | [EN](./conventions/ISSUES.en.md) |
| [`MODULAR-DEVELOPMENT.md`](./conventions/MODULAR-DEVELOPMENT.md) | 五个工作区包职责清楚、依赖单向、只经 `@geek-bot/protocol` 共享契约；`app/`、`packages/` 与 `docs/services/` 严格对齐，不为目录形式制造部署复杂度。 | — |
| [`NOTES.md`](./conventions/NOTES.md) | 每个人、每个 agent 做的每一步，都按北京时间写进仓库里的 `notes/<日期>/<GitHub 用户名>/<链路>.md`；开发前先记开工，开发后记到收尾，链路不完整的 PR 不能合并。 | — |
| [`PROJECT.md`](./conventions/PROJECT.md) | 产品定位、五个包、授权边界、公开就绪约束、统一入口和完成定义。 | — |
| [`PULL-REQUESTS.md`](./conventions/PULL-REQUESTS.md) | PR 是一次改动的证据档：写清解决链路、验证结果、可以直接照着做的人工验收步骤和截图录屏；审查与返工写成评论，合并后 issue 自动关闭。 | [EN](./conventions/PULL-REQUESTS.en.md) |
| [`REFERENCES.md`](./conventions/REFERENCES.md) | 可追溯的工程依据：记录采用了哪些官方说明、用在仓库哪里，不把外部建议、产品选择和已完成验收混为一谈。 | — |
| [`RELEASES.md`](./conventions/RELEASES.md) | 发版只靠打 tag：`vX.Y.Z-rc.N` 打在 `stage` 的提交上发预发布，所有者在预发布验收通过后，在同一提交上打 `vX.Y.Z` 发正式。tag 不可移动、不可删除，版本号不自动提升；正式实例运行的就是预发布验过的那个镜像 digest。 | — |
| [`TESTING.md`](./conventions/TESTING.md) | 现在就有的测试与计划中的测试分开记录；类型检查、单元与路由测试、构建、浏览器验证、VM 冒烟和实例验收是不同证据，不相互替代。 | — |
| [`TRACKING.md`](./conventions/TRACKING.md) | 一件事从提出到关闭，每一步都以固定格式的评论留在 issue 与 PR 上；人扫一眼能看懂进展，Agent 按字段就能读出状态。 | — |

## services/

与 `app/`、`packages/` 一一对应的服务契约：每个包一份 README（职责、源码地图、接口、数据归属、验证、限制）。

## services/console/

管理后台：Vue 3.5 + vue-router 4 + Tuffex 0.6.0 + Vite 7 的单页应用，构建产物由 control 同源托管。

## services/control/

控制面：唯一的 SQLite 写入者和唯一的 GitHub 写入者，负责登录、令牌、仓库发现、轮询、调度和模型中继，并同源托管 console。

| 文档 | 说明 | EN |
|---|---|---|
| [`behavior.md`](./services/control/behavior.md) | 机器人的每条默认行为规则（B-01…）：规则内容、配置项名、默认值、作用范围，以及哪几条同时是写入白名单的拒绝规则。 | — |
| [`data-model.md`](./services/control/data-model.md) | control 的 SQLite 库：每张表的用途、主要列、索引、写入模块、保留期和密文列，以及迁移与兼容版本、备份与每日恢复校验、从 GitHub 重建状态的规则。 | — |
| [`write-whitelist.md`](./services/control/write-whitelist.md) | 机器人对 GitHub 的每一种写入：允许清单 W-01…W-14、拒绝清单 D-01…D-64，以及输出中和、outbox 状态机与 `dedupe_key`、限速与熔断。 | — |

## services/node/

工作节点代理：只向外连 control 领任务，不开入站端口；管理 issue 通道的无网 sandbox 容器和 PR 通道的一次性 QEMU/KVM VM。

| 文档 | 说明 | EN |
|---|---|---|
| [`protocol.md`](./services/node/protocol.md) | 工作节点与 control 之间的 HTTP/JSON 协议：原则、消息表 N-01…，以及 sandbox 与 VM 怎样访问节点。 | — |

## services/protocol/

纯类型加 JSON Schema：节点协议、TaskSpec、任务结果、RepoProfile、catalog 文件契约、console API DTO；各包之间唯一的共享契约。

## services/runner/

在 sandbox 容器或一次性 VM 里驱动 omp 的单文件程序，只用 Node 标准库。

## components/

管理后台所用组件库的本地资料入口：Tuffex 0.6.0 的离线文档快照，加上本仓库手写的使用政策。

## components/tuffex/

官方中文文档、API、Vue 示例和类型参考，供维护者和 AI 按组件与章节离线查询。

| 文档 | 说明 | EN |
|---|---|---|
| [`AI-GUIDE.md`](./components/tuffex/AI-GUIDE.md) | 先确认版本，再按组件、章节与示例取上下文，不从其他组件库推断接口。 | — |
| [`COMPONENTS.md`](./components/tuffex/COMPONENTS.md) | 按官方分类检索中文文档；每页包含 API、示例和固定版本源码链接。 | — |
| [`SOURCES.md`](./components/tuffex/SOURCES.md) | 可复核的官方源码快照，不把网页部署版本、源码 manifest 与 npm 发布版本混为一谈。 | — |
| [`TASK-MAP.md`](./components/tuffex/TASK-MAP.md) | 从管理后台的页面和任务出发定位组件，再查询准确 API。 | — |
| [`USAGE-POLICY.md`](./components/tuffex/USAGE-POLICY.md) | geek_bot 的管理后台全部用 Tuffex 0.6.0，不另建平行的通用 UI 体系。 | — |

## design/

管理后台怎么做、技术用什么版本。改界面或动依赖之前先读这里。

| 文档 | 说明 | EN |
|---|---|---|
| [`DESIGN.md`](./design/DESIGN.md) | 管理后台只用 Tuffex，浅色、平静、先求扫读；加载、空、失败、无权限分开显示，标准要求和项目偏好分开写。 | — |
| [`STACK.md`](./design/STACK.md) | 已经引入的工具和计划中的选型分开写；版本以 manifest、锁文件和运行时检查为准，路线图不写成现状。 | — |

## architecture/

长期有效的系统设计：架构、安全不变量、后台 API 契约。改动系统边界、信任边界、接口或数据之前先读这里。

| 文档 | 说明 | EN |
|---|---|---|
| [`API.md`](./architecture/API.md) | control 给管理后台的 HTTP 接口：路径、格式、会话与 CSRF、角色、校验、错误、幂等、分页、SSE 的约定，以及端点表 A-01…。 | — |
| [`ARCHITECTURE.md`](./architecture/ARCHITECTURE.md) | 控制面加工作节点：control 单进程单写者、唯一 GitHub 写入方；节点只出站领任务，在无网 sandbox 或一次性 VM 里运行 omp。 | — |
| [`SECURITY.md`](./architecture/SECURITY.md) | 信任边界、安全不变量（S-01…S-20）、每个密钥放在哪、谁能读、泄露后果、如何轮换，以及剩下的风险和验证办法。 | — |

## ops/

运维文档目录：照着做就能跑的操作说明。现在只有本机开发、CI 与发布验收模板，部署、环境、节点等文档随对应 issue 加入。

| 文档 | 说明 | EN |
|---|---|---|
| [`CICD.md`](./ops/CICD.md) | 三条工作流（ci / issue-lifecycle / branch-hygiene）只做机器验证、PR 正文核对和合并后的清理，不部署；发布镜像的 `release.yml` 随 #7 加入。平台能力按 2026-09-25 的只读核对记录。 | — |
| [`LOCAL-DEV.md`](./ops/LOCAL-DEV.md) | 在本机准备 Node 22 与 pnpm 9.15.9，安装依赖，跑 `pnpm verify`，启用 Git 钩子，用 task worktree 开工和收尾，每一步写执行记录。 | — |
| [`RELEASE-ACCEPTANCE-TEMPLATE.md`](./ops/RELEASE-ACCEPTANCE-TEMPLATE.md) | 空白模板，供验收人逐字段手工填写；不是流水线自动生成的通过证明。 | — |

## decisions/

已接受决策及其背景、替代方案、后果和重新评估条件。

| 文档 | 说明 | EN |
|---|---|---|
| [`0001-standalone-product.md`](./decisions/0001-standalone-product.md) | geek_bot 面向任何部署者，代码和文档不写死组织、仓库、主机、网段、网关和账号；env 模板只放占位符。 | — |
| [`0002-github-identity.md`](./decisions/0002-github-identity.md) | 机器人以部署者绑定的那个 GitHub 账号本人的身份工作：OAuth App 用户令牌、device flow、scope `repo read:org`；令牌加密存放在 control，只有 publisher 和 GitHub 读取层能解密。 | — |
| [`0003-single-writer-control.md`](./decisions/0003-single-writer-control.md) | control 是一个独占 SQLite 写入的 Fastify 进程，也是唯一写 GitHub 的地方；节点只主动连 control 领任务，不开入站端口，不持有 GitHub 凭据。 | — |
| [`0004-execution-isolation.md`](./decisions/0004-execution-isolation.md) | 只读代码的 issue 任务在无网、根只读、不挂令牌的独立容器里跑；要执行代码的 PR 任务每个一台新的 QEMU/KVM 临时 VM，结束即删；方案以 #12 的实测为准，不通过时按退路改选。 | — |
| [`0005-rules-from-base-branch.md`](./decisions/0005-rules-from-base-branch.md) | 仓库规则从 base 分支按 blob sha 读取，PR 改不了审查它自己的规则；影响写入的字段只取自结构化配置，能力开关以后台为基准、仓库只能调低；每条写入另带产品隐藏标记 `<!-- geek-bot v1 ... -->`，它和追踪记录头 `track v1` 是两回事。 | — |
| [`0006-model-catalog-relay.md`](./decisions/0006-model-catalog-relay.md) | 可用模型只来自部署者挂载的只读 catalog 文件；模型网关密钥只在 control；sandbox 和 VM 用每任务令牌经节点、再经 control 中继访问模型；降级分 omp 进程内和 runner 外层两层。 | — |
| [`0007-ghcr-pull-deploy.md`](./decisions/0007-ghcr-pull-deploy.md) | rc tag 构建一次镜像推到 ghcr，正式 tag 只给同一 digest 加别名；维护者获授权后在目标机运行仓库里的部署脚本，按 digest 拉取、过健康门、失败自动回滚；CI 不连目标机。 | — |
| [`0008-sqlite-migrations-recovery.md`](./decisions/0008-sqlite-migrations-recovery.md) | control 的 SQLite 用编号的 SQL 迁移加 `PRAGMA user_version`，只扩不缩，让上一版镜像仍能读库；每条写入带隐藏标记，库丢了能从 GitHub 重建关键状态；备份每天自动恢复校验。 | — |
| [`0009-tuffex-console.md`](./decisions/0009-tuffex-console.md) | console 是 Vue 3.5 + vue-router 4 + Tuffex 0.6.0 + Vite 的单页应用，版本钉死；构建产物打进 control 镜像，与后台 API 和 SSE 同源提供，不另起静态服务器。 | — |
| [`0010-tracking-record-prefix.md`](./decisions/0010-tracking-record-prefix.md) | 本仓库 issue / PR 评论里的追踪记录统一用 `<!-- track v1 kind=… stage=… -->`，与产品内置的默认格式一致；产品代码里它只是可配置的默认值。 | — |

---

共 42 篇文档（另有 4 篇英文版）。索引按目录分组，组内按文件名排序。
