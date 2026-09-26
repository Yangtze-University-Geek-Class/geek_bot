# control 数据模型

> control 的 SQLite 库：每张表的用途、主要列、索引、写入模块、保留期和密文列，以及迁移与兼容版本、备份与每日恢复校验、从 GitHub 重建状态的规则。

状态：`proposed` · 更新：2026-09-26 · 适用：`app/control` 的 SQLite 库与数据卷（由 #3 起实现，各表随对应 issue 以新迁移加入）

#3 引入了 better-sqlite3，第一个迁移 `0001_foundation.sql` 建了表清单里标 #3 的 7 张表；其余表还没有，随对应 issue 以新迁移加入。本文是实现目标：表名、列名照这里写；实现时发现要改，先改本文再改代码。来源是 [ARCHITECTURE](../../architecture/ARCHITECTURE.md)「数据」、[ADR-0003](../../decisions/0003-single-writer-control.md)（单进程单写者）和 [ADR-0008](../../decisions/0008-sqlite-migrations-recovery.md)（迁移、备份与重建）；后台 API 需要的版本号和幂等记录来自 [API](../../architecture/API.md)，节点与令牌的状态来自 [节点协议](../node/protocol.md)，密钥的存放来自 [SECURITY](../../architecture/SECURITY.md)。

表名用 snake_case，与架构草案一致。草案之外新增了 7 张表：`schema_migrations`、`repo_overrides`、`node_tokens`、`task_results`、`backups`、`revisions`、`idempotency_keys`；任务事件表沿用草案的 `task_events`，审计表沿用 `audit_logs`。配置项名和默认值见 [默认行为与配置项](behavior.md)。

## 存储与通用约定

- **一个环境一个库。** 容器内 `/data/geek-bot.db`（`GEEK_BOT_DB_PATH`），放在该环境自己的命名卷里；preview 与 production 各一个库，互不共享。镜像里 `/data` 属运行用户、权限 0700（#3）；compose 里的命名卷随 #7。
- **只有 control 进程写库。** console、node、runner、部署脚本都不打开库。#3 定稿的做法：control 以 `locking_mode=EXCLUSIVE` 打开库，第一次访问后一直持有文件锁到关库为止，同一个库的任何别的连接或进程都打不开（等满 `busy_timeout` 后 SQLITE_BUSY）；会写库的 CLI 子命令（`backup`、`verify-backup`，以后的 `bootstrap-code`）经容器内的本地通道（`<库所在目录>/run/control.sock`，unix socket 上的 HTTP，`run/` 权限 0700）交给运行中的 control 执行，CLI 自己不开写连接；control 没在运行时，CLI 以同样的独占方式打开库自己执行，拿不到锁就失败。`restore` 与 `rotate-master-key` 只在 control 停止时以独占方式运行（#20、#5）。实现与测试见 [control 服务契约](README.md)「运维命令与单写者」。
- **连接参数。** `journal_mode=WAL`、`synchronous=FULL`、`foreign_keys=ON`、`busy_timeout=5000`（毫秒），加上 `locking_mode=EXCLUSIVE`（见上一条；WAL 下先设独占再访问库，SQLite 不建 `-shm` 文件）。停机时 `wal_checkpoint(TRUNCATE)` 后关库。
- **类型。**
  - 时间：`INTEGER`，UTC 的 Unix 毫秒，列名以 `_at` 结尾。
  - 布尔：`INTEGER`，`CHECK (x IN (0, 1))`。
  - 枚举：`TEXT` 加 `CHECK` 列出取值；取值要扩充时按「迁移规则」重建表。
  - JSON：`TEXT`，列名以 `_json` 结尾，写入前按 `@geek-bot/protocol` 的 schema 或本文说明校验。
  - GitHub 的用户、组织、仓库按数字 id 识别；login 和仓库名只用于显示，每次发现时刷新。仓库和节点另有本库的自增 id（API 里的 `repo_id`、`node_id`），其它表按它关联。
  - 任务 id、租约 id 是 `TEXT` 随机 id（至少 128 位随机，编码 #8 定），会出现在节点协议和隐藏标记里；其余表用 `INTEGER` 自增主键。
- **密文列**（列名以 `_ct` 结尾）：AES-256-GCM，每个值用独立的随机 nonce，列里依次存 nonce、密文和认证标签，同一行存 `key_version`。master key 以文件挂载，不进库、不进备份（[SECURITY](../../architecture/SECURITY.md) S-01）。`rotate-master-key` 在一个事务里重新加密全部密文并提升 `key_version`。
- **哈希列**（列名以 `_hash` 结尾）：对高熵随机令牌存 SHA-256，比较用常量时间；明文只在生成时显示一次，或只在内存里。
- **库里不存**：master key、会话签名密钥、备份加密密钥、OAuth client secret、模型网关密钥（都是 `*_FILE` 文件）；会话 id、认领码、登录流程 cookie、节点令牌、每任务模型令牌的明文。
- **库外文件**：同一个卷下的 `mirrors/`（镜像克隆）、`bundles/`（任务包）、`tasks/<任务 id>/`（事件原文 `events.jsonl.gz`、补丁等产物）、`backups/`（加密备份，#3）、`run/`（运维本地通道的 socket，#3）。它们的保留期写在对应的表下面。库、备份和事件文件里有仓库内容和任务输出，按实例数据对待：不进仓库、不进镜像、不进日志（ADR-0008）。

## 表清单

「写入模块」都在 control 进程里，对应 [control 服务契约](README.md)「计划中的模块与对应 issue」。

| 表 | 用途 | 写入模块 | 保留期 | 密文或哈希 | 实现 |
|---|---|---|---|---|---|
| `schema_migrations` | 已应用的迁移、校验和、兼容版本 | 迁移器 | 永久 | — | #3 |
| `settings` | 后台保存的全局配置与暂停开关 | 后台设置、暂停 | 永久；删行即恢复默认 | — | #3 |
| `revisions` | 配置类资源的版本号（`ETag` / `If-Match`） | 各配置路由 | 永久 | — | #3 |
| `idempotency_keys` | 创建类请求的幂等记录 | 后台 API | 24 小时 | 哈希 | #3 |
| `admins` | 后台账号与角色 | 登录、管理员 | 永久；移除后保留行 | — | #5 |
| `sessions` | 后台会话 | 登录 | 登出、移除管理员或过期后删除 | 哈希 | #5 |
| `bootstrap_codes` | 首次认领码 | 登录 | 用过、作废或过期后删除 | 哈希 | #5 |
| `oauth_flows` | 进行中的 device flow 与 web flow | 登录、机器人绑定 | 完成或过期后删除 | 密文、哈希 | #5 |
| `bot_account` | 机器人账号与加密令牌（单行） | 机器人绑定、GitHub 读取层 | 当前一行；解绑后清空密文 | 密文 | #5 |
| `orgs` | 机器人所在组织与访问状态 | 发现 | 永久 | — | #6 |
| `repos` | 仓库、权限、能力开关、写入模式、暂停 | 发现、后台仓库 | 永久；`lost` 也保留 | — | #6 |
| `repo_overrides` | 后台对单个仓库的配置覆盖 | 后台仓库 | 永久；删行即回到下一层 | — | #10 |
| `repo_profiles` | 每个仓库合并后的规则画像与建议画像 | 规则 | 只存当前一份 | — | #10 |
| `poll_cursors` | 条件请求的 ETag 与下次轮询时间 | 发现、轮询 | 跟随仓库 | — | #6、#8 |
| `items` | 每个 issue 与 PR 的状态、静默计时、已审 head | 轮询、受理、publisher | 永久 | — | #8 |
| `threads` | issue 的等回复状态机：追问轮次、到期时间 | 受理与跟进、确定性动作 | 跟随 `items` | — | #16 |
| `bot_writes` | 机器人自己的写入，用来识别自身活动 | publisher | 未定（#9） | — | #9 |
| `tasks` | 任务队列与任务状态 | 受理、调度、节点 API、publisher | 永久 | — | #8 |
| `leases` | 租约与 epoch | 调度、节点 API | 同 `tasks` | — | #11 |
| `task_events` | 任务事件摘要（原文在库外文件） | 节点 API | 30 天 | — | #14 |
| `task_results` | 节点回报的结构化结果 | 节点 API | 状态永久；内容 30 天 | — | #11、#14 |
| `model_attempts` | 每次模型尝试与中继请求 | 模型中继、节点 API | 30 天 | — | #13、#14 |
| `model_pools` | 按任务类型的模型池 | 后台模型池 | 永久 | — | #13 |
| `relay_tokens` | 每任务模型令牌 | 调度、模型中继 | 吊销后删除 | 哈希 | #13 |
| `nodes` | 工作节点、槽位、信任等级、最近健康数据 | 后台节点、节点 API | 永久；移除后保留行 | — | #11 |
| `node_tokens` | 节点令牌 | 后台节点 | 永久 | 哈希 | #11 |
| `node_health_samples` | 节点健康曲线，每分钟一点 | 节点 API | 7 天 | — | #11 |
| `outbox` | 待写与已写的 GitHub 写入 | publisher | 非终态不删；终态未定（#9） | — | #9 |
| `bot_branches` | 机器人推过的分支与最近推送的提交 | publisher | 永久 | — | #18 |
| `alerts` | 告警 | 运维与各模块 | 已解决的未定（#20） | — | #3、#20 |
| `audit_logs` | 审计记录，只追加 | 各模块经同一个审计函数 | 永久 | — | #3 |
| `backups` | 备份文件登记与恢复校验结果 | 运维 | 跟随备份文件 | — | #3 |

