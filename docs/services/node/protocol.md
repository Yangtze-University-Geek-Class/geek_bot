# 节点协议

> 工作节点与 control 之间的 HTTP/JSON 协议 `/api/node/v1`：请求头与租约栅栏、端点 N-01…N-09、失联与回放，以及 sandbox 与 VM 怎样访问节点。

状态：`current` · 更新：2026-10-03 · 适用：`app/node`、`app/control` 的 `/api/node/v1/*`、`packages/protocol` 的节点消息类型（由 #34 实现）

`current` 只表示本文与 #34 的源码一致，不表示已经在真实节点、Linux/KVM 主机或线上实例验收过；实际跑过和没跑过的检查见文末「验证状态」。

事实来源：control 侧是 `app/control/src/routes/platform/node/{index,contracts}.ts` 与 `app/control/src/platform/{machines,tasks,relay,health,records}.ts`；节点侧是 `app/node/src/{control-client,worker,health,self-check,spool,model-relay,sandbox}.ts` 与 `app/node/src/vm/pool.ts`；共享形状是 `packages/protocol/src/shared.ts`。本文与代码不一致时以代码为准，并在同一次改动里修正本文。

后台管理机器的端点（登记、改属性、cordon、uncordon、drain、重置令牌）在 `/api/v1/machines`，见 [control 服务契约](../control/README.md)。节点包的源码地图、配置和运行方式见 [node 服务契约](README.md)，安全要求见 [SECURITY](../../architecture/SECURITY.md)，决策见 [ADR-0003](../../decisions/0003-single-writer-control.md)。

## 原则

### 连接方向

- 只有节点主动发请求；control 从不连节点，节点不开任何入站端口。
- control 要节点停下某个任务时，放在心跳响应的 `cancel_task_ids` 或续租响应的 `cancel: true` 里带回。协议里没有单独的命令消息：cordon、drain 这类管理状态经心跳响应的 `status` 体现，节点只在 `status` 为 `ready` 时领任务。

### 传输

- HTTP/JSON，路径前缀 `/api/node/v1`，字段名用 snake_case。节点的请求不跟随重定向。
- 节点配置的 control 地址只许 http 或 https，不许带账号密码、查询串和片段。地址是明文 http 时，主机名解析出的每个地址都必须落在禁止出网的地址段里（私网、回环等，与出网代理用同一张表）；只要有一个公网地址，节点就拒绝启动，退出码 78。公网上必须用 https。
- control 按 JSON Schema 校验请求：对象拒绝未知字段，字符串和数组都有上限，校验失败返回 400 `validation_failed`。节点只读响应里自己认识的字段。
- 请求体上限：事件批 256 KiB，结果 1 MiB，模型中继 8 MiB，其余端点用 control 的全局上限 64 KiB。心跳的 `health` 打码后超过 64 KiB 返回 413 `payload_too_large`。

### 认证与请求头

| 令牌 | 形态 | 来源 | 节点怎样持有 | 用途 |
|---|---|---|---|---|
| 节点令牌 | `gbn_` 加 256 位随机数的 base64url | 后台登记机器或重置令牌时生成（owner，要求重新认证），只出现在那一次响应里；幂等重放不会再给一次；库里只存 SHA-256 | `GEEK_BOT_NODE_TOKEN_FILE` 指向的只读文件，启动时读进内存 | 全部 `/api/node/v1/*` 请求 |
| 每任务模型令牌 | `gbt_` 加 256 位随机数的 base64url | 领任务响应里的 `model_token`；库里只存 SHA-256；交结果、交失败、收回或取消时清除 | 节点内存；sandbox 经槽位 socket 交给 runner，VM 经 fw_cfg | 只用于模型中继 N-09 |

每个请求都带：

- `Authorization: Bearer <节点令牌>`：令牌无效、已重置或机器已移除时返回 401 `unauthenticated`。
- `X-Geek-Bot-Protocol: <整数>`：缺少或不是整数返回 400。
- `X-Geek-Bot-Node: <节点名>`：必须等于令牌对应的机器名，否则 401。

`/api/node/v1/tasks/*` 的请求（N-03 至 N-07）还必须同时带头和体两处栅栏：

