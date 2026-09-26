# services/

> 与 `app/`、`packages/` 一一对应的服务契约：每个包一份 README（职责、源码地图、接口、数据归属、验证、限制）。

状态：`proposed` · 更新：2026-09-25 · 适用：`app/*`、`packages/protocol`

#1 只建了五个包的最小源码和测试，还没有任何业务功能，所以五份契约都是 `proposed`：写的是职责和计划，「现在有什么」一节写的是仓库里真实存在的文件。每个包的功能落地时，由对应 issue 把契约改成 `current`。

**新增包 = 新增 `app/<name>` 或 `packages/<name>` + 新增 `docs/services/<name>/README.md`**，两处缺一视为未完成；`pnpm check:docs` 会检查。模块细节放同目录子文档（例如 control 的写入白名单、node 的节点协议），子文档由对应 issue 写入。

| 包 | 源码 | 包名 | 职责 | 契约 | 镜像（计划中） |
|---|---|---|---|---|---|
| control | `app/control/` | `@geek-bot/control` | 控制面：唯一的 SQLite 写入者、唯一的 GitHub 写入者；登录、令牌、发现、轮询、调度、模型中继；同源托管 console | [control](control/README.md) | `geek-bot-control`（#3 建镜像；打进 console 产物随 #7） |
| console | `app/console/` | `@geek-bot/console` | 管理后台：Vue 3.5 + Tuffex 0.6.0 | [console](console/README.md) | 随 `geek-bot-control` 发布 |
| node | `app/node/` | `@geek-bot/node` | 工作节点代理：只向外连 control，管理 sandbox 容器和一次性 VM | [node](node/README.md) | `geek-bot-node`、`geek-bot-vmimage`（#11、#17） |
| runner | `app/runner/` | `@geek-bot/runner` | 在 sandbox 或 VM 里驱动 omp 的单文件程序，只用 Node 标准库 | [runner](runner/README.md) | 打进 `geek-bot-node` 与 VM 基础镜像 |
| protocol | `packages/protocol/` | `@geek-bot/protocol` | 纯类型加 JSON Schema，是各包之间唯一的共享契约 | [protocol](protocol/README.md) | 无，构建时被各包引用 |

## 依赖方向

- 五个包互不导入实现代码。
- 任何包都可以导入 `@geek-bot/protocol`；protocol 不导入任何 app。
- runner 程序（`app/runner/src`）只用 Node 标准库，除了对 `@geek-bot/protocol` 的 type 导入，不导入任何 npm 包，也不引用 `src/` 以外的文件。
- 这些规则由 `pnpm check:boundaries` 检查，细则见 [模块化开发规范](../conventions/MODULAR-DEVELOPMENT.md)。

包与包之间的运行时交互只有三种：

- console 调 control 的后台 API（`/api/v1/*`）；
- node 调 control 的节点 API（`/api/node/v1/*`）；
- runner 只经 node 提供的本地通道交互：拿任务包、回传 JSONL 事件和结构化结果，模型请求也经 node 的本地模型代理转发。sandbox 走共享卷里的 unix socket；VM 的任务输入输出走原始盘上的 tar，实时事件走 virtio-serial，模型请求走到本地模型代理的 guestfwd。runner 不直接连 control。

后台 API 的 DTO、节点协议、TaskSpec 和任务结果（review.v1、triage.v1、patch.v1）的形状都定义在 protocol 里。整体设计见 [ARCHITECTURE](../architecture/ARCHITECTURE.md)，安全不变量见 [SECURITY](../architecture/SECURITY.md)。

## 验证

```bash
pnpm typecheck                      # 五个包各自 tsc --noEmit，再检查 tests/** 与 vitest.config.ts
pnpm exec vitest run tests/<包>      # 单个包的测试
pnpm check:docs                     # 每个包都有契约、相对链接有效
pnpm check:boundaries               # 包之间的导入方向
```

运行环境与部署入口由 #7 写入 ops 文档；本地开发见 [LOCAL-DEV](../ops/LOCAL-DEV.md)。
