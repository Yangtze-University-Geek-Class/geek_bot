# services/

> 与 `app/`、`packages/` 一一对应的服务契约：每个包一份 README（职责、源码地图、接口、数据归属、验证、限制）。

状态：`current` · 更新：2026-10-03 · 适用：`app/*`、`packages/protocol`

#3、#4 和 #34 已加入控制面、真实后台与共享执行源码。五份服务 README 为 current，分别记录源码事实、实际验证和未验证边界；current 不等于真实外部账号、隔离镜像、KVM 或线上验收通过。

**新增包 = 新增 `app/<name>` 或 `packages/<name>` + 新增 `docs/services/<name>/README.md`**，两处缺一视为未完成；`pnpm check:docs` 会检查。模块细节放同目录子文档（例如 control 的写入白名单、node 的节点协议），子文档由对应 issue 写入。

| 包 | 源码 | 包名 | 职责 | 契约 | 镜像定义与边界 |
|---|---|---|---|---|---|
| control | `app/control/` | `@geek-bot/control` | 唯一 SQLite 写者、多渠道 publisher、身份、项目、需求、任务、租约、模型中继和同源后台 | [control](control/README.md) | `app/control/Dockerfile`；console 镜像集成与发布随 #7 |
| console | `app/console/` | `@geek-bot/console` | Vue 3.5 + Tuffex 0.6.0 的共享平台后台 | [console](console/README.md) | 由 control 同源托管产物 |
| node | `app/node/` | `@geek-bot/node` | 出站节点、资源与自检、磁盘 spool、sandbox 槽位、一次性 VM | [node](node/README.md) | `app/node/Dockerfile` 的 node 与 sandbox 目标；镜像构建及 KVM 未验收 |
| runner | `app/runner/` | `@geek-bot/runner` | Node 标准库单文件 omp 驱动、隔离工具和结果/补丁 | [runner](runner/README.md) | 放进 sandbox 镜像与 VM 工具盘 |
| protocol | `packages/protocol/` | `@geek-bot/protocol` | 纯类型、常量和 JSON Schema，唯一跨包契约 | [protocol](protocol/README.md) | 无 |

## 依赖方向

- 五个包互不导入实现代码。
- 任何包都可以导入 `@geek-bot/protocol`；protocol 不导入任何 app。
- runner 程序（`app/runner/src`）只用 Node 标准库，除了对 `@geek-bot/protocol` 的 type 导入，不导入任何 npm 包，也不引用 `src/` 以外的文件。
- 这些规则由 `pnpm check:boundaries` 检查，细则见 [模块化开发规范](../conventions/MODULAR-DEVELOPMENT.md)。

包与包之间的运行时交互只有三种：

- console 调 control 的后台 API（`/api/v1/*`）；
- node 调 control 的节点 API（`/api/node/v1/*`）；
- runner 只经 node 提供的本地通道交互：拿任务包、回传 JSONL 事件和结构化结果，模型请求也经 node 的本地模型代理转发。sandbox 走共享卷里的 unix socket；VM 的任务输入输出走原始盘上的 tar，实时事件走 virtio-serial，模型请求走到本地模型代理的 guestfwd。runner 不直接连 control。

后台 DTO、节点协议、ExecutionTask、TaskBundle 和 TaskResult 定义在 protocol。端点 schema 来自 control 的 contracts.ts。整体实现见 [ARCHITECTURE](../architecture/ARCHITECTURE.md)，未放宽的安全要求见 [SECURITY](../architecture/SECURITY.md)。

## 验证

```bash
pnpm typecheck                      # console 用 vue-tsc，其余包和测试用 tsc
pnpm exec vitest run tests/<包>      # 单个包的测试
pnpm check:docs                     # 每个包都有契约、相对链接有效
pnpm check:boundaries               # 包之间的导入方向
```

运行环境与部署入口由 #7 写入 ops 文档；本地开发见 [LOCAL-DEV](../ops/LOCAL-DEV.md)。
