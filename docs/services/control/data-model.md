# control 数据模型

> control 的 SQLite 表、密文与租约字段、去重约束，以及只扩不缩的迁移、加密备份和恢复边界。

状态：`current` · 更新：2026-10-03 · 适用：`app/control` 的 SQLite 库（#3 基础表、#34 共享平台）

结构来源是 `app/control/src/db/migrations/0001_foundation.sql` 与 `0002_shared_platform.sql`；写入语义来源是 `src/platform/`、`src/publisher/` 和 `src/ops/`。#34 按 [ADR-0012](../../decisions/0012-shared-cross-platform-workspace.md) 用连接、项目、需求和共享机器池取代单机器人账号设计。本文描述源码，不证明真实外部账号、KVM 或正式恢复已验收。

## 存储与通用约定

- 每个环境有自己的 `GEEK_BOT_DB_PATH`、密钥和数据卷，preview 与 production 不共享。
- control 是唯一写者。连接参数为 `journal_mode=WAL`、`synchronous=FULL`、`foreign_keys=ON`、`busy_timeout=5000`、`locking_mode=EXCLUSIVE`；第二个连接拿不到锁。运维写命令经库目录的 `run/control.sock` 交给运行中的 control，离线时独占打开库。
- 时间是 UTC Unix 毫秒 `INTEGER`；布尔和枚举用 `CHECK`；JSON 用 `TEXT`，列名以 `_json` 结尾。SQL 值参数化，动态列名只从代码白名单取。
- 后台管理员按 GitHub 数字 id 识别。项目用连接 id 与平台 external id 稳定识别；名称和平台路径用于显示与读取，不承担授权身份。
- 平台凭据存 `connection_credentials.credentials_ct` 的 AES-256-GCM 密文，短期 device code 存 `oauth_flows.device_code_ct`。只有 control 的相应读取或 publisher 路径解密；主密钥不进库或备份。
- 会话、认领票据、节点令牌和任务模型令牌只存 SHA-256 哈希。会话 cookie 另用独立 session key 签名。master、backup、session、OAuth secret 和模型 gateway key 经文件提供，不能混用。
- control 库目录有 `backups/`、`run/` 和 `tmp/`；任务包、结果和事件目前存库。节点的磁盘 spool 是转发缓冲，不是业务数据库。

## 当前表清单

两次迁移共建 24 张表。`0002` 是 `shrink=false` 的新增表迁移，不修改 `0001` 的表结构；兼容版本沿用原值。不存在单独的 `bot_account`、`repos`、`nodes`、`leases`、`task_results` 或 `outbox` 表。

| 表 | 主要内容与约束 | 写入者 |
|---|---|---|
| `schema_migrations` | 迁移编号、文件名、sha256、shrink、compat_version、app_version、applied_at | 迁移器 |
| `settings` | `key` 主键、`value_json`、更新人和时间；模型池用 `model_pool.<kind>` 键 | models 与基础配置 |
| `revisions` | `scope` 主键、revision、updated_at；模型池用 `model_pool.<kind>` scope | models |
| `idempotency_keys` | 主键 `(github_id, route, key)`，请求哈希、HTTP 状态与可空响应 | 后台幂等层 |
| `alerts` | kind、subject、严重度、次数、确认与解决时间；未解决的 `(kind, subject)` 唯一 | 告警服务 |
| `audit_logs` | 操作者、动作、原因和 reauth；触发器拒绝 UPDATE 与 DELETE | 审计服务 |
| `backups` | 文件、sha256、大小、版本、密钥指纹、行数与恢复校验结果 | 备份服务 |
| `admins` | github_id 主键，login、role、邀请信息；部分唯一索引保证只有一个 owner | auth 与 admins |
| `bootstrap_codes` | 唯一 code_hash、过期时间、失败次数、作废与使用时间 | auth / CLI |
| `claim_grants` | token_hash 主键，code_id 外键、创建与过期时间 | auth |
| `sessions` | id_hash 主键，github_id 外键、创建、最近访问、过期与重新认证时间 | auth |
| `oauth_flows` | purpose、browser_hash、发起票据、加密 device_code、轮询节奏和终态 | auth |
| `connections` | provider、唯一 name、base_url、启用、账号外部 id、权限与 revision | connections |
| `connection_credentials` | connection_id 主键及外键、credentials_ct、key_version | 连接凭据层 |
| `projects` | 稳定 id、连接外键、external_id、平台权限、处理开关、写入模式和机器范围；`(connection_id, external_id)` 唯一 | connections |
| `items` | 项目外键、issue/change、origin、编号、正文、head/base、作者事实、标签与负责人；`(project_id, kind, external_id)` 唯一 | 平台同步 |
| `demands` | 项目、来源连接、来源条目、状态与 revision；非空 item_id 唯一 | demands 与 intake |
| `intake_events` | 主键 `(connection_id, event_id)`、demand_id 和 received_at | IM 入站 |
| `machines` | 唯一 name、管理状态、信任、槽位、资源、声明、自检、boot_id/seq、唯一 token_hash、revision | machines 与节点心跳 |
| `tasks` | 项目、需求、条目快照、预算、执行器、状态、租约、模型令牌哈希、任务包和结果 | tasks、relay 与 publisher |
| `task_events` | 主键 `(task_id, seq)`，时间、kind、打码文本与 lease_id | 节点报告 |
| `model_usage` | task_id、lease_id、模型、档位、HTTP 状态、耗时、token 用量 | 模型中继 |
| `publications` | 任务/项目/连接外键、action、唯一 dedupe_key、状态、写入模式、payload、预览、外部引用与错误 | publisher |
| `im_publications` | 需求/任务/连接外键、source_ref、message、唯一 dedupe_key、状态、外部引用与错误 | IM publisher |