- 头：`X-Geek-Bot-Lease: <lease_id>`、`X-Geek-Bot-Epoch: <正整数>`；
- 体（GET 是查询串）：`lease_id`、`epoch`。

两处缺一或不一致，control 返回 400 `validation_failed`，不进入业务处理。模型中继 N-09 的栅栏只在头里，见端点表。

节点令牌永远不进 sandbox 和 VM。两种令牌的前缀都在 control 日志打码和节点事件打码的规则里。

### 协议版本

- 协议版本是整数，当前是 1（`NODE_PROTOCOL_VERSION`）。control 支持的范围是 `max(1, N-1)` 到 N，当前只有 1。
- 版本不在范围内时，心跳仍然记录（存下节点报告的版本），其它端点返回 426 `protocol_unsupported`。版本不在范围内的机器不能解除隔离。
- 心跳体里的 `protocol_version` 必须等于 `X-Geek-Bot-Protocol`，否则 400。
- 删除或改名字段、改变字段含义、给请求加字段（control 拒绝未知字段）都要提升版本；给响应加字段不提升。升级顺序先 control 后节点（[RELEASES](../../conventions/RELEASES.md)「节点版本」）。

### 时钟与超时

期限都用相对时长。control 的租约期限按自己的时钟计算，长轮询按进程的单调时钟计算；节点的本地期限按自己的时钟计算。

| 项 | 值 | 由谁决定 |
|---|---|---|
| 心跳间隔 | 默认 10 秒（2～60） | 节点配置 `GEEK_BOT_NODE_HEARTBEAT_SECONDS`；control 不下发 |
| 联络状态 `offline` | 90 秒没有心跳 | control；对外记录显示 `offline`，不能解除隔离 |
| 失联期限 `lease_lost_after_s` | 默认 600 秒（60～86,400） | control 配置 `GEEK_BOT_LEASE_LOST_AFTER_SECONDS`，经心跳响应下发；节点只接受不小于 60 的值，收到之前用 600 |
| 确认期限 | 60 秒，固定 | control：领到后必须在这段时间内第一次续租 |
| 续租间隔 | `max(5, min(30, floor(lease_ttl_s / 3)))` 秒 | 节点按续租响应的 `lease_ttl_s` 计算 |
| 长轮询挂起 | `wait_s` 最多 25 秒 | control；节点用 25，请求超时设为 `wait_s + 10` 秒 |
| 普通请求超时 | 30 秒；取任务包 300 秒 | 节点 |
| 事件批 | 每秒一批，每批最多 500 条、200 KiB | 节点 |
| 事件缓存（spool） | 每个租约默认 200 MiB | 节点配置 `GEEK_BOT_NODE_SPOOL_MAX_MIB` |
| 任务时长 | `timeout_s`，默认 3,600 秒 | control 配置 `GEEK_BOT_TASK_TIMEOUT_SECONDS`；节点在 `timeout_s + 60` 秒时强制停止 |
| 取消宽限 | sandbox 35 秒；VM 关机 30 秒后 QMP `quit`，再 5 秒 SIGKILL | 节点 |
| 停机宽限 | 40 秒 | 节点收到 SIGTERM 后 |
| 过期租约扫描 | 每 5 秒 | control |

control 的配置项（含模型预算、任务时长、基础设施重试上限）以 [control 服务契约](../control/README.md) 和 [默认行为与配置项](../control/behavior.md) 为准，本文不复制默认值以外的规则。

### 租约与 epoch fencing

- 租约由 `(task_id, lease_id, epoch, machine_id)` 确定。`lease_id` 是 128 位随机数的十六进制。control 单进程单写者，在一个 SQLite 事务里挑任务、写租约，同一个任务不会同时租给两台机器。
- `epoch` 从 1 开始。收回重排、取消、被新提交取代、交失败、重新排队都会让 epoch 加一。
- 归属核对：任务不存在或不属于发请求的机器返回 404 `not_found`；租约 id 或 epoch 不符、任务不在运行中返回 409 `lease_fenced`，`message` 是 `reclaimed`、`cancelled`、`superseded` 或 `expired` 之一。
- 确认：领到后第一次续租就是确认。确认期限内没有续租，control 收回租约、计一次基础设施失败，并把这台机器加进该任务的排除名单。
- 确认之后每次续租把期限延到 `now + lease_lost_after_s`。
- 结果只进入 control 的 `awaiting_publish`，每个租约最多记一次。节点从不写 GitHub；发布由 control 的 publisher 负责。