共 32 张表。库执行到第几号迁移用 `PRAGMA user_version` 记录，兼容版本记在 `schema_migrations`（见「迁移规则」）。

## 各表的列

下面只列主要列；`id INTEGER PRIMARY KEY` 这类自增主键不再逐表解释。

### 库版本、设置与 API 记录

**`schema_migrations`**：已应用的迁移，一个文件一行。

| 列 | 类型与约束 | 说明 |
|---|---|---|
| `version` | `INTEGER PRIMARY KEY` | 迁移编号 NNNN；最大值等于 `PRAGMA user_version` |
| `name` | `TEXT NOT NULL` | 文件名 `NNNN_<slug>.sql` |
| `sha256` | `TEXT NOT NULL` | 文件内容哈希；启动时和代码里的同名文件比对 |
| `shrink` | `INTEGER NOT NULL`，布尔 | 1 表示这是收缩类迁移（删列、改语义），要有 ADR 批准 |
| `compat_version` | `INTEGER NOT NULL` | 应用这个迁移之后库的兼容版本：收缩类迁移等于自己的编号，其余沿用前一个迁移的值（`0001` 为 0） |
| `app_version` | `TEXT NOT NULL` | 执行这次迁移的镜像版本 |
| `applied_at` | `INTEGER NOT NULL` | |

库当前的兼容版本就是编号最大那一行的 `compat_version`。

**`settings`**：后台「设置」页保存的全局值和运行时的暂停开关。

| 列 | 类型与约束 | 说明 |
|---|---|---|
| `key` | `TEXT PRIMARY KEY` | behavior.md 配置项一览里的环境变量名（如 `GEEK_BOT_QUIET_WINDOW_SECONDS`）或设置键（如 `review.own_prs`、`priority.pr`）；另有暂停开关 `pause.global`、`pause.channel.issue`、`pause.channel.pr`、`pause.writes` |
| `value_json` | `TEXT NOT NULL` | 保存前按该项的取值范围校验；暂停开关的值是 `{paused, reason, auto, at}` |
| `updated_by` | `INTEGER` | 管理员的 GitHub id；自动触发的暂停为空 |
| `updated_at` | `INTEGER NOT NULL` | |

behavior.md 里标「只读」的项只认环境变量，不写进这张表（API 返回 `setting_locked`）；以 `_FILE` 结尾的键和任何密钥都拒绝保存。每次修改写 `audit_logs`。

**`revisions`**：配置类资源的版本号。后台 GET 响应的 `ETag` 取这里的值，PUT、PATCH 带的 `If-Match` 与它比对，不符返回 412（[API](../../architecture/API.md)「幂等」）。

| 列 | 类型与约束 | 说明 |
|---|---|---|
| `scope` | `TEXT PRIMARY KEY` | `settings`、`model_pool/<任务类型>`、`repo/<repo_id>/switches`、`repo/<repo_id>/overrides`、`repo/<repo_id>/suggestion`、`node/<node_id>` |
| `revision` | `INTEGER NOT NULL` | 每次修改加 1，与资源本身在同一个事务里更新 |
| `updated_at` | `INTEGER NOT NULL` | |

**`idempotency_keys`**：创建类请求（邀请管理员、重新排队、接受协作邀请、生成节点令牌、重置节点令牌）的幂等记录。

| 列 | 类型与约束 | 说明 |
|---|---|---|
| `github_id`、`route`、`key` | `INTEGER NOT NULL`、`TEXT NOT NULL`、`TEXT NOT NULL` | 会话账号、路由和 `Idempotency-Key`；主键 `(github_id, route, key)` |
| `request_hash` | `TEXT NOT NULL` | 请求体的 SHA-256；同一个 key 配不同请求体返回 409 |
| `status` | `INTEGER NOT NULL` | 第一次响应的状态码 |
| `response_json` | `TEXT` | 第一次响应的响应体；返回一次性密钥的端点**不存**这个字段，重放时返回 409 `secret_already_issued` |
| `created_at` | `INTEGER NOT NULL` | 24 小时后删除 |

### 后台身份与会话

**`admins`**：能登录后台的账号。角色分三种：`owner`（认领实例的账号，只有一个；默认路径下它同时是机器人账号）、`operator`、`viewer`（后两种由 owner 按 GitHub 数字 id 邀请，[ADR-0002](../../decisions/0002-github-identity.md)）。

| 列 | 类型与约束 | 说明 |
|---|---|---|
| `github_id` | `INTEGER PRIMARY KEY` | 按数字 id 判定，不按 login |
| `login` | `TEXT` | 最近一次看到的 login，登录时刷新；受邀还没登录过时为空 |
| `role` | `TEXT NOT NULL CHECK (role IN ('owner','operator','viewer'))` | 部分唯一索引 `UNIQUE (role) WHERE role = 'owner'` 保证只有一个 owner |
| `invited_by` | `INTEGER REFERENCES admins(github_id)` | owner 为空 |
| `note` | `TEXT` | 邀请时的备注 |
| `created_at`、`last_login_at` | `INTEGER` | |
| `removed_at` | `INTEGER` | 被移除时写，同时删除他的全部会话；行保留，审计和其它表的引用不断 |

**`sessions`**：浏览器的 `gb_session` 只放随机会话 id，库里只存它的哈希。

| 列 | 类型与约束 | 说明 |
|---|---|---|
| `sid_hash` | `BLOB PRIMARY KEY` | 会话 id 的 SHA-256 |
| `github_id` | `INTEGER NOT NULL REFERENCES admins(github_id)` | |
| `created_at`、`last_seen_at` | `INTEGER NOT NULL` | 空闲 2 小时过期，按 `last_seen_at` 算 |
| `expires_at` | `INTEGER NOT NULL` | 最长 12 小时 |
| `reauth_at` | `INTEGER` | 最近一次重新认证；高危操作要求 10 分钟内 |

索引：`(github_id)`、`(expires_at)`。登出、移除管理员、解绑机器人时删除对应的行，过期的行由清理任务删除。

**`bootstrap_codes`**：首次认领码。明文只打印到目标机终端，不写日志；再次生成会作废旧码（S-10）。

| 列 | 类型与约束 | 说明 |
|---|---|---|
| `code_hash` | `BLOB NOT NULL UNIQUE` | 认领码的 SHA-256 |
| `claim_cookie_hash` | `BLOB` | 认领码通过后下发的 `gb_claim` 的 SHA-256 |
| `created_at`、`expires_at` | `INTEGER NOT NULL` | 15 分钟有效 |
| `used_at`、`used_by` | `INTEGER` | 认领成功的时间和 GitHub id |
| `revoked_at` | `INTEGER` | 被新生成的码作废 |

**`oauth_flows`**：进行中的授权流程，每行只活几分钟。`gb_flow` cookie 把一次 flow 绑定到发起它的浏览器。

