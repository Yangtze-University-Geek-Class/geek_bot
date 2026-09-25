# 节点协议

> 工作节点与 control 之间的 HTTP/JSON 协议：原则、消息表 N-01…，以及 sandbox 与 VM 怎样访问节点。

状态：`proposed` · 更新：2026-09-26 · 适用：`app/node`、`app/control` 的 `/api/node/v1/*`、`packages/protocol` 的节点消息类型（由 #11 实现；事件与模型中继随 #13、#14，VM 部分随 #17，多节点随 #19）

本文是设计，还没有任何消息实现。现在代码里只有协议版本常量 `NODE_PROTOCOL_VERSION = 1`（`packages/protocol/src/index.ts`）。实现以后，消息形状的来源是 `@geek-bot/protocol` 的类型与 JSON Schema（消息表最后一列是计划的类型名，由 #11 放进去），两端用契约测试证明一致；本文与代码不符时在同一次改动里修正。

管理员对节点的操作（登记节点并生成令牌、cordon、排空、重置令牌、移除）是后台 API，见 [API](../../architecture/API.md) 的 A-36 至 A-44。架构背景见 [ARCHITECTURE](../../architecture/ARCHITECTURE.md)「节点协议原则」与「调度」，决策见 [ADR-0003](../../decisions/0003-single-writer-control.md)，安全要求见 [SECURITY](../../architecture/SECURITY.md)，节点包的契约见 [node 服务契约](README.md)。

## 原则

### 连接方向

- 只有节点主动发起连接；control 从不连节点；节点不开任何入站端口。
- control 要告诉节点的事（cordon、排空、取消、作废租约）都放在节点请求的响应里带回（N-10、N-11）。
- 同机部署时节点经 compose 网络访问 control；异机时经私有组网或 https。

### 传输

- HTTP/JSON，路径前缀 `/api/node/v1`；字段名用 snake_case，时长用整数秒（`_s`），时间用 ISO 8601 UTC 字符串。
- 公网上必须用 TLS，节点按常规校验证书。明文 http 只允许用于私网地址或同机 compose 网络，并且 control 要显式开启私网明文模式（部署环境变量 `GEEK_BOT_ALLOW_PLAINTEXT_MESH`，随 #7 写进 ENVIRONMENTS）；节点配置的 control 地址是 http 且指向公网地址时，节点拒绝启动（#11 加进 `createNodeConfig` 的校验）。
- control 对请求体做 JSON Schema 校验，不认识的字段返回 400 `validation_failed`；节点忽略响应里不认识的字段，这样 control 可以在同一个协议版本里给响应加字段。
- 请求体上限：事件批 256 KB、结果 1 MiB、单个产物 20 MiB；其它请求 64 KB。

### 认证与令牌

| 令牌 | 形态 | 谁生成 | 放在哪 | 用途 |
|---|---|---|---|---|
| 节点令牌 | `gbn_` 加 256 位随机数的 base64url | control：owner 重新认证后在后台登记节点（A-38）或重置令牌（A-43）时生成，只在后台显示这一次 | 运维写进节点宿主 secrets 目录里的文件（0400，属主是节点 uid），只读挂进 node 容器，路径由 `GEEK_BOT_NODE_TOKEN_FILE` 指定；库里只存 SHA-256 | 节点的全部请求：`Authorization: Bearer <节点令牌>` |
| 每任务模型令牌 | `gbt_` 加 256 位随机数的 base64url | control，放在 TaskSpec 里（N-02） | sandbox 的内存，或 VM 的 fw_cfg（见最后一节）；库里只存 SHA-256 | 只用于模型中继（N-09）；租约结束即失效 |