### 失联判定

- **control 侧**：租约过期由定时扫描收回：epoch 加一，任务重新排队，计一次基础设施失败，并排除这台机器。基础设施失败超过 `GEEK_BOT_INFRA_RETRY_MAX` 次判失败。
- **节点侧**：收到 control 的任何非 5xx 响应都算联络上。连续 `lease_lost_after_s - 30` 秒没有联络，节点销毁全部在跑的任务，但保留它们的事件缓存，转成回放（见下文「缓存与回放」）。
- **control 重启**：启动时给已确认的租约重新计时 `lease_lost_after_s`，未确认的重新计时确认期限，宽限期内不收回。节点在这段时间里照常执行，事件先写进缓存。
- **节点重启**：每次进程启动生成新的 `boot_id`。启动时先结束残留的 qemu 进程、清空 VM 工作目录，再打开上次留下的缓存开始回放。control 看到 `boot_id` 变化时收回这台机器的全部运行中租约，并计一次基础设施失败。回放和心跳谁先到由时序决定：control 仍认这个租约就接收，已经收回就返回 409，节点删除缓存。
- **对账**：心跳 `health.leases` 列出节点认为自己持有的租约（含待回放的）。control 有、节点没报告、而且已经确认过的租约，收回重排并计一次失败；节点报告了、control 不认的，以及管理员要求取消的，放进响应的 `cancel_task_ids`。

### 缓存与回放

节点为每个租约建一份磁盘缓存 `<数据目录>/spool/<task_id>@<epoch>/`（目录 0700，文件 0600）：

| 文件 | 内容 |
|---|---|
| `lease.json` | `task_id`、`lease_id`、`epoch`、领到它时的 `boot_id` |
| `events.jsonl` | 已打码、还没被 control 确认的事件，一行一个 |
| `ack` | control 已确认到的 `seq` |
| `outcome.json` | 执行器交回、还没被 control 接收的结果或失败 |

- 事件先写进缓存再回传；每次回传前 fsync，进程崩溃不丢事件。
- 未确认事件超过上限时，先丢最早的 `text` 事件到上限的 90%；`tool`、`error`、`retry`、`model` 事件一律保留。只剩保留类事件仍超限时，任务以 `infra_failure` 结束，不静默丢事件。
- 结局先写 `outcome.json`，再交给 control。
- 目录只在这些时候删除：control 接收了结果或失败；任务请求返回 409 或 404；401（删除全部缓存）；内容损坏无法回放。
- 失联、停机期限到、节点重启留下的缓存，用原来的栅栏回放：先补交事件，再交结局；没有结局文件的按 `infra_failure` 回报。

### 重试与幂等

节点的退避：网络错误（状态记为 0）、408、429、5xx 重试；有 `Retry-After` 时按它等待，否则在 0 到 `min(60 秒, 1 秒 × 2^次数)` 之间随机取值再加 250 毫秒。其它状态码不重试。

| 节点收到 | 节点的处理 |
|---|---|
| 401（`task_token_invalid` 除外），来自任何端点 | 整体停机：销毁全部任务，删除全部缓存，停止心跳和领任务；每 10 秒读一次令牌文件，内容变了就用新的 `boot_id`、`seq` 从 0 重新开始 |
| 任务请求返回 409 或 404 | 只销毁这一个任务，删除它的缓存 |
| 领任务返回 409 `node_not_schedulable` | 丢掉本地的机器状态，等下一次心跳 |
| 交结果返回其它 4xx | 改交失败 `schema` |

