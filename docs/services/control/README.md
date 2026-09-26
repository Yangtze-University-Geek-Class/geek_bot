# control 服务契约（`app/control`）

> 控制面：唯一的 SQLite 写入者和唯一的 GitHub 写入者，负责登录、令牌、仓库发现、轮询、调度和模型中继，并同源托管 console。

状态：`proposed` · 更新：2026-09-26 · 适用：`app/control`（`@geek-bot/control`）、`tests/control`

## 职责

control 是一个 Fastify 5 + better-sqlite3 的单进程服务（两者由 #3 引入，版本见 [STACK](../../design/STACK.md)）：

- 唯一的 SQLite 写入者：调度、租约、outbox 都在同一个进程里完成；
- 唯一的 GitHub 写入者：一切写入只经 publisher（写入白名单 + outbox）；
- 负责首次认领、登录、机器人令牌的加密存放和校验、仓库发现与权限映射、条件请求轮询、工作项推导、调度与租约、规则画像、模型中继、确定性动作（提醒、到期关闭）、审计、备份与恢复校验；
- 同源托管 console 的静态产物。

control 从不运行 omp，也不执行目标仓库里的任何代码。

## 现在有什么

#3 建了控制面的骨架：配置、密钥文件、库与迁移、审计与告警表、结构化日志与打码、加密备份与每日恢复校验、`/healthz` 与 `/readyz`、运维命令、优雅停机和镜像。登录、GitHub 调用、后台页面都还没有（#5 起）。

| 路径 | 内容 |
|---|---|
| `app/control/package.json` | 包名 `@geek-bot/control`；生产依赖 `fastify`、`better-sqlite3`，开发依赖 `@types/better-sqlite3`；脚本 `typecheck`（`tsc --noEmit`）、`build`（`tsc` 后把 `src/db/migrations/*.sql` 复制进 `dist/db/migrations/`） |
| `app/control/tsconfig.json` | 继承根 `tsconfig.base.json`，`src/` 编译到 `dist/` |
| `src/index.ts` | 进程入口：`startControl` → `listen` → 接 SIGTERM、SIGINT；拒绝启动时以 1 退出。镜像的 CMD 运行它 |
| `src/services.ts` | 启动与停机的全部步骤（见下文「启动、就绪与停机」）；`startControl` 返回句柄，测试直接调用 |
| `src/app.ts` | Fastify 组装：日志、服务端生成的 `X-Request-Id`、[API](../../architecture/API.md) 的错误格式、Ajv `removeAdditional: false`、请求体 64 KB 上限、只接受 JSON 请求体；注册路由模块 |
| `src/config.ts` | 产品默认值 `CONTROL_DEFAULTS` 与环境变量表 `CONTROL_ENV`（轮询、静默窗口、提醒与关闭天数、追问轮数、VM 规格，以及 #3 加的备份保留份数与每日备份时刻）；部署配置 `createDeploymentConfig`（实例角色、监听地址与端口、origin、明文模式、库路径、两个密钥文件路径、日志级别、镜像版本）；`loadControlConfig` 一次读出两部分，问题合在一个 `ControlConfigError` 里一起报。都是纯函数，不读 `process.env`、不读文件 |
| `src/secrets/key-files.ts` | 读 `*_FILE` 指向的 32 字节密钥（base64 或 64 位十六进制）；报错与提醒只写变量名，不回显路径和内容；读到的原文登记进打码器；备份密钥的指纹 |
| `src/db/database.ts` | 打开库（WAL、`synchronous=FULL`、`foreign_keys=ON`、`busy_timeout=5000`、`locking_mode=EXCLUSIVE`）、打开独立副本、`wal_checkpoint(TRUNCATE)` 后关库、各表行数 |
| `src/db/migrator.ts`、`src/db/sql-statements.ts`、`src/db/migrations/0001_foundation.sql` | 迁移器（`sql-statements.ts` 在加载时找出顶层的事务控制语句）与第一个迁移（7 张表：`schema_migrations`、`settings`、`revisions`、`idempotency_keys`、`alerts`、`audit_logs`、`backups`）。规则见 [数据模型](data-model.md)「迁移规则」 |
| `src/db/audit.ts`、`src/db/alerts.ts` | 唯一的审计函数（写入前打码，表只追加）；告警（同一件事只有一条未解决的，重复只加计数） |
| `src/log/logger.ts`、`src/log/redact.ts` | 结构化日志（每条一行 JSON）；按 S-16 的密钥形态与已知密钥原值打码 |
| `src/ops/backup-file.ts`、`src/ops/backup.ts` | 加密备份的文件格式；备份、恢复校验、保留策略、启动时补登记 |
| `src/ops/scheduler.ts` | 每日备份加恢复校验 |
| `src/ops/channel.ts` | 运维本地通道：CLI 把会写库的命令交给运行中的 control |
| `src/routes/health/{index,contracts}.ts` | `/healthz`、`/readyz`（A-53、A-54） |
| `src/http/errors.ts` | 错误响应的形状与 JSON Schema |
| `src/cli.ts` | 运维命令 `backup`、`verify-backup`、`restore --dry-run`（见下文「运维命令」） |
| `src/healthcheck.ts` | 镜像 HEALTHCHECK 的探针：请求本进程的 `/readyz` |
| `scripts/copy-migrations.mjs` | 构建的最后一步：复制迁移文件 |
| `scripts/dev.mjs` | `pnpm dev:control` 的启动器（见 [LOCAL-DEV](../../ops/LOCAL-DEV.md)） |
| `Dockerfile` | control 镜像（见下文「镜像」） |
| `tests/control/` | `config.test.ts`、`logging.test.ts`、`database.test.ts`、`backup.test.ts`、`server.test.ts`、`cli.test.ts` 与夹具 `helpers.ts`，覆盖面见 [TESTING](../../conventions/TESTING.md) |