| 列 | 类型与约束 | 说明 |
|---|---|---|
| `id` | `TEXT PRIMARY KEY` | API 里的 `flow_id` |
| `purpose` | `TEXT NOT NULL CHECK (purpose IN ('claim','login','reauth','bot_reauthorize'))` | 取值同 API 的 A-03、A-05 |
| `flow` | `TEXT NOT NULL CHECK (flow IN ('device','web'))` | |
| `flow_cookie_hash` | `BLOB NOT NULL` | `gb_flow` 的 SHA-256 |
| `bootstrap_code_id`、`session_sid_hash` | `INTEGER`、`BLOB` | 发起方：`claim` 是认领码，其余是会话 |
| `device_code_ct` | `BLOB` | device flow 的 device_code，密文 |
| `user_code` | `TEXT` | 给人输入的短码，不是密钥 |
| `pkce_verifier_ct` | `BLOB` | web flow 的 PKCE verifier，密文 |
| `state_hash` | `BLOB` | web flow 的 state 的 SHA-256 |
| `key_version` | `INTEGER` | 密文列用的 master key 版本 |
| `created_at`、`expires_at`、`completed_at` | `INTEGER` | `expires_at` 取 GitHub 返回的过期时间 |

### 机器人账号与仓库

**`bot_account`**：单行表。机器人令牌只以密文存在这里，只有 publisher 和 GitHub 读取层能解密（S-01）。

| 列 | 类型与约束 | 说明 |
|---|---|---|
| `id` | `INTEGER PRIMARY KEY CHECK (id = 1)` | 单行 |
| `github_id`、`login` | `INTEGER NOT NULL`、`TEXT NOT NULL` | 重新授权时新令牌必须属于同一个 GitHub id |
| `token_kind` | `TEXT NOT NULL CHECK (token_kind IN ('oauth','classic_pat'))` | classic PAT 是兜底，默认关闭 |
| `token_ct` | `BLOB` | 机器人令牌密文；解绑后置空 |
| `key_version` | `INTEGER` | |
| `scopes` | `TEXT NOT NULL` | 最近一次 `X-OAuth-Scopes` 原文 |
| `token_status` | `TEXT NOT NULL CHECK (token_status IN ('valid','invalid','revoked','scope_changed','unknown'))` | 取值同 API 的 A-12；解绑后为 `revoked` |
| `bound_by` | `INTEGER NOT NULL REFERENCES admins(github_id)` | |
| `bound_at`、`verified_at` | `INTEGER` | `verified_at`：每天 `GET /user` 校验一次 |

「暂停全部写入」不在这张表，存在 `settings` 的 `pause.writes`（behavior B-55）。

**`orgs`**：机器人所在的组织。

| 列 | 类型与约束 | 说明 |
|---|---|---|
| `github_id` | `INTEGER PRIMARY KEY` | |
| `login` | `TEXT NOT NULL` | |
| `membership_role` | `TEXT CHECK (membership_role IN ('member','admin'))` | `admin` 时后台标红 |
| `access_state` | `TEXT NOT NULL CHECK (access_state IN ('ok','oauth_restricted','unknown'))` | `oauth_restricted`：是成员，但仓库列表里没有该组织的私有仓库，需要组织批准 OAuth App |
| `checked_at`、`lost_at` | `INTEGER` | 不再是成员时写 `lost_at` |

**`repos`**：机器人能访问的仓库。能力开关放在这里（热路径、结构固定），其它按仓库的配置放在 `repo_overrides`；条件请求的 ETag 放在 `poll_cursors`，因为一个仓库有多个游标。

| 列 | 类型与约束 | 说明 |
|---|---|---|
| `id` | `INTEGER PRIMARY KEY` | API 里的 `repo_id` |
| `github_id` | `INTEGER NOT NULL UNIQUE` | 改名、转移后不变 |
| `owner_id` | `INTEGER NOT NULL` | 所有者（用户或组织）的 GitHub id |
| `owner_login`、`name` | `TEXT NOT NULL` | 显示和 API 路径用，发现时刷新 |
| `private`、`fork` | `INTEGER NOT NULL`，布尔 | |
| `default_branch` | `TEXT NOT NULL` | |
| `permission` | `TEXT NOT NULL CHECK (permission IN ('pull','triage','push','maintain','admin'))` | 来自 `permissions` 字段，每 10 分钟刷新 |
| `assignable` | `INTEGER`，布尔 | 可分配检查的结果（204 为 1，404 为 0）；未检查为空 |
| `state` | `TEXT NOT NULL CHECK (state IN ('active','archived','lost'))` | `archived`：GitHub 上已归档，只读，只监控、不做动作（B-05）；`lost`：失去访问权，优先于 `archived` |
| `sw_monitor`、`sw_review`、`sw_triage`、`sw_fix`、`sw_rework` | `INTEGER NOT NULL`，布尔 | 后台开关（B-01、B-02）；新仓库的 `sw_monitor` 按环境变量，其余为 0 |
| `write_mode` | `TEXT NOT NULL DEFAULT 'off' CHECK (write_mode IN ('off','dry_run','on'))` | 后台设置（B-03）；生效值还要和其它层取更严 |
| `paused` | `INTEGER NOT NULL DEFAULT 0`，布尔 | 仓库范围的暂停 |
| `last_activity_at` | `INTEGER` | 最近一次条目变动，决定是否降频（B-08） |
| `discovered_at`、`refreshed_at`、`lost_at` | `INTEGER` | |

索引：`(owner_login, name)`（不唯一，改名转移的过渡期可能重名）、`(state)`。开关的版本号在 `revisions` 的 `repo/<repo_id>/switches`。

**`repo_overrides`**：后台对单个仓库的配置覆盖，是配置优先级里的第 2 层（behavior.md「配置的来源与优先级」）。

| 列 | 类型与约束 | 说明 |
|---|---|---|
| `repo_id` | `INTEGER NOT NULL REFERENCES repos(id)` | |
| `key` | `TEXT NOT NULL` | behavior.md 的设置键，如 `followup.remind_after_days`；主键 `(repo_id, key)` |
| `value_json` | `TEXT NOT NULL` | 保存前校验 |
| `updated_by` | `INTEGER NOT NULL REFERENCES admins(github_id)` | 改仓库覆盖只归 owner，要求重新认证（清单见 [SECURITY](../../architecture/SECURITY.md) S-09） |
| `updated_at` | `INTEGER NOT NULL` | |

**`repo_profiles`**：每个仓库合并后的规则画像，只从 base 分支按 blob sha 读取（[ADR-0005](../../decisions/0005-rules-from-base-branch.md)）。

| 列 | 类型与约束 | 说明 |
|---|---|---|
| `repo_id` | `INTEGER PRIMARY KEY REFERENCES repos(id)` | |
| `base_ref`、`base_sha` | `TEXT NOT NULL` | 读规则用的分支和当时的提交 |
| `sources_json` | `TEXT NOT NULL` | 每个来源文件的路径和 blob sha（缓存键），包括组织 `.github` 仓库的来源：`.github/geek-bot.yml`，以及目标仓库没有时回退使用的 CONTRIBUTING、issue 模板、PR 模板（B-07） |
| `profile_json` | `TEXT NOT NULL` | 合并后的机器可执行字段（RepoProfile，schema 由 #10 定） |
| `suggested_json` | `TEXT` | 从散文规范提取的建议画像；版本号在 `revisions` 的 `repo/<repo_id>/suggestion` |
| `confirmed_by`、`confirmed_at` | `INTEGER` | owner 确认影响写入的字段；为空时该仓库修复通道关闭（B-07） |
| `built_at` | `INTEGER NOT NULL` | |

**`poll_cursors`**：条件请求的游标。

| 列 | 类型与约束 | 说明 |
|---|---|---|
| `scope` | `TEXT PRIMARY KEY` | `repo/<repo_id>/issues`、`repo/<repo_id>/pulls`、`discovery/user_repos/<页>`、`discovery/user_orgs`、`discovery/memberships` |
| `repo_id` | `INTEGER REFERENCES repos(id)` | 发现类游标为空 |
| `etag` | `TEXT` | 上一次 200 响应的 ETag |
| `polled_at`、`changed_at` | `INTEGER` | `changed_at`：最近一次返回 200 |
| `next_poll_at` | `INTEGER NOT NULL` | 按 B-08、B-09 算 |

索引：`(next_poll_at)`。仓库变成 `lost` 后删除它的游标。

### 条目与等回复

**`items`**：每个 issue 和 PR 一行。静默计时、已审 head、人是否重开过都在这里；等回复的状态机在一对一的 `threads` 表。

