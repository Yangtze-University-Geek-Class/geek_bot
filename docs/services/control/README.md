# control 服务契约（`app/control`）

> 控制面：唯一的 SQLite 写入者和唯一的 GitHub 写入者，负责登录、令牌、仓库发现、轮询、调度和模型中继，并同源托管 console。

状态：`proposed` · 更新：2026-09-26 · 适用：`app/control`（`@geek-bot/control`）、`tests/control`

## 职责

control 是一个 Fastify 5 + better-sqlite3 的单进程服务（两者都是计划中的依赖，#1 没有引入）：

- 唯一的 SQLite 写入者：调度、租约、outbox 都在同一个进程里完成；
- 唯一的 GitHub 写入者：一切写入只经 publisher（写入白名单 + outbox）；
- 负责首次认领、登录、机器人令牌的加密存放和校验、仓库发现与权限映射、条件请求轮询、工作项推导、调度与租约、规则画像、模型中继、确定性动作（提醒、到期关闭）、审计、备份与恢复校验；
- 同源托管 console 的静态产物。

control 从不运行 omp，也不执行目标仓库里的任何代码。

## 现在有什么

#1 只建最小源码：没有 HTTP 服务、没有数据库、没有生产依赖，只有一份可以单测的配置模块。

| 路径 | 内容 |
|---|---|
| `app/control/package.json` | 包名 `@geek-bot/control`，依赖 `@geek-bot/protocol: workspace:*`；脚本 `typecheck`（`tsc --noEmit`）、`build` |
| `app/control/tsconfig.json` | 继承根 `tsconfig.base.json`，`src/` 编译到 `dist/` |
| `app/control/src/config.ts` | 产品默认值 `CONTROL_DEFAULTS`（轮询 60 秒、静默窗口 300 秒、第 5 天提醒、第 7 天关闭、最多追问 2 轮、每台 VM 1 vCPU / 2048 MiB），每项对应的环境变量名表 `CONTROL_ENV`（都以 `GEEK_BOT_` 开头），以及 `createControlConfig(env)`：按默认值加环境变量覆盖生成配置。它是纯函数，不读 `process.env`、不读文件；有不合法的值时抛 `ControlConfigError`，一次列出全部问题，并要求关闭天数大于提醒天数 |
| `app/control/src/index.ts` | 包入口，只导出上面的配置 |
| `tests/control/config.test.ts` | 默认值、环境变量覆盖、非法值拒绝、关闭天数必须大于提醒天数 |

新增或删除文件时同步更新本表。

## 计划中的模块与对应 issue

| 模块（计划路径） | 内容 | issue |
|---|---|---|
| `src/{index,app,services,config,cli}.ts` | 进程入口、Fastify 装配、配置解析（在现有 `config.ts` 上扩展；密钥只从 `*_FILE` 读）、CLI（bootstrap-code、backup、restore --dry-run、verify-backup、rotate-master-key） | #3、#5 |
| `src/db/`、`src/db/migrations/NNNN_*.sql` | SQLite 版本化迁移，只扩不缩；库里另记兼容版本，只有收缩类迁移才抬高它，兼容版本高于代码认识的版本时拒绝启动，所以回滚到上一版镜像仍能启动（[ADR-0008](../../decisions/0008-sqlite-migrations-recovery.md)、[数据模型](data-model.md)「迁移规则」） | #3 |
| `src/ops/` | `/healthz`、`/readyz`、备份、每日恢复校验、保留策略、告警 | #3、#20 |
| `src/routes/auth`、`admins`、`bot-account` | 认领码、device flow 登录、管理员邀请、会话、机器人账号绑定与令牌校验 | #5 |
| `src/secrets/` | 机器人令牌 AES-256-GCM 加密、master key 轮换 | #5 |
| `src/github/{client,etag,budget,discovery}.ts`、`src/routes/repos` | 仓库发现、权限到能力的映射、可分配性、逐仓库开关 | #6 |
| `src/github/poller.ts`、`src/intake/`、`src/scheduler/`、`src/routes/items`、`tasks` | 条件请求轮询、受理规则、静默窗口、两通道优先级队列 | #8 |
| `src/publisher/{whitelist,neutralize,outbox,rate}.ts`、`src/github/markers.ts` | 写入白名单、输出中和、隐藏标记、outbox 幂等、写入限速 | #9 |
| `src/github/rules.ts`、`defaults/` | 每仓库规则画像（只读 base 分支）、内置默认规范 | #10 |
| `src/routes/nodes`、`node-api`、`src/bundle/`、`src/mirror/` | 节点令牌、节点 API、租约与 epoch、任务包、镜像克隆 | #11、#14 |
| `src/models/`、`src/routes/model-relay`、`models` | catalog 读取、模型池、每任务模型令牌、模型中继 | #13 |
| `src/routes/stream` | SSE 实时推送 | #14 |
| PR 审查、issue 受理与跟进、修复与返工的业务逻辑 | 按 [默认行为与配置项](behavior.md) 执行 | #15、#16、#18 |
| `Dockerfile` | 多阶段构建，打进 console 产物；非 root，带 HEALTHCHECK | #3、#7 |

子文档：[默认行为与配置项](behavior.md)、[写入白名单](write-whitelist.md)、[数据模型](data-model.md)；scheduler、github、models 的说明随 #8、#6、#13 写入。

## 接口与数据归属（计划中）

