# node 服务契约（`app/node`）

> 工作节点代理：只向外连 control 领任务、回报结果，不开入站端口；在节点上调度无网 sandbox 槽位和一次性 QEMU/KVM VM，并为它们提供本地模型代理和出网代理。

状态：`current` · 更新：2026-10-03 · 适用：`app/node`（`@geek-bot/node`）、`tests/node`（由 #34 实现）

`current` 只表示本文与 #34 的源码一致，不表示节点已经在真实主机或线上验收；哪些跑过、哪些没跑过见「验证状态」。与 control 之间的消息逐条见 [节点协议](protocol.md)，本文不重复。

## 职责

- 只由节点主动连 control 的 `/api/node/v1`：心跳与对账、长轮询领任务、确认与续租、取任务包、回传事件、交结果或失败。control 从不连节点。
- 按心跳响应和本地状态决定停什么：401 整体停机；某个租约的 409 或 404 只停这个任务；失联时销毁在跑任务、保留缓存待回放。
- 每个租约一份磁盘事件缓存，control 确认后才推进；重启或失联后用原来的栅栏回放。
- 自检与主机健康：采集真实证据，越线时自我隔离，恢复带回滞。
- 两种执行器：sandbox 槽位（无网、根只读的独立容器，里面的 runner 经 unix socket 来领任务）和每任务一台的 QEMU/KVM VM。
- 为 sandbox 和 VM 提供本地模型代理（把模型请求转成 control 的模型中继）和 VM 的出网 CONNECT 代理。
- 节点只持有自己的节点令牌，不持有 GitHub 凭据和模型网关密钥；结果只交给 control，从不写 GitHub。

## 源码地图

| 路径 | 内容 |
|---|---|
| `app/node/package.json` | `@geek-bot/node`，只依赖 `@geek-bot/protocol`；脚本 `typecheck`、`build`（`tsc`，输出 `dist/`） |
| `src/main.ts` | 可执行入口 `dist/main.js`：读配置、检查明文 http 地址、建数据目录、启动 `Worker`，处理 SIGTERM、SIGINT |
| `src/index.ts` | 库入口，只导出给测试和类型用的符号，导入它不会启动任何服务 |
| `src/config.ts` | `createNodeConfig(env)`：control 地址、节点名、各执行器槽位上限 |
| `src/worker-config.ts` | `createWorkerConfig(env, host)`：在上一项之外读令牌文件路径、标签、资源、目录、VM 资产、出网规则、心跳间隔、缓存上限、期望的 omp 版本；一次列出全部问题 |
| `src/control-client.ts` | `ControlClient`：加认证头和协议头；任务请求同时带租约头与体内（或查询串）栅栏；错误统一抛 `ControlHttpError` |
| `src/worker.ts` | 编排：心跳、领任务、单个租约的生命周期、401 整体停机、失联、回放、停机 |
| `src/spool.ts` | `TaskSpool`：每个租约的磁盘事件缓存与结局文件 |
| `src/health.ts` | 主机健康采集（只读 `/proc`、`/sys`、`statfs`）与自我隔离的回滞判定 |
| `src/self-check.ts` | 自检判定：sandbox 报到证据、node 进程自身隔离、心跳里 `self_check` 的固定形状 |
| `src/healthcheck.ts` | 容器 `HEALTHCHECK`：读 `status.json` 判断最近一次成功心跳 |
| `src/executor.ts` | 执行器接口；runner 事件与结果的再校验；交给 runner 的任务字段 |
| `src/sandbox.ts` | `SandboxPool`：每个槽位一个 unix socket 上的本地端点与会话状态 |
| `src/model-relay.ts` | 本地模型代理：核对模型令牌后转成 control 的模型中继 |
| `src/egress-proxy.ts` | VM 的出网 CONNECT 代理与禁止地址段 |
| `src/redact.ts` | 事件离开节点前的打码 |
| `src/vm/pool.ts` | `VmPool`：QEMU/KVM 执行器、探针 VM、残留清理 |
| `src/vm/qmp.ts` | QMP 最小客户端：`query-status`、`system_powerdown`、`quit`、SHUTDOWN 事件 |
| `src/vm/tar.ts` | VM 输入盘与输出盘的 ustar 读写（与 runner 的实现读写同一格式，按边界规则不互相导入） |
| `vm/user-data`、`vm/meta-data` | cloud-init NoCloud 种子：只挂工具盘、执行 `guest-init.sh`、关机 |
| `vm/guest-init.sh` | 来宾里的启动脚本：建降权用户 `geekbot`，以 root 运行 `runner.mjs vm`，结束后关机 |
| `Dockerfile` | 节点镜像（默认目标）与 sandbox 槽位镜像（`--target sandbox`） |
| `docker/fetch-verified.mjs` | 镜像构建用的下载器：边下载边算摘要，与钉死的值不符就删文件并失败 |
| `tests/node/config.test.ts` | `createNodeConfig` 的读取、默认槽位、地址规范化与非法输入 |
| `tests/node/spool.test.ts` | 磁盘事件与结局持久化、确认重放、水位、容量与损坏恢复 |