| 列 | 类型与约束 | 说明 |
|---|---|---|
| `repo_id`、`number` | `INTEGER NOT NULL` | `UNIQUE (repo_id, number)` |
| `kind` | `TEXT NOT NULL CHECK (kind IN ('issue','pr'))` | |
| `author_id` | `INTEGER NOT NULL` | |
| `by_bot` | `INTEGER NOT NULL`，布尔 | 机器人账号开的（B-16） |
| `from_fork` | `INTEGER`，布尔 | PR 的 head 在 fork 仓库（B-17） |
| `state` | `TEXT NOT NULL CHECK (state IN ('open','closed','merged'))` | |
| `draft` | `INTEGER`，布尔 | |
| `head_sha`、`base_ref` | `TEXT` | PR 当前的 head 和目标分支 |
| `assignee_ids_json`、`labels_json` | `TEXT NOT NULL` | 接不接的判定用 |
| `linked_prs_json` | `TEXT` | issue 的开着的关联 PR 编号（behavior.md「关联 PR」） |
| `gh_updated_at` | `INTEGER NOT NULL` | GitHub 的 `updated_at` |
| `last_human_at` | `INTEGER` | 最后一次非机器人变动，静默窗口起点（B-10、B-11） |
| `eligible_at` | `INTEGER` | `last_human_at` 加静默窗口 |
| `intake` | `TEXT NOT NULL CHECK (intake IN ('pending','queued','skipped','waiting','done'))` | 受理状态 |
| `skip_reason`、`next_check_at` | `TEXT`、`INTEGER` | 不接的原因和下次检查时间，后台「未接的 issue」显示 |
| `reviewed_head_sha`、`last_review_at` | `TEXT`、`INTEGER` | 最近一次已发出的审查（B-19、B-20）；对应的 outbox 行 `confirmed` 后写 |
| `human_reopened_at` | `INTEGER` | 人重开 issue 的时间；非空时机器人不再关（B-37） |
| `merged_at`、`closed_at` | `INTEGER` | |

索引：`(repo_id, state)`、`(intake, eligible_at)`。

**`threads`**：issue 的等回复与关闭状态，只对 issue。追问过的 issue 有一行；机器人没追问就直接关闭的（价值不高、重复），关闭时建一行，`rounds` 为 0。到期时间在追问发出时按当时的配置算好落库，之后改天数只影响新的追问。

| 列 | 类型与约束 | 说明 |
|---|---|---|
| `item_id` | `INTEGER PRIMARY KEY REFERENCES items(id)` | |
| `status` | `TEXT NOT NULL CHECK (status IN ('waiting','replied','resolved','closed'))` | `waiting` 等回复；`replied` 收到回复待跟进；`resolved` 已说清楚，转入受理或改写；`closed` 机器人已关闭 |
| `rounds` | `INTEGER NOT NULL DEFAULT 0` | 已追问轮数，不超过 `max_rounds`（B-34） |
| `asked_at` | `INTEGER` | 本轮追问在 GitHub 上确认发出的时间，计时起点 |
| `remind_at`、`close_at` | `INTEGER` | 本轮的提醒和关闭时间（B-32、B-33） |
| `reminded_at` | `INTEGER` | 本轮已提醒 |
| `body_sha256` | `TEXT` | 追问时的正文哈希，用来判断作者是否改了正文（B-31） |
| `replied_at`、`replied_by` | `INTEGER` | |
| `rewritten_to` | `INTEGER` | 改写后新 issue 的编号（B-36） |
| `close_reason` | `TEXT CHECK (close_reason IN ('no_reply','unclear_after_followup','low_value','duplicate','superseded_by_rewrite'))` | 机器人关闭的原因，与 [写入白名单](write-whitelist.md) W-08 的 `close_reason` 逐字一致：到期无人回复（B-33）、追问轮数用完仍不清楚（B-34）、价值不高（B-35）、重复（B-35）、被改写重开的新 issue 取代（B-36） |

索引：`(status, remind_at)`、`(status, close_at)`。确定性动作按这两个索引扫描到期的线程。

**`bot_writes`**：机器人自己的写入。轮询看到这些写入时不重新计时静默窗口（B-11）。

| 列 | 类型与约束 | 说明 |
|---|---|---|
| `repo_id` | `INTEGER REFERENCES repos(id)` | 不落在仓库上的写入（接受邀请、吊销令牌）为空 |
| `number` | `INTEGER` | 所在的 issue 或 PR；推送时为空 |
| `kind` | `TEXT NOT NULL CHECK (kind IN ('review','comment','comment_edit','label','close','issue_create','push','pr_create','invitation','token_revoke'))` | |
| `github_ref` | `TEXT` | 写入对象在 GitHub 上的 id：评论 id、review id、提交 SHA 或新 issue 编号 |
| `outbox_id` | `INTEGER REFERENCES outbox(id)` | |
| `written_at` | `INTEGER NOT NULL` | GitHub 返回的时间 |

outbox 行在对象 id 和标记写进这张表后才算 `confirmed`。索引：`(repo_id, number, written_at)`。保留期由 #9 按体积定，至少要长于静默窗口加一个轮询间隔；定之前不自动删除。

### 任务与执行

**`tasks`**：任务队列。派发时在同一个事务里改 `tasks` 并写 `leases`（ADR-0003）。

| 列 | 类型与约束 | 说明 |
|---|---|---|
| `id` | `TEXT PRIMARY KEY` | 随机 id，出现在节点协议和隐藏标记里 |
| `item_id` | `INTEGER REFERENCES items(id)` | 规则画像提取任务为空 |
| `repo_id` | `INTEGER NOT NULL REFERENCES repos(id)` | |
| `kind` | `TEXT NOT NULL CHECK (kind IN ('review','triage','followup','fix','rework','profile'))` | 前五种同 `@geek-bot/protocol` 的 `TASK_KINDS`；`profile` 由 #10 加进 protocol |
| `channel`、`executor` | `TEXT NOT NULL` | `issue`/`pr`、`sandbox`/`vm`，取值同 protocol |
| `reason`、`priority` | `TEXT NOT NULL`、`INTEGER NOT NULL` | 入队来由（如 `review_others_pr`）和按 `priority.pr`、`priority.issue` 取的优先级 |
| `status` | `TEXT NOT NULL CHECK (status IN ('queued','leased','running','cancelling','pending_publish','done','failed','cancelled','superseded'))` | `cancelling`：已下发取消，等节点回报；`pending_publish`：结果已收到，等 publisher |
| `head_sha` | `TEXT` | 审查、返工对应的 head |
| `dry_run` | `INTEGER NOT NULL`，布尔 | 入队时的生效写入模式 |
| `eligible_at` | `INTEGER NOT NULL` | |
| `bumped_by` | `INTEGER REFERENCES admins(github_id)` | 后台「提到最前」（B-52） |
| `infra_retries` | `INTEGER NOT NULL DEFAULT 0` | 不超过 `GEEK_BOT_INFRA_RETRY_MAX`（B-53）；重新排队时清零 |
| `excluded_nodes_json`、`required_labels_json` | `TEXT NOT NULL DEFAULT '[]'` | 派发过滤；重新排队时清空 `excluded_nodes_json` |
| `min_trust` | `TEXT NOT NULL CHECK (min_trust IN ('high','standard'))` | 私有仓库为 `high`（B-54） |
| `bundle_sha256`、`bundle_bytes` | `TEXT`、`INTEGER` | 任务包校验值 |
| `failure` | `TEXT` | 失败或放弃的原因，包括复核时哪条条件变了（B-41） |
| `created_at`、`started_at`、`finished_at` | `INTEGER` | |

索引：`(status, channel, priority, eligible_at)`（派发）、`(repo_id, status)`；部分唯一索引 `UNIQUE (item_id) WHERE status IN ('queued','leased','running','cancelling','pending_publish')`，保证同一条目同时最多一个活跃任务（B-13）。同一仓库的写入类任务数由调度代码按 `GEEK_BOT_MAX_WRITE_TASKS_PER_REPO` 控制。行永久保留；大字段按 `task_events`、`task_results` 的保留期清理。任务包文件在任务进入终态后删除（保留时长由 #11 定）。

**`leases`**：租约，一个租约是 `(task_id, lease_id, epoch, node_id)`。任务相关的节点请求带的 `lease_id` 和 `epoch` 与这里的 `active` 行不符时，节点 API 返回 409 `lease_fenced`（[节点协议](../node/protocol.md)）。