新增或删除文件时同步更新本表。

## 配置

环境变量的完整清单（名字、取值、默认值）在 [默认行为与配置项](behavior.md)「配置项一览」；这里只写 #3 读取的几项怎样生效。

- **实例角色** `GEEK_BOT_INSTANCE_ROLE`（`preview`、`production`）必须显式配置，没配或值不对就拒绝启动（B-64）。
- **监听** `GEEK_BOT_HOST` 默认 `127.0.0.1`，`GEEK_BOT_PORT` 默认 `8080`。绑定非回环地址时必须配置 `GEEK_BOT_PUBLIC_ORIGIN`；origin 不是 https 时还要显式设置 `GEEK_BOT_ALLOW_PLAINTEXT_MESH=true`，否则拒绝启动（S-20）。origin 只能是 `http(s)://主机[:端口]`。
- **库** `GEEK_BOT_DB_PATH` 默认 `/data/geek-bot.db`。加密备份在同目录的 `backups/`，运维本地通道在 `run/`，备份与恢复校验的明文临时文件在 `tmp/`（0700，文件 0600，启动时清空）。
- **密钥只从 `*_FILE` 读**：`GEEK_BOT_MASTER_KEY_FILE`（默认 `/run/secrets/master_key`）与 `GEEK_BOT_BACKUP_KEY_FILE`（默认 `/run/secrets/backup_key`）。这两个变量只接受路径的写法：绝对路径，或以 `./`、`../` 开头（与 `check-secrets` 的密钥文件引用同一口径）；以 `/` 开头的 base64 密钥原文另按密钥的样子拦下。不合规就拒绝启动，报错只写变量名、不回显值，因为误填进来的往往就是密钥原文。文件内容是 32 个随机字节的 base64（`openssl rand -base64 32`）或 64 位十六进制；读不到、格式不对、两个变量指向同一个文件、两把密钥相同都拒绝启动，报错只写变量名、提示核对挂载，不回显路径：以 `/` 开头、不带 `=` 的 base64 原文也满足路径的写法，拼进报错就等于泄露。control 和 CLI 的报错是同一份文字。直接写值的 `GEEK_BOT_MASTER_KEY`、`GEEK_BOT_BACKUP_KEY` 一旦有值就拒绝启动。文件对组或其他用户可读时记一条 warn（不阻止启动；权限由部署脚本核对，#7）。#3 只读取并校验 master key，用它加密令牌随 #5。
- **日志级别** `GEEK_BOT_LOG_LEVEL`：`debug`、`info`（默认）、`warn`、`error`。
- **镜像版本** `GEEK_BOT_APP_VERSION`（默认 `local`）：只作来源记录，写进 `schema_migrations.app_version` 与 `backups.app_version`；由部署脚本写入（#7）。它不是 A-55 的展示值。
- **备份** `GEEK_BOT_BACKUP_KEEP_DAILY`（默认 7）、`GEEK_BOT_BACKUP_KEEP_WEEKLY`（默认 4；为 0 时不做每周备份，每周第一次也记为每日）、`GEEK_BOT_BACKUP_HOUR_UTC`（默认 3，即每天 UTC 03:00 之后做当天的备份）。