新增或删除文件时同步更新本表。

## 进程与启动

`main.ts` 的顺序：

1. `createWorkerConfig(process.env, 宿主 CPU 数与总内存)`。不合法时打印全部问题，退出码 78。
2. control 地址是明文 http 时解析主机名，解析出的每个地址都必须在禁止出网的地址段里（私网、回环等），否则退出码 78。
3. 建数据目录（0700），构造 `Worker`：读令牌文件，内容去掉首尾空白后必须是 16～512 个可见 ASCII 字符，否则退出码 78。
4. `Worker.run()`：建缓存根目录，清理残留 VM，监听 sandbox 槽位 socket，打开上次留下的缓存开始回放，然后并行跑心跳、领任务、令牌文件检查、模型自检四个循环，另有每秒一次的失联检查。

SIGTERM、SIGINT：停止领任务，在跑的任务以 `node_shutdown` 结束，最多等 40 秒；交不完的缓存留在磁盘上，下次启动回放。正常停机退出码 0，异常退出 1。

日志是一行一个 JSON（`ts`、`level`、`message` 和上下文字段），错误写 stderr。

## 配置

都是环境变量，由 `src/config.ts` 与 `src/worker-config.ts` 读取。节点不读任何 `.env` 文件。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `GEEK_BOT_NODE_CONTROL_URL` | 必填 | control 地址，只许 http 或 https，规则见「进程与启动」 |
| `GEEK_BOT_NODE_NAME` | 必填 | 节点名，小写字母、数字和连字符，1～63 个字符，首尾不能是连字符；后台登记机器时用同一规则，心跳里的名字必须等于登记的机器名，否则 401 |
| `GEEK_BOT_NODE_TOKEN_FILE` | 必填 | 节点令牌文件的绝对路径，只读挂载 |
| `GEEK_BOT_NODE_SANDBOX_SLOTS` | `1` | sandbox 槽位数 |
| `GEEK_BOT_NODE_VM_SLOTS` | `0` | VM 槽位数；需要 `/dev/kvm`，由部署者显式打开 |
| `GEEK_BOT_NODE_TAGS` | 空 | 逗号分隔的机器标签，最多 32 个 |
| `GEEK_BOT_NODE_CPU` | 宿主逻辑 CPU 数 | 交给平台调度的 CPU 上限（1～256） |
| `GEEK_BOT_NODE_MEMORY_MIB` | 宿主总内存 | 交给平台调度的内存上限（128～1,048,576 MiB） |
| `GEEK_BOT_NODE_DATA_DIR` | `/var/lib/geek-bot` | 数据目录 |
| `GEEK_BOT_NODE_SLOTS_DIR` | `<数据目录>/slots` | sandbox 槽位 socket 所在目录 |
| `GEEK_BOT_NODE_QEMU`、`GEEK_BOT_NODE_QEMU_IMG`、`GEEK_BOT_NODE_NETCAT` | `qemu-system-x86_64`、`qemu-img`、`nc` | 程序名或绝对路径；netcat 要支持 `-U` |
| `GEEK_BOT_NODE_VM_BASE_IMAGE`、`GEEK_BOT_NODE_VM_TOOLS_IMAGE`、`GEEK_BOT_NODE_VM_SEED_ISO` | `/opt/geekbot/vm/base.qcow2`、`tools.img`、`seed.iso` | VM 资产，节点镜像里已带 |
| `GEEK_BOT_NODE_VM_DISK_GIB` | `20` | 每台 VM 的 overlay 大小（4～512） |
| `GEEK_BOT_NODE_EGRESS_ALLOW` | 空 | VM 出网允许的域名后缀，逗号分隔；为空时 VM 不能出网 |
| `GEEK_BOT_NODE_EGRESS_DENY_CIDRS` | 空 | 在内置禁止地址段之外追加的网段（例如部署者的组网网段） |
| `GEEK_BOT_NODE_EGRESS_MAX_CONNECTIONS` | `512` | 每个 VM 任务的出网连接数上限 |
| `GEEK_BOT_NODE_EGRESS_MAX_BYTES` | 4 GiB | 每个 VM 任务的出网总字节上限 |
| `GEEK_BOT_NODE_HEARTBEAT_SECONDS` | `10` | 心跳间隔（2～60） |
| `GEEK_BOT_NODE_SPOOL_MAX_MIB` | `200` | 每个租约未确认事件的缓存上限（1～10,240） |
| `GEEK_BOT_NODE_OMP_VERSION` | 不比较 | sandbox 里的 omp 必须报出的版本，写 `18.4.4` 或 `omp/18.4.4`；节点镜像构建时设为 `18.4.4` |

