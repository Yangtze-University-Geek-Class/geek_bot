# architecture/

> 长期有效的系统设计：架构、安全不变量、后台 API 契约。改动系统边界、信任边界、接口或数据之前先读这里。

状态：`current` · 更新：2026-10-03 · 适用：全部 `app/*`、`packages/protocol` 与部署文件

| 文件 | 内容 | 什么时候读 |
|---|---|---|
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | #34 共享平台的职责、数据流、身份、调度、执行隔离与验证边界 | 改组件职责、数据流、调度、执行隔离、写入出口或部署拓扑之前 |
| [`SECURITY.md`](./SECURITY.md) | 安全不变量 S-01 起（需要重新认证的操作以 S-09 为唯一清单，出网拒绝的地址段与 GitHub 域名以 S-14 为准）、信任边界、密钥表、残余风险 | 涉及 GitHub 令牌、模型密钥、写入白名单、sandbox 或 VM 隔离、不可信输入之前 |
| [`API.md`](./API.md) | 当前后台身份、连接、项目、需求、机器、任务、模型池和事件端点 | 改 control 的后台接口或 console 的调用之前 |

节点使用的 `/api/node/v1/*` 见 [节点协议](../services/node/protocol.md)。control 的写入动作、默认行为与数据表分别见 [write-whitelist](../services/control/write-whitelist.md)、[behavior](../services/control/behavior.md) 和 [data-model](../services/control/data-model.md)；取舍见 [decisions](../decisions/README.md)，共享平台范围见 ADR-0012。

ARCHITECTURE 与 API 描述 current 源码，安全模型保留 proposed 的强制审查基线和尚未验收要求。各文档的状态与验证说明独立读取，不能把设计要求或编译成功当作运行证明。包职责和实际检查见 [services](../services/README.md)。