## 启动、就绪与停机

启动（`src/services.ts`，全部做完才开始监听）：

1. 读配置，不合法就拒绝启动，一次列出全部问题；
2. 读两把密钥；
3. 以独占方式打开库：`locking_mode=EXCLUSIVE` 下连接一直持有文件锁，同一个库的第二个 control（或任何别的连接）等满 `busy_timeout` 后打不开，报「库正被另一个进程占用」（ADR-0003）；拿到锁之后清空 `tmp/` 并把它收紧到 0700，上次崩溃留下的明文临时文件不会留下；
4. 迁移检查（[数据模型](data-model.md)「迁移规则」）：兼容版本高于代码、已应用的迁移文件被改过、`schema_migrations` 编号不连续、库不是 geek_bot 的库，都拒绝启动；声明 `shrink=false` 的迁移执行后已有的表、列、索引、触发器、视图少了或变了，回滚并拒绝启动；迁移文件顶层写了 `BEGIN`、`COMMIT` 之类的事务控制语句，加载时就拒绝，执行时保存点不见了（文件自己结束了事务）也拒绝启动，报告可能已部分生效；有待执行的迁移而库不是空库时，先做一次 `pre_migration` 备份，备份失败就不迁移、拒绝启动；库比代码新而兼容版本不高（回滚到上一版镜像）时记一条 warn，正常启动；
5. 清掉备份目录里崩溃留下的临时文件，给没登记的备份文件补登记；
6. 监听端口，然后开运维本地通道和每日备份任务。

拒绝启动时记一条 `fatal` 日志（`msg` 是中文原因，`problems` 逐条列出），以 1 退出。

就绪：`GET /readyz` 的检查项与名字见 `src/routes/health/contracts.ts`：`database_writable`（库打开着、能拿到写锁、库文件与目录可写）、`schema_compatible`（K ≤ C）、`migrations_applied`（D ≥ C）、`secrets_readable`（两个密钥文件此刻可读）、`serving`（没在停机）。全部通过返回 200 `{"status":"ready"}`；否则 503 `{"error":{"code":"not_ready","message":"未就绪，没通过的检查项：…"}}`，只列名字，不含路径和值。`GET /healthz` 只要进程活着就返回 200 `{"status":"ok"}`。这两个端点成功时不写访问日志。

停机（SIGTERM、SIGINT）：新请求一律 503 `not_ready` → 等进行中的请求做完 → 关本地通道 → 等正在做的备份或恢复校验做完 → `PRAGMA wal_checkpoint(TRUNCATE)` → 关库，记下 checkpoint 的结果（`busy` 为 0 表示做完），以 0 退出；停机出错以 1 退出。

## 运维命令与单写者

镜像里的 `geek-bot` 等于 `node /app/app/control/dist/cli.js`，在容器里运行（例如 `docker compose exec control geek-bot backup`，compose 随 #7）。退出码：0 成功，1 失败，2 用法错误。

| 命令 | 做什么 |
|---|---|
| `backup [--kind manual\|pre_deploy]` | 做一次加密备份（默认 `manual`；部署脚本部署前用 `pre_deploy`，#7），做完按保留策略清理 |
| `verify-backup [<文件名>]` | 恢复校验一份备份（默认最新一份没被清理的），结果写进 `backups`，失败写 `critical` 告警，并以 1 退出 |
| `restore --dry-run <文件>` | 只做恢复校验，报告会恢复到哪个时间点、哪个库版本，以及这版代码能否直接打开；不碰库、不改任何文件。文件可以是 `backups/` 里的文件名或任意路径（例如异地副本）。正式恢复（覆盖库文件）没有实现，不带 `--dry-run` 以 2 退出，随 #20 的恢复演练写入 |