control 侧与节点有关的配置（失联期限、基础设施重试上限、任务时长、模型 catalog 与预算）只在 [control 服务契约](../control/README.md) 和 [默认行为与配置项](../control/behavior.md) 里定义。

## 与 control 的交互

逐条规则见 [节点协议](protocol.md)，这里只写节点侧怎样执行：

- **请求头**：每个请求带 `Authorization: Bearer <节点令牌>`、`X-Geek-Bot-Protocol`、`X-Geek-Bot-Node`。续租、取任务包、事件、结果、失败五个任务请求另带 `X-Geek-Bot-Lease`、`X-Geek-Bot-Epoch`，同时在体（取任务包是查询串）里带 `lease_id`、`epoch`。
- **心跳**：`health` 里带 `boot_id`、`seq`（同一 `boot_id` 内递增）、`leases`（含待回放的）、主机健康字段和自检。`slots` 按自检收紧；自我隔离时报 0。响应的 `cancel_task_ids` 里的在跑任务立即停止，`lease_lost_after_s` 不小于 60 时采用。
- **领任务的门**：只在没有整体停机、不在停机中、心跳响应状态是 `ready`、没有自我隔离、模型自检通过、而且有空闲槽位和资源时长轮询。
- **单个租约**：领到后立即续租确认（最多试 20 次）；按 `lease_ttl_s` 定时续租；取任务包核对 sha256；fix、rework 不在 VM 上时直接交失败；交给执行器；超过 `timeout_s + 60` 秒强制停止；结局按停止原因回报：取消 `cancelled`、超时 `timeout`、停机 `node_shutdown`、缓存写坏 `infra_failure`。
- **401**（`task_token_invalid` 除外，任何端点都算）：整体停机，销毁全部任务和全部缓存，停止心跳和领任务，`status.json` 记 `halted: true`。每 10 秒读一次令牌文件，内容变了就用新的 `boot_id` 重新开始。
- **409 或 404**（任务请求）：只销毁这个任务并删除它的缓存。
- **失联**：连续 `lease_lost_after_s - 30` 秒没有收到 control 的非 5xx 响应，销毁全部在跑任务，缓存转成回放。