- 节点令牌由后台直接生成，协议里没有换取令牌的接口：节点从第一次心跳起就用它，**第一次心跳就是登记**（见 N-01）。
- 每个请求带 `X-Geek-Bot-Protocol: <整数>` 和 `X-Geek-Bot-Node: <节点名>`，节点名必须与令牌对应的节点一致，否则 401。
- 任务相关的请求另带 `X-Geek-Bot-Lease: <lease_id>` 和 `X-Geek-Bot-Epoch: <整数>`（有请求体的也在体里重复一次，两处不一致按 400 处理）。
- 两种令牌的前缀都加进日志打码和 `check-secrets` 的内容规则（#11、#13）。节点令牌永远不进 sandbox 和 VM。
- 「重置令牌」（A-43）后旧令牌立即返回 401。**节点收到 401 就立即停止一切任务并停止领任务**：终止全部 sandbox 任务，关掉全部 VM，丢弃未发送的结果和 spool，只等运维换上新的令牌文件后重启节点。这覆盖「后台重置令牌」（control 侧节点回到 `pending`，等新令牌的第一次心跳）和「节点被移除」（control 侧节点变为 `disabled`）两种情况。

### 协议版本

- 协议版本是整数，当前是 1（`NODE_PROTOCOL_VERSION`）。control 支持 N 与 N-1，并分别保存两个版本的请求 schema。
- 节点的版本不在范围内时（太旧，或比 control 新），control 仍接受 N-01 心跳，响应里的节点状态是 `needs_upgrade`；其它请求返回 426 `protocol_unsupported`，不给它派任务。后台把它标为需要升级。
- 升级顺序先 control 后节点（[RELEASES](../../conventions/RELEASES.md)「节点版本」）。
- 什么改动要提升版本：删除或改名字段、改变字段含义、给请求加字段（control 拒绝不认识的字段）。给响应加可选字段不提升。

### 时钟与超时

协议里的期限都用相对时长，不用对方的绝对时间：control 用自己的单调时钟计算租约期限，节点用自己的单调时钟计算本地期限。事件里的 `ts` 是节点的墙钟，只用于显示；control 另记收到时间。心跳响应带 `server_time`，节点据此算出时钟偏差放进健康数据，偏差超过 5 秒时 control 告警（不自动 cordon）。

| 项 | 默认值 | 由谁决定 |
|---|---|---|
| 心跳间隔 `heartbeat_interval_s` | 10 秒 | control，在 N-01 的响应里下发 |
| 记为 `stale` | 30 秒没有心跳 | control |
| 记为 `offline`，不再派新任务 | 90 秒没有心跳 | control |
| 失联 `lost_after_s` | 600 秒 | control 的配置 `GEEK_BOT_LEASE_LOST_AFTER_SECONDS`，在 N-01 的响应里下发；节点缓存最近一次收到的值，不单独配置，保证两侧用同一个值 |
| 租约有效期 `lease_ttl_s` | 等于 `lost_after_s` | TaskSpec，每次续租重新计时 |
| 续租间隔 `renew_interval_s` | 30 秒 | TaskSpec |
| 确认期限 `ack_deadline_s` | 60 秒 | TaskSpec：领到任务后必须在这个时间内完成第一次续租 |
| 长轮询挂起上限 | 25 秒 | control；节点这一个请求的超时设 35 秒 |
| 普通请求超时 | 30 秒 | 节点 |
| 事件批 | 每 1 秒或攒够 64 KB 发一批 | 节点 |
| 取消宽限 | 30 秒 | 节点 |
| 未确认事件的本地缓存（spool） | 每个任务 200 MB | 节点 |

配置项：control 侧的 `GEEK_BOT_LEASE_LOST_AFTER_SECONDS`（整数秒，默认 600，全局）登记在 [behavior](../control/behavior.md) 的配置项一览；节点侧的 `GEEK_BOT_NODE_TOKEN_FILE`（节点令牌文件在容器内的路径）随 #11 加进 [node 服务契约](README.md) 的配置说明；基础设施失败的重排上限沿用 behavior 的 `GEEK_BOT_INFRA_RETRY_MAX`（默认 2）。其余数值是协议常量，放进 `@geek-bot/protocol`。

### 租约与 epoch fencing