| 列 | 类型与约束 | 说明 |
|---|---|---|
| `id` | `TEXT PRIMARY KEY` | lease_id |
| `task_id` | `TEXT NOT NULL REFERENCES tasks(id)` | |
| `node_id` | `INTEGER NOT NULL REFERENCES nodes(id)` | |
| `epoch` | `INTEGER NOT NULL` | 从 1 起；每次收回或重派同一任务加 1 |
| `state` | `TEXT NOT NULL CHECK (state IN ('active','completed','fenced'))` | |
| `end_reason` | `TEXT CHECK (end_reason IN ('finished','reclaimed','unacked','cancelled','superseded','requeued','token_reset','node_restart'))` | 租约结束的原因；`finished` 对应 `completed`，其余对应 `fenced` |
| `phase` | `TEXT` | 续租时上报的阶段 |
| `last_event_seq` | `INTEGER NOT NULL DEFAULT 0` | 已确认的事件序号；事件按 seq 幂等 |
| `granted_at` | `INTEGER NOT NULL` | |
| `acked_at` | `INTEGER` | 第一次续租的时间；超过 `ack_deadline_s` 还为空就作废 |
| `renewed_at`、`expires_at` | `INTEGER NOT NULL` | 最近一次续租和按 `lease_ttl_s` 算出的到期时间 |
| `ended_at` | `INTEGER` | |

约束：`UNIQUE (task_id, epoch)`；部分唯一索引 `UNIQUE (task_id) WHERE state = 'active'`。索引：`(node_id, state)`、`(state, expires_at)`。

**`task_events`**：任务时间线的摘要，只存状态变化、工具调用、错误、重试和降级；原始 JSONL 逐行追加到 `tasks/<任务 id>/events.jsonl.gz`，不进库。

| 列 | 类型与约束 | 说明 |
|---|---|---|
| `task_id` | `TEXT NOT NULL REFERENCES tasks(id)` | |
| `epoch`、`seq` | `INTEGER NOT NULL` | 节点给的序号；主键 `(task_id, epoch, seq)` |
| `at` | `INTEGER NOT NULL` | |
| `type` | `TEXT NOT NULL CHECK (type IN ('status','tool','error','retry','fallback'))` | |
| `summary` | `TEXT NOT NULL` | 节点打码后的摘要，长度有上限 |

保留 `GEEK_BOT_TASK_DATA_RETENTION_DAYS`（默认 30 天），行和原文文件一起删；原文总量上限由 #14 定。

**`task_results`**：节点回报的结构化结果，每个租约最多记一次，只接受 epoch 匹配的一份。结果只进入「待发布」，节点从不写 GitHub。

| 列 | 类型与约束 | 说明 |
|---|---|---|
| `task_id` | `TEXT PRIMARY KEY REFERENCES tasks(id)` | |
| `lease_id`、`epoch` | `TEXT NOT NULL`、`INTEGER NOT NULL` | 回报时的租约 |
| `status` | `TEXT NOT NULL CHECK (status IN ('succeeded','failed','timed_out','cancelled'))` | `timed_out`：超过任务时限 |
| `schema` | `TEXT` | 结果 schema 名，如 `review.v1`、`triage.v1`、`patch.v1` |
| `valid`、`invalid_reason` | `INTEGER NOT NULL`、`TEXT` | schema 校验结果 |
| `result_json` | `TEXT` | 校验并打码后的结构化结果 |
| `artifact_path`、`artifact_sha256` | `TEXT` | 补丁等产物在 `tasks/<任务 id>/` 下的相对路径和哈希 |
| `usage_json` | `TEXT` | 节点回报的用量 |
| `received_at` | `INTEGER NOT NULL` | |

`result_json` 和产物文件在 `GEEK_BOT_TASK_DATA_RETENTION_DAYS` 后清空（已发到 GitHub 的内容以 GitHub 为准），其余列永久保留。

**`model_attempts`**：模型尝试记录。中继每个请求记一行（`source='relay'`，可信的一方）；runner 回报的每次尝试也记一行（`source='runner'`），后台时间线把两边对照显示。

| 列 | 类型与约束 | 说明 |
|---|---|---|
| `task_id`、`epoch` | `TEXT NOT NULL`、`INTEGER NOT NULL` | |
| `source` | `TEXT NOT NULL CHECK (source IN ('relay','runner'))` | |
| `model_id`、`effort` | `TEXT NOT NULL` | catalog id 与思考档位 |
| `started_at`、`ended_at` | `INTEGER` | |
| `http_status` | `INTEGER` | 中继记录的上游状态码 |
| `outcome` | `TEXT NOT NULL CHECK (outcome IN ('ok','error','timeout','rate_limited','interrupted','context_overflow','cancelled','budget_exhausted','invalid_result'))` | 降级依据（B-57）；`budget_exhausted` 不降级到下一个模型 |
| `prompt_tokens`、`completion_tokens` | `INTEGER` | |

索引：`(task_id)`。保留同 `task_events`。

**`model_pools`**：按任务类型的模型池，每个池 1 到 8 项。保存时整池替换（一个事务），版本号在 `revisions` 的 `model_pool/<任务类型>`，写审计，并生成 omp 用的 `modelRoles` 和 `fallbackChains`。

| 列 | 类型与约束 | 说明 |
|---|---|---|
| `task_kind` | `TEXT NOT NULL CHECK (task_kind IN ('review','triage','followup','fix','rework','profile'))` | |
| `position` | `INTEGER NOT NULL` | 从 0 起，小的先用；主键 `(task_kind, position)` |
| `model_id` | `TEXT NOT NULL` | 必须在 catalog 里；catalog 里消失的后台标红 |
| `effort` | `TEXT NOT NULL` | 必须是该模型在 catalog 里的档位；没有 efforts 的只能是 `off` |
| `updated_by`、`updated_at` | `INTEGER NOT NULL` | |

**`relay_tokens`**：每任务模型令牌，限定池内模型、请求数、token 预算和租约期（S-02）。

| 列 | 类型与约束 | 说明 |
|---|---|---|
| `token_hash` | `BLOB PRIMARY KEY` | 令牌的 SHA-256；明文只在 TaskSpec、节点内存、sandbox 或 VM 里 |
| `task_id`、`lease_id` | `TEXT NOT NULL` | |
| `models_json` | `TEXT NOT NULL` | 允许的模型，取自本任务的池 |
| `max_requests`、`max_tokens` | `INTEGER NOT NULL` | 预算 |
| `used_requests`、`used_tokens` | `INTEGER NOT NULL DEFAULT 0` | |
| `issued_at`、`revoked_at` | `INTEGER` | 租约结束、任务取消或 epoch 变化时吊销 |

索引：`(lease_id)`。吊销后由清理任务删除。

### 节点

**`nodes`**：工作节点。库里只存管理状态；`needs_upgrade` 由协议版本推出，`stale`、`offline`、`lost` 由 `last_heartbeat_at` 推出，都不存列（[节点协议](../node/protocol.md)「节点状态」）。

| 列 | 类型与约束 | 说明 |
|---|---|---|
| `id` | `INTEGER PRIMARY KEY` | API 里的 `node_id`；重置令牌后不变 |
| `name` | `TEXT NOT NULL UNIQUE` | 规则同节点的 `GEEK_BOT_NODE_NAME`；节点心跳带的名称必须与这里一致 |
| `status` | `TEXT NOT NULL CHECK (status IN ('pending','cordoned','active','draining','disabled'))` | owner 在后台添加节点、生成节点令牌时为 `pending`，第一次心跳后 `cordoned`，owner 或 operator 解除后 `active`；移除后 `disabled` |
| `trust` | `TEXT NOT NULL DEFAULT 'standard' CHECK (trust IN ('high','standard'))` | 调到 `high` 只归 owner，要求重新认证（清单见 [SECURITY](../../architecture/SECURITY.md) S-09；B-54） |
| `labels_json` | `TEXT NOT NULL DEFAULT '[]'` | |
| `declared_slots_json` | `TEXT` | 节点声明的槽位上限 `{sandbox, vm}` |
| `slots_json` | `TEXT NOT NULL` | 后台设置的实际值，不超过声明 |
| `version`、`protocol`、`boot_id` | `TEXT`、`INTEGER`、`TEXT` | `boot_id` 变化说明节点重启过，缺少的租约作废重排 |
| `last_heartbeat_at` | `INTEGER` | |
| `health_json`、`self_check_json` | `TEXT` | 最近一次健康数据和自检结果 |
| `cordon_reason` | `TEXT` | 管理员填的原因，或健康门控的原因（温度、磁盘、电源等） |
| `created_by`、`created_at` | `INTEGER NOT NULL` | |