| 端点 | 重试是否安全 |
|---|---|
| N-01 心跳 | `health.boot_id` 与同一 `boot_id` 内递增的 `health.seq`；control 丢弃不大于已处理值的心跳（只更新联络时间）。第一次心跳重复发送不会产生第二台机器 |
| N-02 领任务 | 节点每次领任务生成一个 `Idempotency-Key`，只在可重试错误后用同一个 key 重发。key 按机器隔离：同一机器同一 key 的租约还没确认时，control 返回同一个任务并换发新的模型令牌（旧令牌作废）；已经确认的返回 `task: null` |
| N-03 续租 | 本身幂等 |
| N-04 任务包 | GET，无副作用；不支持 `Range` |
| N-05 事件 | 按 `(task_id, seq)` 去重，重复的忽略 |
| N-06 结果 | 同一租约内容相同的重放返回当前状态；内容不同返回 409 `result_already_recorded` |
| N-07 失败 | 第一次就会改变租约（epoch 加一或结束任务），重放得到 409，节点按作废处理并删除缓存 |
| N-08 模型自检 | control 缓存结果 60 秒，每台机器每分钟最多一次 |
| N-09 模型中继 | 节点不自动重试，已经流出的字节撤不回；是否换模型由 runner 决定 |

### 错误格式

形状与后台 API 相同：`{ "error": { "code": "…", "message": "…" } }`（[API](../../architecture/API.md)「错误格式」）。节点 API 用到的 `code`：

| HTTP | `code` | 何时返回 |
|---|---|---|
| 400 | `validation_failed` | 不符合 schema、含未知字段；缺协议头；任务请求缺租约头或头体不一致；心跳的 `health` 字段类型不对；N-06 结果与任务类型不符（fix、rework 缺补丁，其它类型带了补丁） |
| 400 | `relay_field_rejected` | 模型中继请求体有白名单外的字段、`n` 不是 1、`tools` 有 function 以外的类型 |
| 401 | `unauthenticated` | 节点令牌无效、已重置或机器已移除；`X-Geek-Bot-Node` 或心跳 `name` 与令牌对应的机器不一致 |
| 401 | `task_token_invalid` | 模型中继的任务令牌缺失、格式不对或已失效 |
| 403 | `model_not_in_pool` | 模型或思考档位不在本任务的池里 |
| 404 | `not_found` | 任务不存在或不属于这台机器；任务包已清理 |
| 409 | `lease_fenced` | 租约 id、epoch 不符，或任务已收回、取消、取代、过期 |
| 409 | `node_not_schedulable` | 机器不是 `ready`，或健康门打开时领任务 |
| 409 | `result_already_recorded` | 同一租约交了内容不同的结果 |
| 413 | `payload_too_large` | 超过请求体上限 |
| 426 | `protocol_unsupported` | 协议版本不在支持范围（心跳除外） |
| 429 | `rate_limited` | 每台机器每分钟超过 1,200 个请求，或模型自检每分钟超过 1 次；带 `Retry-After` |
| 429 | `budget_exhausted` | 本任务的模型请求数或 token 预算用完；不带 `Retry-After` |
| 429 | `upstream_rate_limited` | 网关限流，原样带回 `Retry-After` |
| 502 | `upstream_error` | 网关返回 5xx 或连不上 |
| 503 | `relay_unavailable` | 实例没有配置网关地址或网关密钥 |
| 504 | `upstream_timeout` | 网关 10 分钟内没有响应 |

## 节点状态

机器的管理状态存在 control 的 `machines` 表里，对外记录（`MachineRecord.status`）叠加联络状态和健康门：

| 状态 | 含义 | 怎样进入 | 能否领任务 |
|---|---|---|---|
| `pending` | 已登记，还没用令牌心跳过；重置令牌后也回到这里 | 后台登记；重置令牌 | 否 |
| `cordoned` | 已隔离 | 第一次心跳；管理员 cordon；`ready` 的机器健康门打开时对外显示为 `cordoned` | 否 |
| `ready` | 正常接任务 | 管理员 uncordon，条件见下 | 是 |
| `draining` | 手头任务做完，不接新任务 | 管理员 drain | 否 |
| `offline` | 90 秒没有心跳（叠加在其它状态上显示） | 心跳中断 | 否 |

uncordon 的条件（不满足返回 409）：协议版本在支持范围内；90 秒内有心跳；最近一次心跳的自检 `passed` 与 `model_ready` 都为真；至少有一种执行器就绪；健康门已关。

### 自检

节点把自检结果放在心跳 `health.self_check` 里，固定为这几个键：`passed`、`omp_version`、`sandbox_ready`、`vm_ready`、`model_ready`，失败时另有 `error`。control 拒绝其它键；`omp_version` 为 `null` 时按没通过处理。自检只认真实采集的证据：