- 一个租约是 `(task_id, lease_id, epoch, node_id)`。`lease_id` 是至少 128 位的随机数，不能从别的值推出来。control 在一个 SQLite 事务里选任务、写租约；control 单进程单写者，同一个任务不会被两个节点同时领走。
- **租约归属**：N-03 至 N-09 每个请求都核对两件事：租约的 `node_id` 等于令牌对应的节点；路径里的 `task_id`（或路径里的 `lease_id` 对应的任务）等于租约里的任务。任何一项不符都返回 404 `not_found`，不透露这个租约或任务是否存在。
- `epoch` 从 1 开始；control 每次收回或重派同一个任务（节点失联、节点释放、租约未确认、管理员重新排队、被新 head 取代、重置节点令牌）时加一。
- 任务相关的每个请求（N-03 至 N-09）都带 `lease_id` 和 `epoch`。它们与 control 当前记录不符，或租约已经收回、取消，control 返回 409 `lease_fenced`，并在 `message` 里写原因（`reclaimed`、`cancelled`、`superseded`、`expired`）。节点收到后立即停止这个任务，丢弃它的结果、产物和 spool。
- 结果只进入 control 的「待发布」状态，每个租约最多记一次。节点从不写 GitHub；publisher 发送前还会复核 head、issue 状态和权限。
- 领到任务后，节点必须在 `ack_deadline_s` 内完成第一次续租（N-03），这就是确认。没有确认的租约被作废、epoch 加一、任务重新排队，并记一次基础设施失败。

### 失联判定（两侧对称）

- **control 侧**：租约超过 `lease_ttl_s` 没有续租，记为 `lost`：epoch 加一，任务重新排队，并把这个节点加进任务的 `excluded_nodes`。基础设施失败最多重排 2 次，之后判失败。节点状态按心跳间隔推导为 `stale`、`offline`、`lost`。
- **节点侧**：连续 `lost_after_s` 没有收到 control 的任何响应（5xx 和网络错误不算），就自行终止全部任务、关掉全部 VM、清掉任务包和工作目录。节点在期限前 30 秒就开始终止，保证 control 收回租约时旧任务已经停下。之后节点继续尝试心跳；恢复联络时如实报告没有租约。
- **control 计划内重启**：启动后给所有活动租约重新计时 `lease_ttl_s`，宽限期内不重排。control 重启通常不到 1 分钟，节点在此期间继续执行、把事件写进 spool，不会被打断。
- **节点重启**：每次进程启动生成新的 `boot_id`。启动时先清理残留的 qemu 进程、sandbox 工作目录和 overlay，再发心跳报告空租约；control 看到 `boot_id` 变了且缺少的租约，就作废它们并重新排队。每 5 分钟回收一次没有对应活动租约的 VM 文件。
- **对账**：每次心跳，节点列出它认为自己持有的租约。control 有、节点没报告（且已确认）的租约作废并重排；节点报告了、control 认为已作废的，放进响应的 `voided_leases`，节点立即终止。

### 重试与幂等

- 退避：网络错误、408、429、5xx 重试，指数退避，从 1 秒起每次翻倍，上限 60 秒，加全抖动；有 `Retry-After` 时按它等待。其它 4xx 不重试；409 `lease_fenced` 表示停止这个任务，401 表示立即停止一切任务并停止领任务（见上文）。

| 消息 | 怎样保证重试不出错 |
|---|---|
| N-01 heartbeat | 带 `boot_id` 与单调递增的 `seq`；control 丢弃比已处理的 `seq` 小的心跳。第一次心跳（登记）重复发送不会产生第二个节点 |
| N-02 lease | 每次领任务带新的 `Idempotency-Key`，key 按节点隔离（别的节点用同一个 key 拿不到这个结果）；响应丢失时用同一个 key 重试，control 在确认期限内返回同一个 TaskSpec，不会给出第二个租约 |
| N-03 renew | 本身幂等 |
| N-04 bundle | GET；支持 `Range` 断点续传 |
| N-05 events | 按 `(lease_id, seq)` 去重；出现断档时 control 返回 `expect_seq`，节点从那里补发 |
| N-06 artifact | 按 `(lease_id, name, sha256)` 幂等；同名不同内容返回 409 `artifact_conflict` |
| N-07 result | 每个租约只记一次：内容相同的重放返回 200；内容不同返回 409 `result_already_recorded` |
| N-08 release | 按 `lease_id` 幂等 |
| N-09 model | 节点不自动重试（已经流出的字节无法撤回）；是否换模型由 runner 与 omp 决定。control 记录每次请求 |
| N-10、N-11 命令 | 每条命令有 `command_id`，节点按它去重，并在下一次心跳的 `acked_command_ids` 里确认 |