完整列、默认值、外键和索引以 SQL 为准。公共返回字段以 [protocol](../protocol/README.md) 和 [API](../../architecture/API.md) 为准，不把库行直接序列化给浏览器。

## 身份、连接和需求

owner、operator、viewer 共用实例数据，不建租户。管理员身份与平台连接分离；认领和登录不会自动把登录账号变成机器人连接。移除管理员会删除其会话，owner 不能移除。

device flow 的 purpose 为 `claim`、`login`、`reauth`、`connection`。browser_hash 将流程绑定到发起浏览器；device_code 是密文。会话空闲 2 小时、最长 12 小时，高危操作要求 10 分钟内重新认证。`claim_grants` 是核对认领码后的短期票据，不是后台会话。

新项目四类处理开关全关，write_mode 为 off。配置资源直接在自己的行保存 revision，模型池单独使用 `settings` 与 `revisions`。目录 catalog 来自只读文件，不建模型目录表。

需求来源为 manual、github、gitlab、feishu、webhook。数据库约束要求代码平台来源有 item_id，且有关联项目；其它来源没有 item_id。IM 事件去重与需求创建在同一事务完成。未关联项目不能派发，平台需求的项目和条目身份固定。

创建请求的成功响应保留 24 小时。`idempotency_keys` 在下一次幂等请求查询时清理过期行；同 key 不同正文返回 409。节点令牌类响应不保存明文，重放返回 `secret_already_issued`，不再发第二枚令牌。

## 任务、租约和事件

task 的状态为 queued、running、awaiting_publish、completed、failed、cancelled、superseded。需求另有 new、blocked、queued、running、completed、failed，不能直接套用任务状态。

当前租约直接存 `tasks.machine_id`、`lease_id`、`epoch`、`lease_expires_at`、`lease_acked_at` 和 `lease_request_key`。lease_id 唯一；续租、任务包和报告同时校验节点身份、租约、epoch 与有效期。收回或重排提升 epoch，旧结果返回 409。资源、槽位、标签、信任与项目机器范围的分配在同一写者事务里完成。

每个条目同时最多一个活跃任务、每项目最多一个活跃 fix/rework，由任务服务在事务里检查；不是 SQL 部分唯一索引。自动入队用 `(item_id, kind, item_version)` 查询去重，PR/MR 的版本是 head，issue 的版本是标题正文哈希。任务创建时冻结 item_snapshot_json，不从模型文本推导写入目标。