## 磁盘缓存与回放

缓存目录 `<数据目录>/spool/<task_id>@<epoch>/` 的文件、上限与删除条件见 [节点协议](protocol.md)「缓存与回放」。节点侧的要点：

- 执行器发出的事件先打码再追加进缓存；每秒取一批，发送前 fsync，control 接收后推进 `ack`。
- 结局先写 `outcome.json` 再交付；control 拒收结果（非 409、404 的 4xx）时改交失败 `schema`。
- 缓存建不起来或写坏时，任务以 `infra_failure` 结束，不会在没有缓存的情况下继续。
- 启动时缓存根目录里不认识的条目删除；读不出的缓存记错误后删除，不当作已交付。

## 自检与健康

- **自检**：sandbox 看槽位 runner 的报到证据，VM 看前置条件加探针 VM，模型中继调 control 的自检端点；判定条件见 [节点协议](protocol.md)「自检」。心跳的 `self_check_detail` 带三项各自的 `ok`、`error`、`checked_at`。
- **健康采集**：磁盘可用空间（数据目录）、可用内存为必需项，采集不到时节点自我隔离，不编值；温度和供电是可选项，读不到就不填。
- **自我隔离的回滞**：已知温度 ≥ 95 °C、磁盘可用 < 8% 或 < 4,096 MiB、已知电池供电时隔离；已经隔离时要温度 < 85 °C、磁盘可用 ≥ 12% 且 ≥ 6,144 MiB 才解除。与 control 健康门用同一组阈值。
- **容器健康检查**：`dist/healthcheck.js` 读 `<数据目录>/status.json`，最近一次成功心跳在 `3 × 心跳间隔 + 30` 秒以内且没有整体停机时返回 0。节点不开端口，所以不用 HTTP 探活。

## 执行器

### sandbox 槽位

- node 不持有 `docker.sock`，不起容器。部署者为每个槽位起一个 sandbox 容器（`--target sandbox` 镜像），把 `<槽位目录>/sandbox-<n>/` 挂进容器的 `/run/geek-bot/`。容器里的 runner 自己来报到、领任务，做完一个就退出，由容器的重启策略换新进程和新的 tmpfs。
- 槽位 socket 权限 0600；节点启动时删掉旧 socket 重新监听。
- 会话、报到证据、退役、污染、取消宽限的规则见 [节点协议](protocol.md)「sandbox 与 VM 怎样访问节点」。

### QEMU/KVM VM

每个任务一台一次性 VM，工作目录 `<数据目录>/vm/<随机名>/`（0700），任务结束连同目录删除：

- 盘：qcow2 overlay 叠在只读基础镜像上；只读输入盘（ustar：`task.json`、`bundle.json`，不含令牌）；只读工具盘（squashfs：node、omp、omp 原生模块、`runner.mjs`、`guest-init.sh`）；可写输出盘（32 MiB）；cloud-init 种子光盘。
- 资源：vCPU 取任务的 `cpu`，内存取任务的 `memory_mib`（至少 512 MiB）；`-cpu host`、`-enable-kvm`、`-no-reboot`，没有显示和监视器。
- 网络与令牌：`restrict=on` 加两条 guestfwd，模型令牌经 fw_cfg 传入，规则见 [节点协议](protocol.md)「sandbox 与 VM 怎样访问节点」。
- 隔离：`-sandbox on,obsolete=deny,resourcecontrol=deny`，不带 `elevateprivileges=deny`，由 node 容器的 `cap_drop: ALL`、`no-new-privileges` 和 seccomp 兜底（[ADR-0011](../../decisions/0011-qemu-sandbox-elevateprivileges.md)）；node 进程自身不满足这几项时 VM 不就绪。
- 事件经 virtio-serial；QMP 在任务目录里的 unix socket 上。qemu 起不来或来宾没写出结果时，按 `vm_start_failed` 或 `infra_failure` 回报。
- 清理：启动时结束命令行指向 VM 工作目录的残留 qemu 进程并清空目录；之后每 5 分钟删掉没有对应任务或探针的目录。
- 探针 VM 用与任务 VM 相同的参数，只是输入盘里只有 `probe.json`，不传任何真实令牌。探针在跑时占一个 VM 槽位。