单写者（ADR-0003）的定稿做法：`backup`、`verify-backup` 会写库，control 在运行时经本地通道（`<库所在目录>/run/control.sock`，unix socket 上的 HTTP；`run/` 权限 0700、socket 0600，只有运行 control 的账号能连，不占 TCP 端口）交给 control 执行，CLI 不开写连接。连不上通道时（control 没在运行），CLI 以同样的独占方式打开库自己执行，做完 checkpoint 并关库；拿不到锁就失败。离线执行在写库之前按迁移规则核对库版本：库执行到的迁移必须正好是这版 CLI 认识的最高编号，兼容版本也不能高于它；对不上（库比 CLI 旧、比 CLI 新、兼容版本更高、库被手工改过）就拒绝执行、不写库，CLI 自己不执行迁移。`restore --dry-run` 只读备份文件和备份加密密钥，解密出的明文放在 `tmp/` 下的临时目录里，做完删除。以后的 `bootstrap-code`（#5）走同一个通道；`rotate-master-key`（#5）与正式 `restore`（#20）只在 control 停止时以独占方式运行。

## 日志与打码

每条日志一行 JSON：`time`（ISO 8601 UTC）、`level`、`msg`（中文）和上下文字段；Fastify 的请求日志关掉，改由 `onResponse` 记一行 `method`、`path`（去掉查询串）、`status`、`duration_ms` 与 `reqId`。整条写出之前打码（S-16）：`ghp_`、`gho_`、`ghu_`、`ghs_`、`ghr_`、`github_pat_`、`gbn_`、`gbt_`、`sk-`、`Bearer <凭据>`、私钥块，以及已登记的密钥原值（#3 起是两个密钥文件的内容）；对象里 `authorization`、`cookie`、`*_token`、`*_secret`、`*_password`、`*_key` 这类键的值整体替换。审计的 `detail_json`、`target` 和告警的 `message` 写库前同样打码。

## 镜像

`app/control/Dockerfile`，构建上下文是仓库根（`docker build -f app/control/Dockerfile .`）：

- 多阶段：`deps` 只装 control 的生产依赖（`--ignore-scripts`：better-sqlite3 13 自带各平台的预编译二进制）；`build` 编译 protocol 与 control；`runtime` 只拷生产依赖和 `dist/`。
- 基础镜像 `node:22-bookworm-slim` 按 index digest 钉死（S-18）；`--build-arg NODE_IMAGE=…` 可以换成同一 digest 的本机副本。
- 以 `node` 用户（uid 1000）运行；`/data` 属 `node`、权限 0700，部署时挂命名卷；代码文件属 root，运行用户只读。
- `HEALTHCHECK` 每 15 秒运行 `node dist/healthcheck.js` 请求本进程的 `/readyz`（超时 5 秒，启动宽限 60 秒，连续 3 次失败算不健康）。
- 不设 `GEEK_BOT_HOST`：镜像默认只绑回环地址，部署时由 compose 设成 `0.0.0.0` 并配置 origin（#7）。
- 镜像里没有环境身份、域名、密钥和 console 产物。CI 的 `docker` job 只构建、不推送，断言基础镜像按 digest 钉死、非 root 与 HEALTHCHECK，并起一次容器核对 `/readyz`、退出码和 checkpoint 日志（[CICD](../../ops/CICD.md)）；推镜像随 #7 的 `release.yml`。

## 计划中的模块与对应 issue

| 模块（计划路径） | 内容 | issue |
|---|---|---|
| `src/cli.ts` | 再加 `bootstrap-code`、`rotate-master-key`；正式 `restore` | #5、#20 |
| `src/routes/alerts`、`audit` | 告警列表与确认、审计查询（A-50、A-51、A-52）：都要会话鉴权，#3 没有会话，放到 #5 之后 | #5 起，#20 |
| `src/ops/` | 异地副本、恢复演练 | #20 |
| 静态托管 | 把 console 的 `dist/` 打进镜像并同源托管，定缓存头与安全响应头（ADR-0009） | #7 |
| `src/routes/release` | A-55 `/api/release` 的展示值与节点协议版本范围 | #7 |
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