任务模型令牌哈希、冻结的模型池、请求/token 预算和用量也存 tasks。结果经校验和打码后存 result_json，result_lease_id 记录接受它的租约；相同租约的相同结果可重放，不同结果返回 409。没有平台条目的只读任务直接 completed；需要外部发布的结果进入 awaiting_publish。

事件按 `(task_id, seq)` 去重，另存 lease_id；接收事件之前先校验栅栏，响应 ack_seq 是该任务已保存的最大序号。当前没有库外 gzip 事件原文、独立租约历史表或健康采样曲线表。

## 持久 outbox

代码平台发布与 IM 回传分别用 publications、im_publications。状态取值都是 pending、sending、sent、confirmed、failed、rejected、dry_run、unknown；dedupe_key 是整表唯一，失败行也不通过插入新行绕过。

publisher 先落意图再发外部请求；重启后 sending 转 unknown。未知状态必须先核对，不能把超时或 5xx 当成没有发送。IM 入站与节点结果不等待网络回传才应答，回传由事务后的微任务排入 publisher。

实际动作子集和核对语义见 [写入白名单](write-whitelist.md) 的当前实现部分；旧设计中的 W/D 编号仍是安全基线，不能据本文声明其全部已经实现或验证。

## 保留与尚未实现的恢复

当前没有任务内容、事件、model_usage、平台条目、publication 终态的自动保留期清理。不要把原设计的 30 天写成已启用；数据库增长需要部署者观察。审计只追加，备份文件按下文策略保留。

正式恢复、异地副本、master key 轮换与从外部标记重建整个数据库仍未实现。当前 CLI 的 restore 只做 dry-run；没有可用备份时，不能从外部评论恢复管理员、凭据、机器令牌、任务历史或审计。

## 迁移规则

依据 [ADR-0008](../../decisions/0008-sqlite-migrations-recovery.md)。不引入 ORM 或迁移框架。

**文件**

- 放在 `app/control/src/db/migrations/`，文件名 `NNNN_<slug>.sql`：编号四位，从 `0001` 起连续，不跳号、不复用；slug 只用小写字母、数字和下划线。
- 第一行必须是 `-- geek-bot-migration shrink=false` 或 `shrink=true`，写进 `schema_migrations.shrink`。
- 迁移文件进入 `stage` 后不再修改；写错了就再写一个新的迁移。启动时的 sha256 核对保证这一点。
- 文件里不写 `BEGIN`、`COMMIT`、`END`、`ROLLBACK`、`SAVEPOINT`、`RELEASE`：迁移器给每个文件开事务。顶层写了这些语句的文件加载时就被拒绝（触发器语句体里的 `BEGIN … END`、`RAISE(ROLLBACK, …)` 不算）；执行时迁移器另在文件外面套一个随机名字的保存点，执行完先核对它还在，不在就说明文件自己结束了事务，这时改动可能已部分生效，迁移器拒绝启动并如实报告，要从迁移前备份恢复。构建时 `app/control/scripts/copy-migrations.mjs` 把它们复制进 `dist/db/migrations/`。

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
- 结构上看不出来的收缩迁移器查不出：改列或表的含义、收紧 `CHECK`、改外键、改默认值、删数据。一个典型的例子：先 `DROP TABLE settings`，再按原样 `CREATE TABLE settings (…)`，执行前后表、列、索引一样不差，结构核对照样通过，但表里的数据全没了。这些仍靠审查（[CODE-REVIEW](../../conventions/CODE-REVIEW.md) 第 10 项）。

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
- 部署前的 `pre_deploy` 由 #7 的部署脚本接入；迁移前由 control 自动做 `pre_migration`；现有 CLI 可以做 `manual`。当前后台没有备份操作页。

**做法**

1. 用 better-sqlite3 的在线 backup 把库复制到 `tmp/` 里的临时文件（先以 0600 建出空文件再写入），不停服务；明文不放 `backups/`（#20 会给它做异地副本），也不放系统临时目录；
2. 打开临时文件（转成 DELETE 日志模式，成为一个自足的文件），统计各表行数，写进 `row_counts_json`；
3. 用备份加密密钥（`GEEK_BOT_BACKUP_KEY_FILE`，部署时是 `<栈根>/secrets/backup_key`，只挂给 control，不进备份）按下面的格式流式加密，算加密后文件的 sha256；
4. 加密结果先写成 `backups/` 里以 `.tmp-` 开头的文件，再改名为 `geek-bot-<种类>-<UTC 时间>-<随机>.gbbk`（权限 0600），写一行 `backups`，删除 `tmp/` 里的明文，按保留策略清理。崩溃留下的 `.tmp-` 密文在下次启动时删除。