### 出网代理

每个 VM 任务一个，监听任务目录里的 `egress.sock`，来宾经 guestfwd 连到它。没有配置 `GEEK_BOT_NODE_EGRESS_ALLOW` 时不启动，VM 没有出网通路。

- 只接受 `CONNECT <域名>:443`；直接写 IP、端口不是 443、主机名不合法都拒绝。
- GitHub 域名（`github.com`、`githubusercontent.com`、`ghcr.io`、`github.io`、`githubassets.com` 及其子域）先于白名单拒绝；不在白名单后缀里的拒绝。
- 只解析一次；解析结果里只要有一个地址落在禁止地址段（私网、CGNAT、回环、链路本地、组播、保留、嵌入 IPv4 的 IPv6 写法和部署者追加的网段）就整体拒绝；只连接校验过的那个地址，不再重新解析。
- 隧道建立后先读客户端的 TLS ClientHello，SNI 必须与 CONNECT 的主机名一致（10 秒内读不到、不是 TLS 或没有 SNI 都拒绝），之后才连上游。
- 连接数在解析前占位；总字节逐块核对，超限断开两端。记录只含主机名、端口、地址、字节数和决定，不记载荷。禁止地址段在运行时由数字拼出，源码里没有地址字面量。

## 镜像

`app/node/Dockerfile`，构建上下文是仓库根，只支持 `linux/amd64`：

```bash
docker build --platform linux/amd64 -f app/node/Dockerfile -t geek-bot-node:local .
docker build --platform linux/amd64 -f app/node/Dockerfile --target sandbox -t geek-bot-sandbox:local .
```

钉死的构建输入（改任何一项都要同时改摘要）：

