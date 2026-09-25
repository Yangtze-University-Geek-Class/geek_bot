# protocol 契约包（`packages/protocol`）

> 纯类型加 JSON Schema：节点协议、TaskSpec、任务结果、RepoProfile、catalog 文件契约、console API DTO；各包之间唯一的共享契约。

状态：`proposed` · 更新：2026-09-25 · 适用：`packages/protocol`（`@geek-bot/protocol`）、`tests/protocol`

## 职责

- 定义包与包之间传递的所有消息形状，一处定义、两端共用，避免各自手抄一份后漂移。
- 只放类型、JSON Schema 和少量冻结的常量（取值表、映射、默认顺序），不放业务逻辑，不做 I/O。
- 任何 app 都可以导入它；它不导入任何 app。runner 只能对它做 type 导入。

## 现在有什么

#1 只建最小源码：几个类型和冻结的常量，还没有 JSON Schema：

| 路径 | 内容 |
|---|---|
| `packages/protocol/package.json` | 包名 `@geek-bot/protocol`，没有任何依赖；`exports` 的类型入口指向 `src/index.ts`，运行时入口是 `dist/index.js`；脚本 `typecheck`（`tsc --noEmit`）、`build` |
| `packages/protocol/tsconfig.json` | 继承根 `tsconfig.base.json`，`src/` 编译到 `dist/` 并输出声明文件；不加载 Node 类型 |
| `packages/protocol/src/index.ts` | 节点协议版本 `NODE_PROTOCOL_VERSION = 1`；任务类型 `TASK_KINDS`（review、triage、followup、fix、rework）、通道 `CHANNELS`（issue、pr）、执行器 `EXECUTORS`（sandbox、vm）及对应类型；映射 `TASK_CHANNEL`（triage、followup 走 issue 通道，其余走 pr 通道）与 `CHANNEL_EXECUTOR`（issue → sandbox，pr → vm）；PR 通道默认优先级 `PR_CHANNEL_PRIORITY`（审查别人的 PR > 返工自己的 PR > 修分给机器人的 issue > 修自己决定修的 issue） |
| `tests/protocol/protocol.test.ts` | 取值固定、映射完整、优先级顺序、常量在运行时不可修改 |

目前 node 在运行时导入 `EXECUTORS`，runner 只 type 导入 `Channel`，control 与 console 还没有导入。新增或删除文件时同步更新本表。

## 计划中的契约与对应 issue

| 契约 | 内容 | issue |
|---|---|---|
| 节点协议 | heartbeat、lease、bundle、events、result 的请求与响应；协议版本整数，control 支持 N 与 N-1 | #11（消息表由 #2 写入） |
| TaskSpec | task_id、lease_id、epoch、kind、执行器、资源、任务包摘要、omp 参数、模型列表、出网白名单、结果 schema、租约时长 | #11 |
| catalog 文件契约 | 部署者提供的只读模型目录：provider、models、每个模型的 efforts；没有 efforts 的模型只提供 off 档位 | #13 |
| RepoProfile 与 `.github/geek-bot.yml` | 每仓库规则画像的字段、来源与优先级 | #10 |
| 任务结果 | review.v1、triage.v1、patch.v1 | #14、#15、#16、#18 |
| console API DTO | `/api/v1/*` 的请求与响应形状 | #4 起，随各页面的 issue 增加 |

## 接口与数据归属（计划中）

- 导出方式：TypeScript 类型、JSON Schema 文件和少量常量。类型用 `import type` 导入；常量和 schema 可以在运行时导入，runner 除外（只能 type 导入）。
- 契约变更要同时改两端，并有契约测试证明两端一致（节点协议的一致性测试由 #11 加入）。
- protocol 不拥有任何运行时数据。

## 验证

```bash
pnpm --filter @geek-bot/protocol typecheck
pnpm exec vitest run tests/protocol
```

`pnpm check:boundaries` 检查 protocol 没有导入任何 app。

## 已知限制

- #1 只建了最小的类型与常量；上文的契约都是计划。
- JSON Schema 的校验方式（是否引入校验库）没有定，由第一个需要运行时校验的 issue 决定并写回本文。