### 错误格式

与后台 API 相同：`{ "error": { "code": "…", "message": "…" } }`，`message` 不含令牌、路径和堆栈（[API](../../architecture/API.md)「错误格式」）。节点协议用到的 `code`：

| HTTP | `code` | 何时返回 |
|---|---|---|
| 400 | `validation_failed` | 不符合 JSON Schema，含未知字段；头与体里的 lease、epoch 不一致 |
| 400 | `relay_field_rejected` | 模型中继的请求体里有白名单以外的字段，或 `tools` 里有 function 以外的类型 |
| 401 | `unauthenticated` | 节点令牌无效、被重置或节点被移除；`X-Geek-Bot-Node` 与令牌对应的节点名不一致 |
| 401 | `task_token_invalid` | 模型中继的任务令牌无效或已过期 |
| 403 | `model_not_in_pool` | 请求的模型不在本任务的池里 |
| 404 | `not_found` | 任务、产物或路由不存在；租约不属于这个节点，或路径里的任务与租约不符（见「租约归属」） |
| 409 | `lease_fenced` | epoch 不匹配，或租约已收回、取消、被取代、过期 |
| 409 | `node_not_schedulable` | 节点处于 cordon、排空或需要升级时仍来领任务 |
| 409 | `result_already_recorded`、`artifact_conflict` | 见上表 |
| 413 | `payload_too_large` | 超过请求体上限 |
| 426 | `protocol_unsupported` | 协议版本不在 N、N-1 范围内 |
| 429 | `rate_limited` | 节点请求过于频繁；带 `Retry-After` |
| 429 | `budget_exhausted` | 本任务的模型请求数或 token 预算用完；不带 `Retry-After`，不应降级到同池的下一个模型 |
| 429 | `upstream_rate_limited` | 网关限流，原样带回 `Retry-After` |
| 502 | `upstream_error` | 网关返回错误或连接失败 |
| 503 | `control_starting` | control 正在启动或迁移；带 `Retry-After` |
| 504 | `upstream_timeout` | 网关超时 |

## 节点状态

| 状态 | 含义 | 怎样进入 | 能否领任务 |
|---|---|---|---|
| `pending` | 已在后台登记并生成令牌，节点还没用它心跳（或令牌被重置后还没用新令牌心跳） | A-38；A-43 | 否 |
| `cordoned` | 已登记，或被管理员、健康门控隔离 | 用令牌的第一次心跳；A-40；主机健康越线时节点自行报告 | 否 |
| `active` | 正常接任务 | 自检通过后管理员解除 cordon（A-41）；健康门控造成的 cordon 在恢复且满足回滞条件后自动解除 | 是 |
| `draining` | 做完手头任务，不接新任务 | A-42 | 否 |
| `needs_upgrade` | 协议版本不在范围内 | 心跳里的 `protocol` | 否 |
| `disabled` | 节点被移除；令牌作废，历史保留 | A-44 | 否 |
| `stale`、`offline`、`lost` | 按心跳间隔推导的联络状态，叠加在上面的状态上 | 30 秒、90 秒、`lost_after_s` 没有心跳 | `offline` 起否 |

自检在节点第一次心跳后自动执行一次，结果放在心跳的 `self_check` 里：起停一台 VM（vm 槽位为 0 时跳过）、`omp --version`、经 N-09 的模型列表路径确认中继连通、出网代理确实拒绝私网地址。自检没通过，A-41 返回 409 `self_check_failed`。

## 消息表