- **sandbox**：至少一个槽位的 runner 报到，交出的证据满足：`omp --version` 成功（节点配置了期望版本时还要一致）、runner 报出版本、uid 不是 0、CapEff 全 0、NoNewPrivs 为 1、Seccomp 为 2（filter）、根文件系统只读、除回环外没有网卡。
- **VM**：前置条件满足（`/dev/kvm` 可读写、qemu 与 qemu-img 能执行、基础镜像、工具盘与 cloud-init 种子都在、node 进程自身 CapEff 全 0、NoNewPrivs 为 1、Seccomp 为 2），并且最近一次探针 VM 通过：QMP 可用且报告运行中；来宾里的 runner 发出事件；降权用户执行 `omp --version` 成功；经 guestfwd 的模型端点带 fw_cfg 里的一次性探针令牌返回 200；宿主别名、用户态网络 DNS、一个私网地址、云元数据地址和一个公网地址全部直连失败；240 秒内由来宾自行关机，并由 QMP 的 SHUTDOWN 事件确认原因是 `guest-shutdown`。探针通过后每 6 小时、失败后每 10 分钟重跑一次，只在没有 VM 任务时跑。
- **模型中继**：节点调用 N-08，control 用自己的网关密钥对网关做一次只读的 `GET /models`，并要求实例配置了模型 catalog。通过后每 5 分钟、失败后约每 65 秒再检查一次。

`passed` 只在全部启用的执行器和模型中继都通过、且至少启用了一种执行器时为真。control 按 `sandbox_ready`、`vm_ready` 把节点声明的槽位收紧：没就绪的执行器槽位记为 0。节点自己也只在模型自检通过时领任务。

### 主机健康字段

心跳 `health` 是开放对象（最多 64 个键）。control 解析并用于健康门的字段：

| 字段 | 节点怎样采集 | control 怎样用 |
|---|---|---|
| `disk_free_percent`、`disk_free_mib` | 数据目录的 `statfs`；读不出时节点自我隔离 | 必需；缺失按「磁盘可用空间未知」关门 |
| `mem_available_mib` | `/proc/meminfo` 的 MemAvailable，不是 Linux 时取 `os.freemem` | 必需；缺失关门。VM 任务要求它不小于任务内存加 1,024 MiB |
| `max_temp_c` | `/sys/class/thermal` 与 `/sys/class/hwmon` 的最高读数；没有可读传感器时不填 | 可选；缺失只记提示，不关门 |
| `on_battery` | `/sys/class/power_supply`；没有电源设备可读时不填 | 可选；为真时关门 |
| `self_check` | 见上 | 必需；缺失或没通过关门 |
| `self_cordon` | 节点本地越线判定的原因；没有时为 `null` | 非空时关门 |

越线与恢复带回滞，节点和 control 用同一组阈值：已知温度 ≥ 95 °C、磁盘可用 < 8% 或 < 4,096 MiB、已知电池供电时关门；恢复要已知温度 < 85 °C、磁盘可用 ≥ 12% 且 ≥ 6,144 MiB。健康门开关时 control 写审计并发告警。

节点还会上报只用于展示与对账的字段：`boot_id`、`seq`、`leases`、`running`、`replaying`、`sandbox_slots`（`connected`、`idle`、`busy`、`tainted`、`verified`）、`vm_ready`、`vm_reason`、`self_check_detail`、`kvm_available`、`temp_sensors`、`mem_total_mib`、`load`、`cpu_threads`、`battery_percent`。

## 端点表

方向都是节点 → control。请求和响应的 TypeScript 形状在 `packages/protocol/src/shared.ts`，control 的 JSON Schema 在 `app/control/src/routes/platform/node/contracts.ts`。