- 后台 API：`/api/v1/*`，加 SSE `/api/v1/stream`；服务端按角色鉴权，入参用 JSON Schema 声明并拒绝未知字段。端点表见 [API](../../architecture/API.md)。
- 节点 API：`/api/node/v1/*`（heartbeat、lease、bundle、events、result、model），节点用 bearer 节点令牌认证。消息表见 [节点协议](../node/protocol.md)，schema 由 #11 放进 protocol。
- 数据：SQLite 文件只有 control 写，preview 与 production 各一个库。表清单、迁移与兼容版本、备份与恢复校验、从 GitHub 重建状态见 [数据模型](data-model.md)。
- GitHub：读取层与 publisher 是仅有的两处能解密机器人令牌的代码；GitHub 写入只经 publisher。
- 密钥：master key、会话签名密钥、备份加密密钥、OAuth client secret、模型网关密钥都以 `*_FILE` 文件挂载，只给 control（密钥表见 [SECURITY](../../architecture/SECURITY.md)）。

## 计划中的默认行为

所有者定下的机器人行为规则都是产品的**默认值，可配置**，产品代码里不写死。逐条规则（B-01 至 B-64）、配置项名、默认值、作用范围和配置优先级见 [默认行为与配置项](behavior.md)；改默认行为时同时改那份文档和本节摘要。其中「白名单」一列填了 W、D、C 编号的几条同时由 publisher 强制（[写入白名单](write-whitelist.md)），改它们等于放宽白名单，要按 [SECURITY](../../architecture/SECURITY.md) 的 S-06、S-07 取得所有者批准，并补上对应的拒绝测试。实现分别在 #6、#8、#9、#10、#13、#15、#16、#17、#18。

已经有代码的只有几个数值默认：轮询间隔、静默窗口、提醒与关闭天数、追问轮数、VM 规格写在 `app/control/src/config.ts`，目前可以用 `GEEK_BOT_*` 环境变量覆盖；PR 通道优先级的默认顺序写在 `@geek-bot/protocol` 的 `PR_CHANNEL_PRIORITY`。其余规则还没有实现。

摘要：

- **仓库开关**：新发现的仓库默认只监控；「审查 PR」「受理 issue」「自动修复」「返工」逐个仓库开启，写入模式默认 `off`，打开写入类开关和调高写入模式只归 owner。非安全设置按仓库文件 > 后台覆盖 > 组织 `.github` 仓库 > 内置默认取值；能力开关和写入模式以后台为基准，仓库文件和组织 `.github` 只能往下调；其它安全限制各层取更严（ADR-0005）。
- **PR**：开启审查的仓库里别人开的 PR 都审，只发 `COMMENT`，不批准、不合并；不审机器人自己开的 PR；来自 fork 的照审；审查前已合并的补审，control 停机恢复后只补 72 小时以内的；同一个 PR 只审最新提交。机器人开的 PR，「审查结论」段固定写阻塞。
- **issue 接不接**：打了 `bot:manual` 或分给了人的不接；已有开着的关联 PR 就转去审那个 PR；分给机器人账号的优先接；没分配的受理，由机器人自己决定修不修，只修小改动。
- **追问与关闭**：描述不清就追问并打 `bot:blocked`；非机器人账号的评论或作者改正文算回复；第 5 天提醒、第 7 天关闭、最多追问 2 轮；价值不高的先发关闭记录再关；说清楚了但不合规范的，改写成新 issue 再关闭原 issue；人重开过的不再关；只关 issue，不关 PR。
- **公开仓库与实例隔离**：返工默认只认仓库成员（`OWNER`、`MEMBER`、`COLLABORATOR`）的审查意见；「什么算回复」保留原规则，可以按仓库收窄为作者和成员。preview 实例写沙盒以外的仓库一律拒绝并写审计。
- **执行与调度**：轮询 60 秒；条目最后一次非机器人变动后静默 5 分钟才入队，机器人自己的写入不重新计时；issue 通道在无网只读的 sandbox 里运行，不开 VM；PR 通道每个任务一台新的临时 VM（1 vCPU / 2 GiB），用完即删；PR 通道优先级是审查别人的 PR > 自己 PR 返工 > 修分给机器人的 issue > 自己决定修的。开工前和发出前各复核一次，条件变了就放弃并留一条进展记录。
- **模型**：按任务类型分池，池内按顺序降级；模型和思考档位只来自部署者挂载的只读 catalog 文件；网关地址由部署配置 `GEEK_BOT_MODEL_GATEWAY_URL` 固定，catalog 里的地址与它不一致就拒绝加载。
- **记录格式**：按目标仓库自己的规范写；仓库没有时，记录头默认 `<!-- track v1 kind=<类型> stage=<阶段> -->`，可以在后台改（ADR-0010）。每条写入的最后一行另带隐藏标记 `<!-- geek-bot v1 ... -->`，用于幂等和从 GitHub 重建状态（ADR-0005、ADR-0008）。

## 验证

```bash
pnpm --filter @geek-bot/control typecheck
pnpm exec vitest run tests/control
```

## 已知限制

- #1 没有实现任何业务功能，也没有 HTTP 服务；上文的模块、接口、默认行为都是计划，落地前不能当作现状引用。
- Fastify、better-sqlite3 等生产依赖都没有引入，由 #3 起逐步引入。
- 免费计划的私有仓库没有分支保护和 rulesets，OAuth `repo` scope 也不能按仓库收窄；「不推主干、不打 tag、不合并」完全依赖 publisher 代码，见 [SECURITY](../../architecture/SECURITY.md)。