方向：「节点 → control」是节点发请求；「control → 节点」是 control 在响应里带回。类型名是计划放进 `@geek-bot/protocol` 的名字，由 #11 实现（N-05 随 #14，N-09 随 #13）。

| 编号 | 方法与路径 | 方向 | 请求字段 | 响应字段 | 错误与重试 | protocol 类型 |
|---|---|---|---|---|---|---|
| N-01 | `POST /api/node/v1/heartbeat` | 节点 → control，每 `heartbeat_interval_s` 一次；用令牌的第一次心跳就是登记 | `name`、`boot_id`、`seq`、`version`（节点软件版本）、`protocol`、`host`（`arch`、`cpu_threads`、`mem_total_mib`、`kvm_available`）、`capacity`（本地声明的 `sandbox`、`vm` 上限）、`free`（空闲槽位）、`leases`（每项 `task_id`、`lease_id`、`epoch`、`phase`）、`health`（见「主机健康字段」）、`self_cordon`（越线时写原因，恢复后为空）、`self_check`、`vm_image`（`digest`、`ready`）、`omp_version`、`acked_command_ids` | `server_time`、`state`（第一次心跳后从 `pending` 变 `cordoned`）、`effective_slots`（后台设定与本地上限取小）、`heartbeat_interval_s`、`lost_after_s`、`protocol_range`（`min`、`max`）、`voided_leases`（每项 `lease_id` 与原因）、`commands`（N-10、N-11） | 401 立即停止一切任务并停止领任务；版本不符时仍返回 200，`state` 为 `needs_upgrade`。网络错误按退避重试，不影响本地任务 | `NodeHeartbeatRequest`（含 `NodeHealth`、`NodeLeaseReport`）/ `NodeHeartbeatResponse` |
| N-02 | `POST /api/node/v1/lease`（`Idempotency-Key`） | 节点 → control，长轮询 | `free`（各执行器的空闲槽位）、`wait_s`（最多 25） | 有任务 200 `{ lease: TaskSpec }`（见「TaskSpec」）；等到 `wait_s` 仍没有任务 204 | 409 `node_not_schedulable`；426。响应丢失时用同一个 key 重试 | `LeaseRequest` / `LeaseGrant`（`TaskSpec`） |
| N-03 | `POST /api/node/v1/leases/{lease_id}/renew` | 节点 → control，每个活动租约每 `renew_interval_s` 一次；第一次即确认 | `epoch`、`phase`（`accepted`、`preparing`、`running`、`uploading`）、可选 `progress`（一行文字） | `status: "active"`、`lease_ttl_s`、`commands`（可能含本任务的取消） | 409 `lease_fenced`：立即停止任务。网络错误按退避重试，直到本地失联期限 | `LeaseRenewRequest` / `LeaseRenewResponse` |
| N-04 | `GET /api/node/v1/tasks/{task_id}/bundle` | 节点 → control | 头：`X-Geek-Bot-Lease`、`X-Geek-Bot-Epoch`；可选 `Range` | `application/gzip` 的任务包（内容见「TaskSpec」），头里有 `Content-Length` 与 `X-Geek-Bot-Bundle-Sha256`。节点核对 sha256 与字节数都等于 TaskSpec 的 `bundle`，不符就走 N-08（`bundle_invalid`） | 409 `lease_fenced`；404 任务包已清理。网络错误用 `Range` 续传 | `TaskBundleRef`（TaskSpec 里的 `bundle`）；响应是二进制 |
| N-05 | `POST /api/node/v1/tasks/{task_id}/events` | 节点 → control，批量 | `lease_id`、`epoch`、`from_seq`、`events`（每项 `seq`、`ts`、`line`：omp 或 runner 的一行 JSONL，已打码） | `ack_seq`；有断档时 `expect_seq`；`commands`。control 把原文追加到任务事件文件，派生时间线经 SSE 推给后台（目标端到端 3 秒内、上限 10 秒，未验证，由 #14 实测） | 409 `lease_fenced`；413。发不出去的事件进 spool，满了先丢文本增量，保留工具、错误、重试、降级事件 | `TaskEventBatch` / `TaskEventAck` |
| N-06 | `PUT /api/node/v1/tasks/{task_id}/artifacts/{name}` | 节点 → control | 头：lease、epoch、`X-Geek-Bot-Artifact-Sha256`；`Content-Type: application/octet-stream`；`name` 只能取 protocol 定义的产物名（例如补丁 `patch.diff`） | 200 `{ name, sha256, bytes }` | 409 `lease_fenced`、`artifact_conflict`；413。按退避重试 | `TaskArtifactRef` |
| N-07 | `POST /api/node/v1/tasks/{task_id}/result` | 节点 → control | `lease_id`、`epoch`、`status`（`succeeded`、`failed`、`cancelled`、`timed_out`）、可选 `failure`（`class`：`infra`、`model`、`schema`、`timeout`、`cancelled`；`message`）、`result`（按 TaskSpec 的 `result_schema`：review.v1、triage.v1、patch.v1）、`attempts`（runner 视角的模型尝试）、`usage`、`artifacts`（引用 N-06 已上传的 `name` 与 `sha256`） | `accepted: true`、`state`（`pending_publish`、`failed` 或 `cancelled`）。结果只进入待发布，不直接写 GitHub | 409 `lease_fenced`、`result_already_recorded`；400 结果不符合 schema（control 另按失败规则处理）。按退避重试 | `TaskResultSubmission`（`ReviewResultV1`、`TriageResultV1`、`PatchResultV1`）/ `TaskResultAck` |
| N-08 | `POST /api/node/v1/leases/{lease_id}/release` | 节点 → control | `epoch`、`reason`（`bundle_invalid`、`vm_start_failed`、`resource_unavailable`、`infra_failure`、`draining`、`node_shutdown`）、可选 `detail`（最多 1 KB） | `requeued`、`infra_failures`（该任务累计的基础设施失败次数）。control 作废租约、epoch 加一；`draining`、`node_shutdown` 且任务没开始时不计失败 | 409 `lease_fenced`（已被收回，可以忽略）。按退避重试 | `LeaseReleaseRequest` / `LeaseReleaseResponse` |
| N-09 | `POST /api/node/v1/model/v1/chat/completions`；`GET /api/node/v1/model/v1/models` | 节点 → control（节点把 sandbox 或 VM 的模型请求转上来） | 头：`Authorization: Bearer <节点令牌>`、`X-Geek-Bot-Task-Token: <每任务模型令牌>`、lease、epoch；请求体是 OpenAI 兼容格式，control 按字段白名单放行（见表后「模型中继的请求体」） | 流式或非流式的 OpenAI 兼容响应，由 control 用网关密钥转发。`models` 只列本任务池里的模型，由 control 按池生成，不访问网关。control 记录每个请求的模型、HTTP 状态、耗时和用量，这是降级记录里可信的一方 | 400 `relay_field_rejected`；401 `task_token_invalid`；403 `model_not_in_pool`；404（租约不属于本节点）；409 `lease_fenced`；429 `budget_exhausted`、`upstream_rate_limited`；502、504。节点不自动重试 | `ModelRelayHeaders`；请求与响应体不单独定义类型 |
| N-10 | 命令 `cordon`、`uncordon`、`drain`，放在 N-01、N-03、N-05 响应的 `commands` 里 | control → 节点 | 无 | 每条：`command_id`、`kind`、`reason`。`cordon`：不再调用 N-02，手头任务继续；`uncordon`：恢复领任务；`drain`：手头任务做完后不再领新任务，心跳报告空租约 | 节点按 `command_id` 去重，在下一次心跳的 `acked_command_ids` 里确认 | `NodeCommand`（`kind` 为 `cordon`、`uncordon`、`drain`） |
| N-11 | 命令 `cancel`，放在 N-01、N-03、N-05 响应的 `commands` 里 | control → 节点 | 无 | 每条：`command_id`、`kind: "cancel"`、`task_id`、`lease_id`、`reason`。sandbox 发 SIGTERM（omp 以 143 退出），30 秒后 SIGKILL；VM 发 QMP `system_powerdown`，30 秒后结束 qemu 进程。之后用 N-07 回报 `status: "cancelled"` | 同 N-10；租约已结束的取消直接确认 | `NodeCommand`（`kind` 为 `cancel`） |

