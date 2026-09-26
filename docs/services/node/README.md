# node 服务契约（`app/node`）

> 工作节点代理：只向外连 control 领任务，不开入站端口；管理 issue 通道的无网 sandbox 容器和 PR 通道的一次性 QEMU/KVM VM。

状态：`proposed` · 更新：2026-09-26 · 适用：`app/node`（`@geek-bot/node`）、`tests/node`

## 职责

- 只向外连接 control 的节点 API（HTTP 长轮询 `/api/node/v1`），control 从不主动连节点，节点不开任何入站端口。
- 心跳与主机健康上报；领租约；下载并校验任务包；调度 sandbox 容器；启动和销毁一次性 VM；取消；断线后自我隔离。
- 为 sandbox 和 VM 提供本地任务端点：出网 CONNECT 代理（域名白名单，解析后拒绝私网地址）和本地模型代理（用每任务令牌转发到 control 的模型中继）。
- 事件打码、批量回传和断线缓存；回收没有对应任务的 VM 文件。
- 节点只持有自己的节点令牌，不持有 GitHub 凭据和模型网关密钥；结果只交回 control，从不写 GitHub。

## 现在有什么

#1 只建最小源码，没有任何节点功能（不连 control、不开容器或 VM），只有一份可以单测的配置模块：

| 路径 | 内容 |
|---|---|
| `app/node/package.json` | 包名 `@geek-bot/node`，依赖 `@geek-bot/protocol: workspace:*`；脚本 `typecheck`（`tsc --noEmit`）、`build` |
| `app/node/tsconfig.json` | 继承根 `tsconfig.base.json`，`src/` 编译到 `dist/` |
| `app/node/src/config.ts` | `createNodeConfig(env)`：从传入的环境变量表读 control 地址（`GEEK_BOT_NODE_CONTROL_URL`，只许 http/https，不许带账号密码、查询串或片段，去掉末尾斜杠）、节点名（`GEEK_BOT_NODE_NAME`，小写字母、数字和连字符，1 到 63 个字符）和按执行器分的槽位上限（`GEEK_BOT_NODE_SANDBOX_SLOTS` 默认 1，`GEEK_BOT_NODE_VM_SLOTS` 默认 0：VM 要等 #12 实测通过，由部署者显式打开）。执行器取值从 `@geek-bot/protocol` 的 `EXECUTORS` 导入。纯函数，不读 `process.env`、不读令牌文件；有不合法的值时抛 `NodeConfigError`，一次列出全部问题 |
| `app/node/src/index.ts` | 包入口，只导出上面的配置 |
| `tests/node/config.test.ts` | 读取与默认槽位、地址规范化、非法地址、缺失项、节点名规则、槽位取值 |

新增或删除文件时同步更新本表。

## 计划中的模块与对应 issue

| 模块（计划路径） | 内容 | issue |
|---|---|---|
| `src/{index,config}.ts`、`src/link/`、`src/heartbeat/`、`src/lease/` | 连 control、心跳、领租约、epoch 处理、失联自我隔离 | #11 |
| `src/health/` | CPU 负载、温度、可用内存、磁盘、电源等主机健康采集；超过阈值自动 cordon，恢复带回滞 | #11 |
| `Dockerfile`、`deploy/compose/node.yml` 中的 node 服务 | 非 root、不开端口、不挂 docker.sock；本阶段执行器为 noop | #11 |
| 一次性 VM 可行性实测 | 隔离、冷启动、2 GiB 内存是否够用、依赖缓存、基础镜像在哪构建 | #12 |
| `src/sandbox/`、`src/executors/sandbox/`、`src/redact/`、`src/spool/`、`src/model-proxy/` | 按槽位的 sandbox 容器、事件打码与回传、断线缓存、本地模型代理 | #14 |
| `src/executors/qemu/`、`src/egress-proxy/`、`src/endpoint/`、`src/gc/`、`vm/{build,guest}/`、`Dockerfile.vmimage` | QEMU/KVM 执行器、出网代理、VM 基础镜像配方、泄漏回收 | #17 |
| 多节点：标签、容量、信任等级、排空、滚动升级 | 第二台节点加入后的分配与接管 | #19 |

子文档：[节点协议](protocol.md)（消息表）、[VM 可行性实测](vm-feasibility.md)（#12）；sandbox、health、egress 的说明随 #11、#14、#17 写入。节点运维手册 NODES 由 #11 写入 ops。

## 接口与数据归属（计划中）

- 对 control：只由节点主动发起，路径前缀 `/api/node/v1`，逐条消息（N-01 起）见 [节点协议](protocol.md)。请求带 `Authorization: Bearer <节点令牌>` 和协议版本头；消息形状计划放进 `@geek-bot/protocol`（#11）。
- 节点令牌由 owner 在后台生成，节点从只读挂载的密钥文件读取，路径由 `GEEK_BOT_NODE_TOKEN_FILE` 指定（计划中，#11；密钥的存放与轮换见 [SECURITY](../../architecture/SECURITY.md) 的密钥表）。
- epoch 不匹配、租约已被收回或租约不属于本节点时，control 拒绝请求，节点丢弃结果（细节见 [节点协议](protocol.md)）。
- 对 sandbox：共享卷里的 unix socket。对 VM：QEMU 用户态网络的 guestfwd 转发（只有两条：模型代理和出网代理），任务输入输出走原始盘上的 tar，实时事件走 virtio-serial。
- 节点本地只保存：节点令牌文件、未确认事件的 spool、VM 工作目录；任务结束后清理。节点没有数据库。

## 验证

```bash
pnpm --filter @geek-bot/node typecheck
pnpm exec vitest run tests/node
```

VM 相关测试只能在有 KVM 的机器上手动跑：`pnpm test:vm`（#12，[VM 可行性实测](vm-feasibility.md)）。

## 已知限制

- #1 没有实现任何节点功能；上文的模块和接口都是计划。
- #12 在第一台节点上实测了节点容器里的 KVM、纯 QEMU 引导 cloud 镜像、restrict=on 加 guestfwd 的隔离、出网代理的规则，以及 1 vCPU / 2 GiB 跑本仓库完整校验的内存，结论见 [VM 可行性实测](vm-feasibility.md)。其中 `-sandbox` 的 `elevateprivileges=deny` 与 guestfwd 转发不兼容，怎么处理待所有者决定；omp、恶意夹具、只读缓存盘、passt 还没有实测。
- 执行隔离的安全要求见 [SECURITY](../../architecture/SECURITY.md)。