子文档：[默认行为与配置项](behavior.md)、[写入白名单](write-whitelist.md)、[数据模型](data-model.md)；scheduler、github、models 的说明随 #8、#6、#13 写入。

## 接口与数据归属

- 已实现：`GET /healthz`、`GET /readyz`（A-53、A-54）；未知路径 404 `not_found`；每个响应带 `X-Request-Id`（服务端生成，不采信请求头）。
- 计划中：后台 API `/api/v1/*`，加 SSE `/api/v1/stream`；服务端按角色鉴权，入参用 JSON Schema 声明并拒绝未知字段。端点表见 [API](../../architecture/API.md)。
- 计划中：节点 API `/api/node/v1/*`（heartbeat、lease、bundle、events、result、model），节点用 bearer 节点令牌认证。消息表见 [节点协议](../node/protocol.md)，schema 由 #11 放进 protocol。
- 数据：SQLite 文件只有 control 写，preview 与 production 各一个库。表清单、迁移与兼容版本、备份与恢复校验、从 GitHub 重建状态见 [数据模型](data-model.md)。
- GitHub：读取层与 publisher 是仅有的两处能解密机器人令牌的代码；GitHub 写入只经 publisher（#6、#9）。
- 密钥：master key、会话签名密钥、备份加密密钥、OAuth client secret、模型网关密钥都以 `*_FILE` 文件挂载，只给 control（密钥表见 [SECURITY](../../architecture/SECURITY.md)）。#3 读取前两类中的 master key 与备份加密密钥。

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
pnpm exec vitest run tests/control tests/tooling/ci-docker.test.ts
pnpm --filter @geek-bot/protocol build && pnpm --filter @geek-bot/control build
docker build -f app/control/Dockerfile -t geek-bot-control:local .   # 需要能拉到基础镜像
```

镜像的实机检查（`docker run` 后 `/readyz`、`docker inspect` 的用户与健康检查、删掉 master key 后拒绝启动）步骤见 [LOCAL-DEV](../../ops/LOCAL-DEV.md)「control 镜像」。

## 已知限制

- 登录、会话、GitHub 调用、后台页面都没有；上文「计划中」的模块、接口、默认行为落地前不能当作现状引用。
- A-55 `/api/release` 没有实现：展示值的组合规则依赖发布 tag 的语法，而 tag 规则只在 `scripts/release-tags.mjs` 实现（[RELEASES](../../conventions/RELEASES.md)），control 不复制第二份；展示值由部署脚本写入，随 #7 一起定。console 请求它会得到 404，页脚不显示版本。
- console 的静态产物没有打进镜像，control 也不托管静态文件（随 #7）。
- API.md 要求的「每个请求校验 `Host` 与 origin 一致」「对请求体关闭 Ajv 的类型强制转换」「按会话限速的额度」都要等第一个会话端点（#5）才有意义，#3 没有实现；#3 只做了 `removeAdditional: false`、415、413、400 的全局设置。
- 告警只写进 `alerts` 表，后台显示与确认（A-50、A-51）和审计查询（A-52）还没有，它们都要会话鉴权；每日恢复校验失败时要看日志或用 `geek-bot verify-backup` 查。
- 每日备份的时刻按 UTC 整点判定；control 停机错过的那次在下一次启动后补做，补做的时间点不是整点。
- 备份在 control 进程里流式加密，备份期间库照常可写（better-sqlite3 在线 backup，同一连接的写入会进入备份）；很大的库备份时间长，停机会等它做完，compose 的 `stop_grace_period` 要留够（#7）。
- 异地副本、正式恢复与恢复演练（记录 RTO、RPO）随 #20。
- 免费计划的私有仓库没有分支保护和 rulesets，OAuth `repo` scope 也不能按仓库收窄；「不推主干、不打 tag、不合并」完全依赖 publisher 代码，见 [SECURITY](../../architecture/SECURITY.md)。