| 编号 | 方法与路径 | 请求 | 成功响应 | 说明 |
|---|---|---|---|---|
| N-01 | `POST /api/node/v1/heartbeat` | `MachineHeartbeat`：`name`、`protocol_version`、`capacity`（`cpu`、`memory_mib`）、`slots`（`sandbox`、`vm`，节点按自检收紧后的值）、`tags`、`health` | `HeartbeatReply`：`machine_id`、`status`、`lease_lost_after_s`、`cancel_task_ids` | 第一次心跳把 `pending` 变成 `cordoned`，即登记。协议版本不符也接受 |
| N-02 | `POST /api/node/v1/lease`，可带 `Idempotency-Key` | `LeaseRequest`：`available`（各执行器空闲槽位）、`resources`（剩余 `cpu`、`memory_mib`）、`wait_s`（0～25） | `{ task: ExecutionTask \| null }`，等到 `wait_s` 仍没有任务时 `task` 为 `null` | 挑选条件见下文「派发条件」 |
| N-03 | `POST /api/node/v1/tasks/{task_id}/renew` | 体：`lease_id`、`epoch` | `lease_expires_at`、`lease_ttl_s`、`cancel` | 第一次即确认；`cancel` 为真时节点停止任务 |
| N-04 | `GET /api/node/v1/tasks/{task_id}/bundle?lease_id=…&epoch=…` | 查询串栅栏 | 任务包原始字节（`application/json`），头 `X-Geek-Bot-Bundle-Sha256` | 节点核对 sha256 等于 `bundle_sha256`，不符交失败 `bundle_invalid` |
| N-05 | `POST /api/node/v1/tasks/{task_id}/events` | `lease_id`、`epoch`、`events`（最多 500 条：`seq` ≥ 1、`at`、`kind`、`text` ≤ 65,536 字符） | `{ ack_seq }`：该任务已存事件的最大 `seq` | control 再打码一次后入库，`at` 改成 control 收到的时间，经 SSE 推给后台 |
| N-06 | `POST /api/node/v1/tasks/{task_id}/result` | `lease_id`、`epoch`、`result`（`TaskResult`） | `{ status }` | 进入 `awaiting_publish`；已请求取消时记为 `cancelled` |
| N-07 | `POST /api/node/v1/tasks/{task_id}/failure` | `lease_id`、`epoch`、`code`、`message`（≤ 4,000 字符） | `{ status, requeued }` | 失败码的处理见下 |
| N-08 | `POST /api/node/v1/self-check/model` | 空对象 | `ok`、`checked_at`、`models`，失败时 `error` | 只用节点令牌，`pending` 的机器也能调用 |
| N-09 | `GET /api/node/v1/model/v1/models`；`POST /api/node/v1/model/v1/chat/completions` | 头：`X-Geek-Bot-Task-Token`、`X-Geek-Bot-Lease`、`X-Geek-Bot-Epoch`、`X-Geek-Bot-Task`；chat 的体是 OpenAI 兼容格式 | `models` 只列本任务池里的模型，不访问网关；chat 由 control 换成网关密钥转发，流式或非流式原样返回 | 核对与请求体白名单见下文「模型中继的请求体」 |

N-07 的失败码（`FAILURE_CODES`）：

| 失败码 | control 的处理 |
|---|---|
| `bundle_invalid`、`vm_start_failed` | 收回重排，计一次基础设施失败，排除这台机器 |
| `resource_unavailable`、`infra_failure` | 收回重排，计一次基础设施失败 |
| `draining`、`node_shutdown` | 收回重排，不计失败 |
| `timeout`、`model`、`schema` | 任务判 `failed` |
| `cancelled` | 任务记为 `cancelled`；已请求取消时任何非基础设施失败码都记为 `cancelled` |

### 派发条件

N-02 在一个事务里按 `priority` 从高到低、创建时间从早到晚挑选第一个满足全部条件的 `queued` 任务：

- 机器管理状态是 `ready`，健康门已关；
- 项目已启用、仍在平台上存在，所属连接已启用；
- 执行器槽位：取「后台设定」与「节点心跳声明（按自检收紧）」的较小值，减去运行中的任务，再与请求里的 `available` 取小，至少为 1；CPU 与内存同理；
- VM 任务要求主机可用内存不小于任务内存加 1,024 MiB，未知时不派；
- 私有项目只派给信任等级 `high` 的机器；
- 机器标签包含项目要求的全部标签；机器不在该任务的排除名单里；项目绑定了机器时只派给绑定的机器。

### TaskSpec（ExecutionTask）

N-02 返回的 `ExecutionTask` 是 `TaskRecord` 加上执行用的字段：