版本号在 `revisions` 的 `node/<node_id>`。

**`node_tokens`**：节点令牌。没有单独的加入令牌：owner 重新认证后在后台生成节点令牌（256 位，只显示一次），运维把它放进节点宿主的密钥文件，节点从 `GEEK_BOT_NODE_TOKEN_FILE` 读取；库里只存 SHA-256（[SECURITY](../../architecture/SECURITY.md) 密钥表、[ADR-0003](../../decisions/0003-single-writer-control.md)）。

| 列 | 类型与约束 | 说明 |
|---|---|---|
| `node_id` | `INTEGER NOT NULL REFERENCES nodes(id)` | |
| `token_hash` | `BLOB NOT NULL UNIQUE` | 节点令牌的 SHA-256 |
| `created_by` | `INTEGER NOT NULL REFERENCES admins(github_id)` | 生成它的 owner |
| `created_at` | `INTEGER NOT NULL` | |
| `first_used_at`、`last_used_at` | `INTEGER` | 第一次和最近一次成功认证的时间 |
| `revoked_at` | `INTEGER` | 重置令牌或移除节点时写；旧令牌立即返回 401 |

部分唯一索引：`UNIQUE (node_id) WHERE revoked_at IS NULL`，保证一个节点同时只有一枚有效的令牌。重置令牌在一个事务里作废旧行、写新行，并收回该节点的全部租约。作废的行保留，用于审计。

**`node_health_samples`**：节点健康曲线。

| 列 | 类型与约束 | 说明 |
|---|---|---|
| `node_id`、`at` | `INTEGER NOT NULL` | 每分钟一点；主键 `(node_id, at)` |
| `sample_json` | `TEXT NOT NULL` | CPU 负载、温度、可用内存、PSI、磁盘与 VM 工作目录的可用空间、电源等，字段由 protocol 定义 |

保留 `GEEK_BOT_HEALTH_SAMPLE_RETENTION_DAYS`（默认 7 天）。

### GitHub 写入

**`outbox`**：publisher 的写入队列，保证同一件事只写一次（[写入白名单](write-whitelist.md)、S-06）。

| 列 | 类型与约束 | 说明 |
|---|---|---|
| `dedupe_key` | `TEXT NOT NULL` | 同一逻辑写入的唯一键：写入类型、目标，加上对这次写入稳定的键（被审的 head、追问轮次等），不含任务 id；组成以 [写入白名单](write-whitelist.md)「幂等与 outbox」为准 |
| `task_id` | `TEXT REFERENCES tasks(id)` | 只作追溯，不参与去重；确定性动作和后台触发的写入为空 |
| `target_kind` | `TEXT NOT NULL CHECK (target_kind IN ('repo','user','app'))` | `repo`：落在某个仓库上的写入；`user`：机器人账号自身，例如接受协作邀请（W-13）；`app`：OAuth App，例如吊销令牌（W-14） |
| `repo_id`、`number` | `INTEGER`、`INTEGER` | `target_kind` 为 `repo` 时 `repo_id` 必填，其余为空 |
| `action` | `TEXT NOT NULL` | 白名单允许项编号（W-xx） |
| `request_json` | `TEXT NOT NULL` | 方法、路径和参数，已中和；不含令牌 |
| `marker` | `TEXT NOT NULL` | 这条写入的隐藏标记（B-62） |
| `status` | `TEXT NOT NULL CHECK (status IN ('pending','sending','sent','confirmed','failed','rejected','dry_run','unknown'))` | 见下 |
| `reject_code` | `TEXT` | 被白名单拒绝时的拒绝项编号（D-xx） |
| `attempts`、`next_attempt_at` | `INTEGER` | |
| `github_ref` | `TEXT` | 写成后的评论 id、review id、提交 SHA 或 issue 编号 |
| `last_error` | `TEXT` | 不含令牌 |
| `created_at`、`sent_at`、`confirmed_at` | `INTEGER` | |

状态机以 [写入白名单](write-whitelist.md)「幂等与 outbox」为准，这里照抄：`pending → sending → sent → confirmed | failed | rejected | dry_run | unknown`。

- `sending`：在同一个事务里改状态后才发请求。
- `sent`：GitHub 返回成功，记下对象 id。
- `confirmed`：对象 id 和隐藏标记已经写进 `bot_writes`；推送类另外用 `ls-remote` 核对过远端 sha。
- `failed`：GitHub 明确拒绝（限额以外的 4xx），不自动重试，后台显示原因。
- `rejected`：白名单或发送前复核（B-41）拒绝，记下 D 编号并写审计，不重试。
- `dry_run`：生效的写入模式是 `dry_run`，只保存渲染好的请求，后台显示「未发布」。
- `unknown`：请求可能已经发出，但没有拿到确定的结果：超时、连接中断、5xx、临时错误的重试次数用完，或进程在 `sending` 时崩溃（重启时这些行都转成 `unknown`）。`unknown` 不盲目重发：先按标记到 GitHub 核对，找到就置 `confirmed` 并补 `github_ref`，确认没有才重新跑前置核对后重发。

`dedupe_key` 用部分唯一索引 `UNIQUE (dedupe_key) WHERE status NOT IN ('failed','rejected')`：失败和被拒的行不参与，同一件事可以重新插入一行再试，与白名单 C-10 一致。其它索引：`(status, next_attempt_at)`、`(repo_id, number)`。非终态的行永不自动删除；终态行的保留期由 #9 按体积定，定之前不自动删除。

**`bot_branches`**：机器人推过的分支。publisher 推送前核对：分支登记在这里或是新建的；新提交必须是 `head_sha` 的后代（只快进）。

| 列 | 类型与约束 | 说明 |
|---|---|---|
| `repo_id`、`branch` | `INTEGER NOT NULL`、`TEXT NOT NULL` | 主键 `(repo_id, branch)`；分支名符合画像的分支模板 |
| `item_id` | `INTEGER REFERENCES items(id)` | 对应的 issue |
| `pr_number` | `INTEGER` | 机器人开的 PR |
| `head_sha` | `TEXT NOT NULL` | 最近一次推送的提交 |
| `state` | `TEXT NOT NULL CHECK (state IN ('open','merged','closed'))` | |
| `created_at`、`pushed_at` | `INTEGER NOT NULL` | |

行永久保留；机器人不删分支，GitHub 上的分支由人或仓库自己的规则删除。

### 运维

**`alerts`**：告警。同一件事只有一条未解决的告警，重复发生只加计数。

| 列 | 类型与约束 | 说明 |
|---|---|---|
| `kind` | `TEXT NOT NULL` | 例如 `backup_failed`、`backup_verify_failed`、`node_offline`、`writes_paused`、`catalog_model_missing`、`pool_empty`、`rebuilt_from_github` |
| `severity` | `TEXT NOT NULL CHECK (severity IN ('info','warning','critical'))` | |
| `subject` | `TEXT NOT NULL` | 对象，如 `node/<node_id>`、`repo/<repo_id>`、`backup/<id>` |
| `message` | `TEXT NOT NULL` | 不含密钥、令牌 |
| `first_at`、`last_at`、`count` | `INTEGER NOT NULL` | |
| `acked_by`、`acked_at` | `INTEGER` | |
| `resolved_at` | `INTEGER` | |

部分唯一索引：`UNIQUE (kind, subject) WHERE resolved_at IS NULL`。已解决告警的保留期由 #20 定，定之前不自动删除。

**`audit_logs`**：审计记录，只追加（S-16）。迁移里给它建 `BEFORE UPDATE` 和 `BEFORE DELETE` 触发器，执行 `RAISE(ABORT)`，代码没法改或删已有记录。

