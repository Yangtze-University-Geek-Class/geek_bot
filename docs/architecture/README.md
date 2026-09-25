# architecture/

> 长期有效的系统设计：架构、安全不变量、API 契约。改动系统边界、信任边界或数据之前先读这里。

状态：`proposed` · 更新：2026-09-25 · 适用：全部 `app/*` 与 `packages/protocol`

| 文件 | 什么时候读 |
|---|---|
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | 改组件职责、数据流、节点协议、调度、执行隔离、写入出口或部署拓扑之前 |
| [`SECURITY.md`](./SECURITY.md) | 涉及 GitHub 令牌、模型密钥、写入白名单、sandbox 或 VM 隔离、不可信输入之前 |

API.md（后台 API 与节点 API 的契约）由 #2、#3 写入。

这几篇现在都是 `proposed`：写的是设计要求，还没有代码实现，由 #2 定稿。实现落地后，对应段落改为 `current`；从那以后如果文档与代码不符，在同一次改动里修正，不留到以后。各包的职责与计划见 [services](../services/README.md)。
