# architecture/

> 长期有效的系统设计：架构、安全不变量、后台 API 契约。改动系统边界、信任边界、接口或数据之前先读这里。

状态：`proposed` · 更新：2026-09-26 · 适用：全部 `app/*`、`packages/protocol` 与部署文件（由 #3–#21 实现）

| 文件 | 内容 | 什么时候读 |
|---|---|---|
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | 定位、拓扑、组件、身份与登录、仓库发现与权限、规则来源、节点协议原则、调度、执行与隔离、GitHub 写入、模型、管理后台、数据、部署、残余风险；每节注明涉及的 ADR 和实现 issue | 改组件职责、数据流、调度、执行隔离、写入出口或部署拓扑之前 |
| [`SECURITY.md`](./SECURITY.md) | 安全不变量 S-01 起（需要重新认证的操作以 S-09 为唯一清单，出网拒绝的地址段与 GitHub 域名以 S-14 为准）、信任边界、密钥表、残余风险 | 涉及 GitHub 令牌、模型密钥、写入白名单、sandbox 或 VM 隔离、不可信输入之前 |
| [`API.md`](./API.md) | 后台 API（`/api/v1/*`、健康检查、版本接口）的约定与端点表 A-01 起 | 改 control 的后台接口或 console 的调用之前 |

节点使用的 `/api/node/v1/*` 不在这里，见 [节点协议](../services/node/protocol.md)；写入白名单、默认行为与配置项、数据表分别见 control 服务契约下的 [write-whitelist](../services/control/write-whitelist.md)、[behavior](../services/control/behavior.md)、[data-model](../services/control/data-model.md)；取舍的理由见 [decisions](../decisions/README.md)（ADR-0002 至 ADR-0009）。

这几篇都是 `proposed`：写的是设计要求，还没有代码实现。某一部分实现落地后，把对应段落改为 `current`；从那以后如果文档与代码不符，在同一次改动里修正，不留到以后。`proposed` 的内容是实现目标和审查时不得放宽的基线，不能拿来证明功能已经实现。各包的职责与计划见 [services](../services/README.md)。