| 列 | 类型与约束 | 说明 |
|---|---|---|
| `at` | `INTEGER NOT NULL` | |
| `actor_type` | `TEXT NOT NULL CHECK (actor_type IN ('user','bot','system','node','cli'))` | `user`：后台账号（任一角色）；`bot`：publisher 代机器人写入，`actor_id` 是任务 id |
| `actor_id` | `TEXT` | 后台账号的 GitHub 数字 id、任务 id 或节点 id |
| `action` | `TEXT NOT NULL` | 例如 `repo.switch.enable`、`bot.bind`、`node.token.reset`、`settings.update`、`task.bump`、`publisher.allow`、`publisher.reject`、`publisher.dry_run` |
| `code` | `TEXT` | 相关的白名单编号：允许写 W-xx，拒绝写命中的 D-xx |
| `target` | `TEXT` | |
| `detail_json` | `TEXT` | 原因和变更前后的值；不含密钥、令牌和会话 id |
| `reauth` | `INTEGER NOT NULL`，布尔 | 这次操作前 10 分钟内是否重新认证过 |

索引：`(at)`、`(action)`。永久保留。

**`backups`**：备份文件登记。备份完成后才写这一行，所以一份备份里不含它自己的登记；从备份恢复后，control 启动时扫描 `backups/` 目录补齐缺的行。

| 列 | 类型与约束 | 说明 |
|---|---|---|
| `kind` | `TEXT NOT NULL CHECK (kind IN ('daily','weekly','pre_deploy','pre_migration','manual'))` | 每周第一次每日备份记为 `weekly`；`GEEK_BOT_BACKUP_KEEP_WEEKLY` 为 0 时一律记为 `daily` |
| `file` | `TEXT NOT NULL UNIQUE` | `backups/` 下的文件名 |
| `sha256`、`bytes` | `TEXT NOT NULL`、`INTEGER NOT NULL` | 加密后文件的哈希和大小 |
| `schema_version`、`compat_version`、`app_version` | `INTEGER NOT NULL`、`INTEGER NOT NULL`、`TEXT NOT NULL` | 备份时的 `user_version`、兼容版本和镜像版本 |
| `backup_key_id` | `TEXT NOT NULL` | 加密用的备份密钥的指纹（不是密钥本身），轮换后据此找对应的离线密钥。#3 的算法：`sha256("geek-bot/backup-key/v1\0" ‖ 密钥)` 的前 16 位十六进制 |
| `row_counts_json` | `TEXT NOT NULL` | 备份时各表的行数，恢复校验时核对 |
| `created_at` | `INTEGER NOT NULL` | |
| `verified_at`、`verify_result`、`verify_detail` | `INTEGER`、`TEXT CHECK (verify_result IN ('ok','failed'))`、`TEXT` | 每日恢复校验的结果 |
| `pruned_at` | `INTEGER` | 文件按保留策略删除的时间 |

## 迁移规则

依据 [ADR-0008](../../decisions/0008-sqlite-migrations-recovery.md)。不引入 ORM 或迁移框架。

**文件**

- 放在 `app/control/src/db/migrations/`，文件名 `NNNN_<slug>.sql`：编号四位，从 `0001` 起连续，不跳号、不复用；slug 只用小写字母、数字和下划线。
- 第一行必须是 `-- geek-bot-migration shrink=false` 或 `shrink=true`，写进 `schema_migrations.shrink`。
- 迁移文件进入 `stage` 后不再修改；写错了就再写一个新的迁移。启动时的 sha256 核对保证这一点。
- 文件里不写 `BEGIN`、`COMMIT`：迁移器给每个文件开事务。构建时 `app/control/scripts/copy-migrations.mjs` 把它们复制进 `dist/db/migrations/`。

**只扩不缩**

- 允许：新建表；`ALTER TABLE … ADD COLUMN`（新列可空或带常量默认值）；新建索引和触发器；回填数据。
- 放宽枚举取值：SQLite 改不了已有的 `CHECK`，要按 SQLite 官方的重建表步骤在一个事务里完成（新建表、复制数据、删旧表、改名，结束前跑 `PRAGMA foreign_key_check`）。取值只增不减，仍算只扩不缩（`shrink=false`），但必须有「上一版代码能读写新库」的测试。重建时列要原样保留，索引和触发器在改名之后照抄原文重建，否则迁移器按收缩拒绝（见下文「迁移器强制的部分」）。
- 重建表的限制：**被别的表外键引用的表不能用这个办法重建**。迁移在事务里执行，库连接一直开着 `foreign_keys`，事务里的 `PRAGMA foreign_keys=OFF` 不生效；`DROP TABLE` 会先对旧表做一次隐式的 `DELETE`，子表的外键是 `ON DELETE CASCADE` 时子表的行会被悄悄删掉，否则迁移直接失败。迁移器现在不支持这类迁移；确实需要时先写 ADR，设计好在事务外关闭外键、重建后再核对的步骤。
- 不允许：删表、删列、改列类型、改列或表的含义、给已有列加 `NOT NULL`、收紧 `CHECK`。不再使用的列留在库里，并在本文标「弃用」。
- 确实需要收缩时标 `shrink=true`，同时另写一篇 ADR 并取得所有者批准。收缩类迁移会抬高兼容版本，之后上一版镜像打不开这个库，回滚只能恢复迁移前的备份。
- 新列可空或有默认值，所以上一版代码插入的行仍然合法；新代码要容忍回滚期间旧代码写入的、新列为空的行。

**迁移器强制的部分**（#3）

- 声明 `shrink=false` 的文件，迁移器在同一个事务里比较执行前后库的真实结构：已有的表、列（声明类型、`NOT NULL`、主键位置）、索引、触发器、视图（建它的原文）少了或变了，就回滚这个文件并拒绝启动。比较的是 SQLite 执行之后的结构，所以大小写、注释、一个文件里写多条语句都绕不过去；按上面的步骤原样重建表不算收缩。
- 已应用的迁移文件 sha256 不能变、`schema_migrations` 的编号从 1 起连续、兼容版本不高于代码，见下文「启动时的检查」。
- 结构上看不出来的收缩迁移器查不出：改列或表的含义、收紧 `CHECK`、改外键、改默认值、删数据。这些仍靠审查（[CODE-REVIEW](../../conventions/CODE-REVIEW.md) 第 10 项）。

**兼容版本**

- 库里有两个数：`PRAGMA user_version`（执行到第几号迁移，记为 D）和兼容版本（`schema_migrations` 里编号最大那一行的 `compat_version`，记为 K）。只有收缩类迁移会抬高 K。
- 代码认识的最高迁移编号记为 C。

**启动时的检查**（在接受任何请求之前）

1. 读 D、K 和 C。D 为 0 而库里已经有表（不是 geek_bot 的库，或被手工改过），`schema_migrations` 的编号不是从 1 起连续，或者 D 与它的最大编号对不上，拒绝启动。
2. 核对 `schema_migrations` 里每个不大于 C 的迁移，sha256 与代码里的文件一致；不一致就拒绝启动。
3. K 大于 C：库做过这份代码不认识的收缩，拒绝启动。
4. D 小于 C：先做一次 `pre_migration` 备份（空库 D 为 0 时没有可备份的数据，跳过；备份失败就不迁移、拒绝启动），再按编号逐个执行。每个文件在自己的事务里执行，同一个事务里写 `schema_migrations`、设 `PRAGMA user_version` 并跑 `PRAGMA foreign_key_check`；任何一个失败就回滚这个文件并拒绝启动，库停在上一个版本。
5. D 大于 C 而 K 不大于 C：这是回滚到上一版镜像的情形，正常启动、正常读写，不执行迁移；后台概览显示库版本比代码新。
6. 其余情况（D 等于 C）正常启动。

拒绝启动时用中文输出原因，以非 0 退出，健康检查失败，部署脚本按健康门回滚（#7）。`/readyz` 的库相关条件与此一致：库可写、K 不大于 C、D 不小于 C（没有待执行的迁移）才返回 200；所以回滚到上一版镜像时（D 大于 C、K 不大于 C）健康门能过。`/readyz` 的完整检查项见 [API](../../architecture/API.md)。上面的表示方式由 #3 定稿并实现（`app/control/src/db/migrator.ts`）；「上一版代码打开新库能启动、能读写」「兼容版本高于代码时拒绝启动」等由 `tests/control/database.test.ts` 与 `tests/control/server.test.ts` 证明。

## 备份与每日恢复校验

依据 ADR-0008 与 [SECURITY](../../architecture/SECURITY.md) S-17。

**触发**