- `TaskRecord` 部分：`id`、`project_id`、`demand_id`、`item_id`、`kind`、`executor`、`status`、`priority`、`resources`（`cpu`、`memory_mib`）、`machine_id`、`epoch`、`lease_id`、`head_sha`、`base_sha`、`lease_expires_at`、`result`、`error`、`created_at`、`updated_at`；
- 执行字段：`task_id`、`lease_id`、`model_token`、`model_pool`（按顺序的 `{ model, effort }`）、`timeout_s`、`bundle_sha256`、`prompt`、`tools`、`api_style`（固定 `openai`）。

`tools` 由 control 按任务类型给出：review、triage、followup 是 `read`、`grep`、`glob`；fix、rework 另加 `edit`、`write`、`bash`。fix、rework 只能派到 `vm`；review、triage、followup 由派发时选择执行器。模型池与预算的来源见 [control 服务契约](../control/README.md)。

节点交给 runner 的只是其中的 `task_id`、`kind`、`executor`、`timeout_s`、`bundle_sha256`、`prompt`、`tools`、`model_pool`，模型令牌另行传递，租约字段不进入 sandbox 和 VM。

### 任务包

N-04 返回的是 `TaskBundle` 的 JSON 字节，sha256 按落库时下发的原样字节计算，最大 20 MiB：

- `files`：仓库文件，每项 `path`、`content`、`encoding`（`utf8` 或 `base64`）；
- `diff`：变更的 diff；
- `rules`：base 分支的规则文件，每项 `path`、`content`；
- `meta`：元数据，必须含固定的 `head_sha` 与 `base_sha`。

control 生成任务包时拒绝不安全路径（绝对路径、`..`、反斜杠、空段）和 `.omp`、`.claude`、`.cursor`、`mcp.json`、`.env*`；runner 解包前按更严的清单再核对一遍（[runner 服务契约](../runner/README.md)）。

### 模型中继的请求体

N-09 先核对：节点令牌有效；`X-Geek-Bot-Lease` 是 32 位十六进制、`X-Geek-Bot-Epoch` 是正整数；租约属于这台机器、`X-Geek-Bot-Task` 等于租约对应的任务；任务在运行中、epoch 一致、租约没过期；任务令牌的哈希等于本租约的令牌。之后：

- 请求体只放行 `model`、`messages`、`tools`、`tool_choice`、`temperature`、`top_p`、`max_tokens`、`stop`、`stream`、`stream_options`、`reasoning_effort`、`n`；`n` 只能是 1，转发前删掉。
- `model` 必须在本任务的池里；带了 `reasoning_effort` 时必须是池里给这个模型配的档位。
- `tools` 每项只能是 `type: "function"`；`messages` 必须是数组；`stream` 必须是布尔值。
- 流式请求强制 `stream_options.include_usage: true`；非流式删掉 `stream_options`。
- 先占一次请求数，再把 `max_tokens` 封顶为剩余 token；任一预算用完返回 429 `budget_exhausted`。
- control 记录每个请求的模型、档位、HTTP 状态、耗时与用量，并累计 token。非流式响应打码后返回，流式响应原样转发字节。

runner 发出的实际字段见 [runner 服务契约](../runner/README.md)「omp 配置」。

## sandbox 与 VM 怎样访问节点

sandbox 和 VM 不直接连 control，只连所在节点的本地端点。本地端点由 node 进程提供，不绑定宿主的任何 TCP 端口。节点令牌、租约 id 和 epoch 都不进入 sandbox 和 VM。