### 模型中继的请求体

N-09 的请求体按字段白名单放行，control 在转发前改写或拒绝（#13 用夹具测试逐项证明）：

- 只放行 `model`、`messages`、`tools`、`tool_choice`、`temperature`、`top_p`、`max_tokens`、`stop`、`stream`、`stream_options`、`reasoning_effort` 这些字段；其它字段返回 400 `relay_field_rejected`。放行字段的最终清单由 #13 按 omp 实际发出的请求核对后写回本文。
- `model` 必须在本任务的池里；`reasoning_effort` 必须是池里给这个模型配的档位。
- `tools` 每一项只许 `type: "function"`，其它类型（例如网关自带的检索或代码执行工具）一律拒绝。
- `n` 强制为 1（请求里带了别的值就拒绝）。
- `max_tokens` 按本任务剩余的 token 预算封顶，超出时改成剩余值，剩余为 0 时返回 429 `budget_exhausted`。
- 流式请求强制带 `stream_options.include_usage: true`，保证 control 能按实际用量记账。

### TaskSpec

N-02 返回的任务描述，字段：

- `task_id`、`lease_id`、`epoch`；
- `kind`（`TASK_KINDS`：review、triage、followup、fix、rework，外加规则画像提取）、`channel`、`executor`（`sandbox` 或 `vm`，取自 `CHANNEL_EXECUTOR`；VM 就绪前 PR 审查可以临时是 `sandbox`）；
- `repo`（GitHub 数字 id、全名、是否私有）、`item`（类型与编号）、`head_sha`；
- `resources`（`vcpus`、`memory_mib`、`disk_mib`；默认来自 `GEEK_BOT_VM_VCPUS`、`GEEK_BOT_VM_MEMORY_MIB`）；
- `bundle`（`sha256`、`bytes`）；
- `omp`（`version`、`tools` 白名单、`max_time_s`）；
- `models`（按池顺序的 `{ id, effort }` 列表）；
- `egress_allowlist`（域名规则；sandbox 为空）；
- `result_schema`（review.v1、triage.v1、patch.v1，画像提取的 schema 由 #10 定）；
- `task_token`（每任务模型令牌）；
- `lease_ttl_s`、`renew_interval_s`、`ack_deadline_s`。