- 基础镜像按 digest 引用 `node:22-bookworm-slim`；
- Debian 软件包取自 [snapshot.debian.org](https://snapshot.debian.org/) 的固定时间点，apt 照常校验签名；
- omp 18.4.4 的 linux-x64 发布二进制（[oh-my-pi releases](https://github.com/can1357/oh-my-pi/releases)）按 sha256 校验，构建时核对 `omp --version` 输出 `omp/18.4.4`，并预先解出原生模块；
- VM 基础镜像是 [Debian 12 genericcloud](https://cloud.debian.org/images/cloud/) 的固定日期构建，按 sha512 校验；
- 来宾里的 node 取自基础镜像里的同一个二进制；`runner.mjs` 是同一次构建的单文件产物。

节点镜像：非 root（`node`，uid 1000），装有 `qemu-system-x86`、`qemu-utils`、`netcat-openbsd`，VM 资产在 `/opt/geekbot/vm/`，`GEEK_BOT_NODE_OMP_VERSION` 设为 18.4.4，带 `HEALTHCHECK`。sandbox 镜像：非 root，只有 omp、`runner.mjs` 和 node，入口是 `runner.mjs slot`。镜像里没有任何令牌、域名或环境身份。

运行时的容器要求（由自检强制，不满足时对应执行器不就绪）：

- node 容器：不发布端口、不挂 `docker.sock`；`cap_drop: ALL`、`no-new-privileges`、保留默认 seccomp；VM 槽位大于 0 时只挂 `/dev/kvm` 设备并加入宿主 kvm 组；令牌文件只读挂载；数据目录用命名卷。
- sandbox 容器：`network_mode: none`、根只读、`/work` 与 `/tmp` 用 tmpfs、`cap_drop: ALL`、`no-new-privileges`、非 root、只挂本槽位的共享目录、重启策略让进程退出后自动重建。

仓库里还没有 node 与 sandbox 的 compose 文件和节点运维手册，随部署文档（#7）与 NODES（#11）加入。在那之前本节只是镜像契约，不是部署步骤。

## 本地数据

节点没有数据库。数据目录下只有：`status.json`（给容器健康检查）、`spool/`（未交付的事件与结局）、`vm/`（VM 工作目录）、`slots/`（sandbox 槽位 socket）。令牌只在内存和只读挂载的文件里，不写进数据目录。

## 运行与验证

```bash
pnpm --filter @geek-bot/node typecheck
pnpm exec vitest run tests/node
```

本机开发时可以对本机 control 起一个节点（control 的启动见 [LOCAL-DEV](../../ops/LOCAL-DEV.md)，机器在后台登记后把一次性令牌存成文件）：

```bash
GEEK_BOT_NODE_CONTROL_URL=http://localhost:<control 端口> \
GEEK_BOT_NODE_NAME=<后台登记的机器名> \
GEEK_BOT_NODE_TOKEN_FILE=<令牌文件的绝对路径> \
GEEK_BOT_NODE_DATA_DIR=<可写目录的绝对路径> \
pnpm dev:node
```

`pnpm dev:node` 依次构建 protocol、runner、node，再运行 `app/node/dist/main.js`，只用于本机开发，不是部署方式。#34 已实跑可执行 node 对本机真实 control 的注册与心跳：无执行器时保持 cordoned，SIGTERM 后退出码 0。这不证明 sandbox、VM 或模型自检已通过。

VM 可行性实验的脚本 `pnpm test:vm` 只在有 KVM 的机器上手动跑，覆盖的是 #12 的实验配方，不是 `VmPool`（[VM 可行性实测](vm-feasibility.md)）。

## 验证状态

#34 已实际执行：真实 HTTP/SQLite 与实际 ControlClient 的领取、续租、取任务包、事件和结果往返；迟到 epoch 返回 409；可执行 node 的注册、无执行器隔离与正常停机；Core HTTP 回归 8 项；磁盘 spool 回归 18 项。外部平台与模型接口使用隔离夹具，未运行真实执行任务。

没有实际验收，不能标为 PASS：

- worker 携带真实执行器的完整任务，以及 401 整体停机、409 单任务停止、失联销毁与缓存回放的集成演练；
- 自检（sandbox 报到、探针 VM、模型自检）在真实隔离环境里的行为；
- Linux/KVM 上的探针 VM、任务 VM、fw_cfg、guestfwd、QMP 取消与关机；
- 节点镜像与 sandbox 镜像的构建、sandbox 端到端执行；
- 温度、供电等硬件传感器的读数与回滞。

## 已知限制

- `tests/node` 覆盖配置与 spool；`worker`、`health`、`self-check`、`sandbox`、`model-relay`、`egress-proxy`、`vm/*` 没有自动化测试。`tests/integration/vm` 测的是 #12 的实验代理，不是 `src/egress-proxy.ts`。
- 期望的 omp 版本只核对 sandbox 槽位；探针 VM 只要求 `omp --version` 成功，不和 `GEEK_BOT_NODE_OMP_VERSION` 比较。
- 只支持 x86_64（qemu-system-x86_64 与 linux/amd64 镜像）。
- 心跳间隔由节点本地配置，control 不下发；control 只按 90 秒判 `offline`。
- 执行隔离的安全要求见 [SECURITY](../../architecture/SECURITY.md)；#12 的实测结论和尚未实测的项目见 [VM 可行性实测](vm-feasibility.md)。
