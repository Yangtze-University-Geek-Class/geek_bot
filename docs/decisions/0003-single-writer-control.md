# ADR-0003：控制面单进程单写者；节点只出站拉任务；control 是唯一 GitHub 写入方

> control 是一个独占 SQLite 写入的 Fastify 进程，也是唯一写 GitHub 的地方；节点只主动连 control 领任务，不开入站端口，不持有 GitHub 凭据。

状态：`accepted` · 更新：2026-09-26 · 适用：`app/control` 的进程与写入模型、节点协议 `/api/node/v1`、`app/node` 与 control 的连接方式（由 #3、#9、#11 实现，多节点见 #19）

## 背景

- 一套 geek_bot 有一个控制面和若干工作节点。第一台节点可以和控制面在同一台机器上；以后加入的节点可能在家庭网络或私有组网里，通常没有公网入站端口。
- 数据只有一个 SQLite 库（[ADR-0008](0008-sqlite-migrations-recovery.md)）。SQLite 同一时刻只允许一个写事务，多个进程同时写要靠锁等待和重试。
- 免费计划的私有仓库没有服务端护栏（[SECURITY](../architecture/SECURITY.md) S-07）。对 GitHub 的写入必须收敛到一个出口，才能逐条过白名单、去重和恢复（S-06）。
- 执行环境运行的是不可信的仓库内容（S-05），不能接触 GitHub 凭据（S-03）。

## 决策

### control：一个进程，独占写入

- control 是一个 Fastify 5 进程，独占 better-sqlite3 的写连接。调度、租约、outbox、publisher、模型中继的记账都在这个进程里：同一个任务不会被两个节点领走，同一条写入不会从两个出口各发一次。
- 同一个库不允许第二个进程写。control 的运维命令（认领码、备份、恢复、master key 轮换）也要守住这一条：计划做法见 [data-model](../services/control/data-model.md)「存储与通用约定」，#3 定稿，并用测试证明。
- control 从不运行 omp，也不执行目标仓库里的任何代码（[ADR-0004](0004-execution-isolation.md)）。

### 节点：只出站

- 只有节点主动发起连接；control 从不连节点；节点不开入站端口。
- 协议是 HTTP/JSON 长轮询，路径前缀 `/api/node/v1`：心跳、领租约（最多挂起 25 秒）、下载任务包、回传事件、回报结果、模型中继。消息逐条编号写在 [节点协议](../services/node/protocol.md)，形状定义在 `@geek-bot/protocol`。
- 公网连接必须用 TLS；私网明文要显式开关，并且只允许私网地址。
- 节点用 bearer 节点令牌认证。令牌由 owner 在后台重新认证后生成（[SECURITY](../architecture/SECURITY.md) S-09），256 位，只显示一次，库里只存 SHA-256；「重置令牌」后旧令牌立即返回 401。节点把它放在自己宿主的密钥文件里（0400）。
- 节点首次心跳后处于 cordon 状态；自检通过、由 owner 或 operator 解除 cordon 后才接任务；把节点的信任等级调到 high 只归 owner（S-09）。

### 租约与失联

- 派发在 control 的一个 SQLite 事务里完成：选任务、写租约和 epoch。
- 事件和结果都带 `lease_id` 与 `epoch`。epoch 不匹配或租约已被收回时返回 409，节点丢弃结果（epoch fencing），同一个任务不会被发布两次。租约还要属于发请求的那个节点，归属的核对规则见 [节点协议](../services/node/protocol.md)。
- 心跳每 10 秒一次；30 秒收不到记为 stale，90 秒记为 offline，不再派新任务。
- 失联两侧对称判定，默认 10 分钟：control 把该节点的租约记为 lost、epoch 加一、把任务排除这个节点后重排（最多 2 次）；节点同样 10 分钟联系不上 control，就自行终止任务、销毁 VM。
- control 计划内重启后，给所有租约重新计时，宽限期内不重排；节点启动时先对账，再清理残留的进程和磁盘。
- 协议版本是整数，control 支持 N 与 N-1；不兼容的节点只收心跳、不派任务；升级顺序先 control 后节点（[RELEASES](../conventions/RELEASES.md)「节点版本」）。

### GitHub 写入只在 control

- 节点、sandbox、VM 都不持有 GitHub 凭据。任务包由 control 从自己的镜像克隆打好，节点不访问 GitHub。
- 结果只进入 control 的「待发布」状态，经 outbox 由 publisher 写出（S-06，逐条白名单见 [write-whitelist](../services/control/write-whitelist.md)）。修复补丁由 control 在自己的镜像克隆里提交并推送。

## 替代方案

- **拆成 api 和 worker 两个进程共用一个 SQLite**：失去单写者保证，要处理跨进程锁和重复派发；control 和库在同一台机器、同一个卷上，拆开的收益有限。
- **WSS 加 Ed25519 挑战签名、任务信封签名、mTLS**：更安全，但 v1 的门槛过高。等出现不可信网络里的节点、或由别人运维的节点时再评估。
- **control 主动连节点**：节点没有入站端口，做不到。
- **节点直接写 GitHub**：凭据要分发到每台节点，出口不止一个，白名单、去重和恢复都无从谈起。
- **用 Kubernetes 之类的编排系统调度节点**：[STACK](../design/STACK.md) 已列为不采用。一个部署者通常只有几台机器，control 按槽位自己调度就够。

## 后果

- control 是单点，并且持有全部密钥。它停机时机器人停摆，但节点上正在跑的任务在失联判定之前不会丢；control 主机被攻陷就等于机器人账号被接管（[SECURITY](../architecture/SECURITY.md) 残余风险）。
- 吞吐上限是一个进程、一个写连接。能撑多少仓库和节点没有验证，由 #8、#19 实测。
- 节点只需要能出站访问 control。control 以后迁到别的机器时，节点只改 control 地址（节点配置 `GEEK_BOT_NODE_CONTROL_URL`）。
- 节点被隔开不到 10 分钟时会继续跑；control 已经重排的任务，旧节点回报的结果会被 409 拒掉，白算一次，但不会重复发布。
- 节点令牌是节点唯一的凭据。它泄露后，持有者能冒充节点领任务、看到任务包里的仓库快照；owner 可以在后台重新认证后重置它。

## 实施状态

本篇只是设计，还没有代码。

- #3：control 进程、数据库，以及运维命令的单写者约束。
- #11：节点 API、节点令牌、心跳、租约与 epoch、失联判定、cordon。
- #9：outbox 与 publisher。
- #14：事件回传。
- #19：多节点分配、掉线接管、滚动升级。

## 重新评估条件

- 出现不可信网络里的节点，或由别人运维的节点：评估任务信封签名和 mTLS；
- 实测一个进程撑不住轮询、心跳和模型中继的负载；
- 需要控制面高可用。

## 所有者结论

接受：所有者 2026-09-26 答复「ADR 全部接受」，记在 #25。按本 ADR 执行（对应 #22 第 8 项）。

- 第 8 项推荐：控制面先部署在第一台节点上，同机再运行一个 node 栈；以后可以把 control 迁到有公网入站、更稳定的服务器，第一台节点只当工作节点。本 ADR 的「节点只出站」让这次迁移只需要改节点的 control 地址。
- 所有者 2026-09-25 回复 #22 时只改了第 4 项，对第 8 项没有提出修改（记在 #22 的第二条评论里）。