任务包（N-04）是一个 tar.gz，节点不需要任何 GitHub 凭据就能拿到全部输入：

- `repo/`：目标提交的 `git archive`，剔除 `.omp/`、`.claude/`、`.cursor/`、`mcp.json`、`.env*`；规则文件已用 base 版本覆盖（[SECURITY](../../architecture/SECURITY.md) S-04、S-08）；
- `diff.patch`、`rules/`；
- `prompt.md`、`append-system.md`、`overlay.yml`、`models.yml.tmpl`、`meta.json`（含仓库画像里声明的校验命令）。

### 主机健康字段

N-01 的 `health`，都是可选字段，采集不到的不填：CPU 负载、各温度传感器读数、可用内存、内存压力（PSI）、数据盘与 VM 工作目录的可用空间、文件系统未分配空间（有这个概念的文件系统才有）、是否接通电源与电池电量、内核与模块目录是否一致、vhost 模块是否可用、时钟偏差。control 每分钟保留一个点，保留 7 天；越线判定与回滞由节点本地执行（[ARCHITECTURE](../../architecture/ARCHITECTURE.md)「调度」），结果通过 `self_cordon` 报告。

## sandbox 与 VM 怎样访问节点

sandbox 和 VM 不直接连 control，只连所在节点的**本地任务端点**。本地任务端点由 node 进程提供，不绑定宿主的任何 TCP 端口；它的消息形状同样放进 `@geek-bot/protocol`（#14、#17），runner 只做 type 导入。节点令牌不进入 sandbox 和 VM。