- 每天一次：UTC 的 `GEEK_BOT_BACKUP_HOUR_UTC` 点（默认 3）之后，control 每 10 分钟检查一次，上一次 `daily` 或 `weekly` 备份早于最近一个到点时刻就做；control 停机错过的，启动后补做。本周（周一 00:00 UTC 起）还没有 `weekly` 时，这一次记为 `weekly`。
- 部署前由部署脚本请求一次（`pre_deploy`，#7）；迁移前由 control 自动做一次（`pre_migration`）；管理员可以在后台或用 CLI 手动做（`manual`）。

**做法**

1. 用 better-sqlite3 的在线 backup 把库复制到 `backups/` 里的临时文件，不停服务；
2. 打开临时文件（转成 DELETE 日志模式，成为一个自足的文件），统计各表行数，写进 `row_counts_json`；
3. 用备份加密密钥（`GEEK_BOT_BACKUP_KEY_FILE`，部署时是 `<栈根>/secrets/backup_key`，只挂给 control，不进备份）按下面的格式流式加密，算加密后文件的 sha256；
4. 改名进 `backups/`（`geek-bot-<种类>-<UTC 时间>-<随机>.gbbk`，权限 0600），写一行 `backups`，删除临时的明文文件，按保留策略清理。

**文件格式**（`app/control/src/ops/backup-file.ts`）：8 字节魔数 `GBBK0001`，4 字节头部长度，头部 JSON（加密参数与随机 IV、种类、时间、库版本 D、兼容版本 K、镜像版本、备份密钥指纹、各表行数），然后是 AES-256-GCM 密文和 16 字节认证标签。魔数、长度和头部整体作为附加认证数据：内容或头部被改动、密钥不对，都解不开。

master key 和备份加密密钥都不进备份，所有者各另存一份离线副本（密钥表见 [SECURITY](../../architecture/SECURITY.md)）。没有备份加密密钥，备份打不开；有备份没有原来的 master key，库里的机器人令牌解不开，要重新绑定机器人。

**保留**：每日备份保留 `GEEK_BOT_BACKUP_KEEP_DAILY` 份（默认 7），每周保留 `GEEK_BOT_BACKUP_KEEP_WEEKLY` 份（默认 4；为 0 时不做每周备份，每周第一次也记为 `daily`，免得刚做完就被清理）；`pre_deploy`、`pre_migration`、`manual` 各保留最近 3 份（#3 定稿，代码常量）。每次备份后按种类删掉最旧的多余文件，写 `pruned_at` 和审计；登记行保留。

**每日恢复校验**（自动，每天一次）

1. 取最新一份备份，核对文件的 sha256 与 `backups` 行一致；
2. 解密到临时文件；
3. `PRAGMA integrity_check` 返回 `ok`，`PRAGMA foreign_key_check` 没有结果；
4. `user_version` 等于 `schema_migrations` 里的最大编号；
5. 各表行数等于 `row_counts_json`；
6. 删除临时文件，写 `verified_at` 和 `verify_result`。

#3 在每天的备份做完后立即校验这一份；`geek-bot verify-backup` 可以随时手动校验。任何一步失败：`verify_result` 记 `failed`，写一条 `critical` 告警（`backup_verify_failed`，对象 `backup/<id>`），后台概览显示「最近一次恢复校验失败」（概览随 A-35）；之后有一次校验通过，就把未解决的 `backup_verify_failed` 标为已解决。备份本身失败写 `critical` 告警 `backup_failed`（对象 `backup/<种类>`），下一次检查时重试。

**异地副本**：可选，把加密后的备份文件复制到外置盘或 NAS 目录（配置项由 #20 定）。

**恢复**

- `restore --dry-run <文件>` 先做上面的校验（不碰库，只读备份文件和备份加密密钥），报告会恢复到哪个库版本和哪个时间点、这版代码能否直接打开，不改任何东西（#3 已实现）。
- 正式恢复由获授权的人执行，要求 control 已停止；恢复前把当前库另存一份。命令还没有实现，随 #20 的恢复演练写入。
- 恢复后启动 control：`outbox` 里 `sending` 的行转为 `unknown` 并按标记核对；恢复点之后 GitHub 上发生的事，按下一节补齐。

## 从 GitHub 重建状态

依据 ADR-0008 与 [ADR-0005](../../decisions/0005-rules-from-base-branch.md)。publisher 的每条写入在正文**最后一行**带隐藏标记 `<!-- geek-bot v1 env=<环境> kind=<写入类型> task=<任务 id> sha=<head 前 12 位> round=<轮次> -->`（behavior B-62）；第一行留给追踪记录头。

**什么时候用**：库丢了又没有可用备份；或者恢复了较旧的备份，要补上恢复点之后的状态。

**只信机器人账号自己写的标记**：任何人都能在评论里打出同样的文字，所以只采纳作者是机器人账号（按数字 id）、而且标记里的 `env` 等于本实例环境的记录。preview 和 production 共用一个机器人账号，`env` 用来区分两边的记录。

**能重建的**

| 状态 | 来源 |
|---|---|
| `threads.rounds`、`asked_at` | 机器人追问记录的标记（`round=`）和评论的创建时间 |
| `threads` 的到期时间 | `asked_at` 加上当前配置的天数（重新计算，不是原来落库的值） |
| `threads.reminded_at`、关闭状态 | 提醒和关闭记录的标记；issue 关闭事件的操作者 |
| `items.human_reopened_at` | issue 时间线里非机器人账号的重开事件 |
| `items.reviewed_head_sha` | review 标记里的 `sha=` 按前 12 位对应到 PR 的提交 |
| `bot_branches` | 机器人账号开的 PR 的 head 分支和提交 |
| `bot_writes`、`outbox` 中已确认的行 | 机器人账号发出的带标记的评论和 review；`dedupe_key` 由标记推出，防止重建后再写一遍 |

**不能重建的**（只能从备份恢复，或重新配置）：`admins`、`sessions`、`bot_account`（令牌要重新授权绑定）、`nodes` 与 `node_tokens`（节点要重新添加并换令牌）、`settings`、`repo_overrides`、`repo_profiles` 的管理员确认、`model_pools`、`tasks` 及其事件与结果历史、`model_attempts`、`audit_logs`、`alerts`、`backups` 的登记。

**步骤**

1. 以重建模式启动：写入模式强制 `dry_run`，并打开「暂停全部写入」；
2. 库丢失时，按首次部署重新认领、绑定机器人账号；
3. 发现仓库；
4. 对每个监控中的仓库，扫描开着的条目，以及最近 `GEEK_BOT_CATCHUP_WINDOW_HOURS`（默认 72 小时）内关闭或合并的条目，按上面的规则采纳标记；
5. 写入上表的状态，写审计，并写一条 `rebuilt_from_github` 告警，列出没法重建的数据；
6. owner 核对后在后台解除写入暂停。

**限制**：窗口之前关闭的条目不扫描，这部分历史不会重建；标记被人删掉或改掉的评论无法重建。整个流程未验证，由 #9（标记）、#16（追问线程）和 #20（恢复演练）实测。

## 验证（计划中）

- #3（已加入：`tests/control/database.test.ts`、`backup.test.ts`、`server.test.ts`、`cli.test.ts`）：空库迁到最新；上一版本的库迁到最新（夹具在运行时用迁移目录生成，库文件不入库）；上一版代码打开新库能启动、能读写；兼容版本高于代码时拒绝启动；迁移中途失败时库停在原版本；迁移文件被改动时拒绝启动；`audit_logs` 的更新和删除被触发器拒绝；备份、每日恢复校验、保留策略，以及校验失败时产生告警；第二个连接打不开 control 持有的库。
- #5：库里搜不到机器人令牌、会话 id、认领码、`gb_flow` 的明文；`rotate-master-key` 后旧密文全部换成新版本。
- #8、#11：部分唯一索引挡住同一条目的第二个活跃任务、同一任务的第二个 `active` 租约、同一节点的第二枚有效令牌；epoch 不匹配的结果被拒；重置令牌后旧令牌返回 401。
- #9：`unknown` 行按标记核对后不重复写；重建后 `dedupe_key` 挡住重复写入。
- #20：在另一台机器上从备份恢复，并按标记补齐恢复点之后的状态。

## 待定

- `bot_writes`、`outbox` 终态行、已解决告警的保留期没有定。`pre_deploy`、`pre_migration`、`manual` 备份各保留 3 份由 #3 定为代码常量，要改成可配置时另开 issue。
- `items`、`tasks` 行永久保留，库的增长速度由 #20 在正式实例上观察，必要时再定清理策略。