| 用途 | sandbox | VM |
|---|---|---|
| 连接方式 | 每个槽位一个 unix socket `<槽位目录>/sandbox-<n>/node.sock`（0600），经共享卷挂进槽位容器的 `/run/geek-bot/node.sock`。每个请求带 `X-Runner-Session`（runner 进程启动时生成的 UUID） | `-netdev user,restrict=on`，只有两条 guestfwd：QEMU 用户态网络的 guestfwd 地址上的模型端口和出网代理端口，各经 netcat 转到本任务目录里的 `model.sock`、`egress.sock`。节点没有配置出网白名单时不建出网那一条 |
| 报到 | `POST /v1/hello`：交出隔离证据，响应 `accepted`、`problems` | 探针 VM 的输出盘 `probe-result.json` |
| 任务输入 | `GET /v1/task?wait=25`：200 `{ task, model_token }` 或 204；`GET /v1/bundle`：任务包原始字节 | 只读原始盘上的 ustar：`task.json`（任务字段与两个端点，不含令牌）、`bundle.json` |
| 模型令牌 | 随 `/v1/task` 的响应进入 runner 内存 | `-fw_cfg name=opt/geekbot/token,file=<0600 临时文件>`，QMP 可用后节点立即删除临时文件；来宾里只有 root 可读 |
| 实时事件 | `POST /v1/events { events }`，响应 `{ cancel }` | virtio-serial 端口 `org.geekbot.events`，一行一个 JSON；300 秒内没有任何事件时节点结束 VM |
| 结果 | `POST /v1/result { result }` 或 `POST /v1/failure { code, message }` | 可写原始盘（32 MiB）上的 `result.json` 或 `failure.json`，VM 关机后节点读取 |
| 模型请求 | 同一个 socket 的 `/model/v1/chat/completions`、`/model/v1/models`，`Authorization: Bearer <模型令牌>` | 经 guestfwd 到 `model.sock` 的同样路径 |
| 出网 | 没有网络 | 只经出网 CONNECT 代理，见 [node 服务契约](README.md)「出网代理」 |
| 取消 | `/v1/events` 响应 `cancel: true`；35 秒内没交结局，节点按 `cancelled` 结束、撤销模型访问并把槽位记为污染 | QMP `system_powerdown`，30 秒后 `quit`，再 5 秒 SIGKILL |

sandbox 的槽位规则：只有通过自检的会话能领任务；同一会话交完结局后被记为退役，必须换新进程（新会话）才算空闲；任务交给槽位 15 秒内没有会话来领，按 `resource_unavailable` 结束并把槽位记为污染。只有领到任务的会话能取任务包、交事件、交结局和调模型。

本地模型代理收到请求后，按常量时间比较 `Authorization` 与本任务的模型令牌，任务已结束或被撤销时返回 401 `task_token_invalid`；通过后把令牌移到 `X-Geek-Bot-Task-Token`，加上节点令牌、租约头和任务头转成 N-09，响应（含 SSE）原样流回。control 返回 401 且不是 `task_token_invalid` 时，节点整体停机。

### 事件打码

事件离开节点前打码：节点令牌和在跑任务的模型令牌按原值替换；再按密钥形态替换私钥块、`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`、`github_pat_`、`glpat-`、`sk-`、`gbn_`/`gbt_`、Slack 的 `xox?-`、`AKIA`，以及 `Bearer`、`Basic` 后面的凭据，替换成 `[已打码]`。control 收到后不假设事件干净，入库前按自己的规则再扫一遍。

## 验证状态

#34 已实际执行：

- 真实 HTTP/SQLite 烟雾：双平台项目同步、条目与需求派发、租约栅栏、一次性节点令牌重放 409、viewer 写入 403、重启数据持久；
- 实际 ControlClient 对真实 control 领取任务、续租、取包并核对 sha256、交事件与结果；可执行 node 注册和心跳、无执行器时保持 cordoned、SIGTERM 退出 0；
- Core HTTP 回归 8 项、runner 安全回归 99 项、磁盘 spool 回归 18 项。平台与模型上游是隔离夹具，未用真实账号或执行器完成任务。

没有实际验收，不能标为 PASS：

- 带 sandbox 或 VM 执行器的 worker 完整任务，以及 401 整体停机、409 单任务停止、失联销毁与缓存回放的集成演练；
- 自检（sandbox 报到证据、探针 VM、模型自检）在真实隔离环境里的行为；
- Linux/KVM 主机上的探针 VM、任务 VM、fw_cfg 令牌、guestfwd、QMP 关机与取消；
- 节点镜像与 sandbox 镜像的构建，以及 sandbox 端到端执行；
- 温度、供电等硬件传感器的读数和越线回滞；
- 完整的节点/control 自动契约矩阵；实际 ControlClient 的本机 smoke 只覆盖上述主路径，不等于已覆盖所有消息边界。

类型检查和源码一致只说明接口对得上，不代替以上任何一项。