| 用途 | sandbox（issue 通道） | VM（PR 通道） |
|---|---|---|
| 连接方式 | 每个槽位一个共享卷，里面一个由 node 监听的 unix socket。sandbox 容器没有网络；runner 在容器的回环地址上起一个转发器，把 omp 的 HTTP 请求转到这个 socket | QEMU 用户态网络的受限模式（`restrict=on`），来宾访问不到宿主和外网。只有两条 guestfwd：QEMU 用户态网络里一个来宾可见的内部地址上的两个端口，分别转到节点的本地模型代理和出网 CONNECT 代理。具体地址与端口由 #17 定，写进 VM 基础镜像的配置，不写成文档里的字面量 |
| 任务输入 | `GET /v1/task`：任务元数据和模型令牌（只在内存里）；`GET /v1/bundle`：任务包 | 只读原始盘上的 tar（任务包与元数据） |
| 模型令牌 | 随 `GET /v1/task` 的响应进入内存，不落盘 | 经 `-fw_cfg name=opt/geekbot/token,file=<0600 临时文件>` 传入，不进 qemu 的命令行参数；VM 起来后节点删除临时文件 |
| 实时事件 | `POST /v1/events`：按行的 JSONL 流 | virtio-serial 通道，一行一个 JSONL 事件 |
| 结果与产物 | `POST /v1/result`、`PUT /v1/artifacts/{name}` | 写到可写原始盘上的 tar，VM 关机后节点读取 |
| 模型请求 | `/model/v1/*`，`Authorization: Bearer <模型令牌>` | 经 guestfwd 到本地模型代理的 `/model/v1/*`，同样带模型令牌 |
| 出网 | 没有 | 只经出网 CONNECT 代理：域名白名单默认只放包管理源，不放 GitHub 的域名；域名解析后拒绝私网、CGNAT、链路本地、回环等地址段（含 IPv6）和部署者配置的组网网段，只连接校验过的那次解析结果；每个任务限制连接数和字节数。GitHub 域名清单和拒绝的地址段以 [SECURITY](../../architecture/SECURITY.md) S-14 为准 |

**本地模型代理**：收到 sandbox 或 VM 的模型请求后，先核对模型令牌对应本节点的一个活动租约，再把它移到 `X-Geek-Bot-Task-Token` 头里，加上自己的节点令牌、`lease_id` 和 `epoch`，转成 N-09 发给 control；响应原样流回。节点把本任务模型令牌的原值加进事件打码规则。

**事件打码**：节点在事件离开本机前打码，规则是密钥形态正则（`ghp_`、`gho_`、`ghu_`、`github_pat_`、`sk-`、`gbn_`、`gbt_`、`Bearer` 等）加上本任务模型令牌的原值；control 收到后不再假设事件是干净的，写入与推送前再按同一规则扫一遍。

VM 隔离能否按上表成立（受限用户态网络、guestfwd 吞吐、fw_cfg 传令牌、2 GiB 内存是否够用）未验证，由 #12 实测；不通过时按 [ADR-0004](../../decisions/0004-execution-isolation.md) 的退路改选，并改写本节。

## 验证（计划中）

- 两端 schema 一致：节点消息与 TaskSpec 的 TypeScript 类型和 JSON Schema 由契约测试比对（#11）。
- epoch 过期的结果、事件、续租返回 409；失联 `lost_after_s` 后两侧对称判定并重排；control 重启后的宽限；重置令牌后旧令牌 401，节点立即停止一切任务；协议版本在 N、N-1 范围外的节点只收心跳；主机健康越线自动 cordon（#11，见 [TESTING](../../conventions/TESTING.md) 回归矩阵）。
- 领任务的响应丢失后用同一个 `Idempotency-Key` 重试，不出现第二个租约（#11）。
- 池外模型 403、过期令牌 401、超预算 429（#13）。
- sandbox 与 VM 里搜不到节点令牌、GitHub 令牌和网关密钥；VM 访问私网和宿主端口全部失败（#12、#14、#17）。