**文件格式**（`app/control/src/ops/backup-file.ts`）：8 字节魔数 `GBBK0001`，4 字节头部长度，头部 JSON（加密参数与随机 IV、种类、时间、库版本 D、兼容版本 K、镜像版本、备份密钥指纹、各表行数），然后是 AES-256-GCM 密文和 16 字节认证标签。魔数、长度和头部整体作为附加认证数据：内容或头部被改动、密钥不对，都解不开。

master key 和备份加密密钥都不进备份，所有者各另存一份离线副本（密钥表见 [SECURITY](../../architecture/SECURITY.md)）。没有备份加密密钥，备份打不开；有备份没有原来的 master key，库里的机器人令牌解不开，要重新绑定机器人。

**保留**：每日备份保留 `GEEK_BOT_BACKUP_KEEP_DAILY` 份（默认 7），每周保留 `GEEK_BOT_BACKUP_KEEP_WEEKLY` 份（默认 4；为 0 时不做每周备份，每周第一次也记为 `daily`，免得刚做完就被清理）；`pre_deploy`、`pre_migration`、`manual` 各保留最近 3 份（#3 定稿，代码常量）。每次备份后按种类删掉最旧的多余文件，写 `pruned_at` 和审计；登记行保留。

**每日恢复校验**（自动，每天一次）

1. 取最新一份备份，核对文件的 sha256 与 `backups` 行一致；
2. 解密到 `tmp/` 里的临时文件（0600）；
3. `PRAGMA integrity_check` 返回 `ok`，`PRAGMA foreign_key_check` 没有结果；
4. `user_version` 等于 `schema_migrations` 里的最大编号；
5. 各表行数等于 `row_counts_json`；
6. 删除 `tmp/` 里的临时文件，写 `verified_at` 和 `verify_result`。

#3 在每天的备份做完后立即校验这一份；`geek-bot verify-backup` 可以随时手动校验。任何一步失败会记录 failed，并写 critical 告警 backup_verify_failed；下一次通过后解决该告警。备份本身失败写 backup_failed，下一次检查重试。数据已持久化，当前后台没有恢复校验与告警管理页。

**异地副本**：可选，把加密后的备份文件复制到外置盘或 NAS 目录（配置项由 #20 定）。

**恢复**

- `restore --dry-run <文件>` 先做上面的校验（不碰库，只读备份文件和备份加密密钥），报告会恢复到哪个库版本和哪个时间点、这版代码能否直接打开，不改任何东西（#3 已实现）。
- 正式恢复由获授权的人执行，要求 control 已停止；恢复前把当前库另存一份。命令还没有实现，随 #20 的恢复演练写入。
- 恢复后 publications 和 im_publications 的 sending 行转 unknown。现有核对只处理已记录意图，不是全库重建；恢复点之后的外部状态补齐仍待 #20 演练。

## 验证与边界

- `tests/control/database.test.ts`、`backup.test.ts`、`server.test.ts`、`cli.test.ts` 覆盖迁移、兼容、独占连接、审计只追加与加密备份恢复校验。#34 的 `shared-platform-http.test.ts` 用真实路由和临时 SQLite 验证权限、资源、租约与结果拒绝。
- #34 本机真实 HTTP/SQLite 烟雾已观察：双平台项目与条目、需求去重、真实 ControlClient 续租/取包/回报、迟到 epoch 409、一次性节点令牌重放 409、viewer 403、重启后结果保留。外部平台接口隔离打桩，不是外部账号验收。
- Linux/KVM、真实外部写入、异地恢复、master key 轮换和全库重建未验证。自动化通过不能代替预发布人工验收。

## 后续数据约束

`pre_deploy`、`pre_migration`、`manual` 各保留 3 份是现有代码常量。任务内容与已解决告警的保留策略、外部状态恢复方案需要独立定义和验证；未实现前不擅自删业务行。
