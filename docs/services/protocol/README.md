# protocol 契约包（`packages/protocol`）

> 纯类型加少量冻结常量和 JSON Schema：节点协议、执行任务与任务包、任务结果、共享平台的记录与后台 DTO；各包之间唯一的共享契约。

状态：`current` · 更新：2026-10-03 · 适用：`packages/protocol`（`@geek-bot/protocol`）、`tests/protocol`（由 #34 实现）

`current` 只表示本文与 #34 的源码一致。类型对得上不等于跨包行为已经验收，见「验证状态」。

## 职责

- 定义包与包之间传递的消息形状，一处定义、两端共用，避免各自手抄一份后漂移。
- 只放类型、少量冻结的常量和 JSON Schema 常量，不放业务逻辑，不做 I/O，不依赖 Node 或浏览器运行时。
- 任何 app 都可以导入它，它不导入任何 app。runner 只能对它做 type 导入。

## 源码地图

| 路径 | 内容 |
|---|---|
| `packages/protocol/package.json` | `@geek-bot/protocol`，没有依赖；类型入口和 `development` 条件指向 `src/index.ts`，默认运行时入口是 `dist/index.js`；脚本 `typecheck`、`build` |
| `packages/protocol/tsconfig.json` | 继承根 `tsconfig.base.json`，编译到 `dist/` 并输出声明文件；不加载 Node 类型 |
| `src/index.ts` | 节点协议版本、任务类型、通道与执行器的取值和映射、PR 通道默认优先级、后台 API 的共用形状；末尾 `export * from "./shared.js"` |
| `src/shared.ts` | 共享平台的记录与 DTO、节点协议的请求与响应、执行任务与任务包、四个 JSON Schema 常量 |
| `tests/protocol/protocol.test.ts` | `src/index.ts` 常量的取值、映射完整、优先级顺序、运行时不可修改 |

新增或删除文件时同步更新本表。

## 导出内容

### `src/index.ts`

- `NODE_PROTOCOL_VERSION = 1`。control 支持的范围由 control 自己按它算出（[节点协议](../node/protocol.md)「协议版本」）。
- `TASK_KINDS`（review、triage、followup、fix、rework）、`CHANNELS`（issue、pr）、`EXECUTORS`（sandbox、vm）及对应类型；映射 `TASK_CHANNEL`、`CHANNEL_EXECUTOR`；`PR_CHANNEL_PRIORITY`。
- 后台 API 的共用形状：`ApiErrorBody`、`ApiList<T>`、`AdminRole`、`MeResponse`、`ReleaseInfo`、`StreamTopic`。端点的请求与响应以 control 路由的 `contracts.ts` 为准。

### `src/shared.ts`

| 分组 | 导出 |
|---|---|
| 连接与项目 | `ConnectionProvider`、`CodeProvider`、`WriteMode`、`Capability`、`JsonValue`、`ConnectionRecord`、`ProjectRecord`、`ItemRecord`、`ConnectionCredentials`（只用于配置请求，不进入任何列表、任务包或审计）、`DiscoverResponse`、`SyncResponse`、`ProjectSyncResponse` |
| 需求 | `DemandStatus`、`DemandRecord` |
| 机器 | `ResourceBudget`、`ExecutorSlots`、`MachineStatus`、`MachineRecord`、`MachineSecretResponse`（一次性节点令牌） |
| 任务 | `TaskStatus`、`TaskFinding`、`TaskResult`、`TaskRecord`、`TaskEvent`、`ModelPoolEntry` |
| 节点协议 | `MachineHeartbeat`、`HeartbeatReply`、`LeaseRequest`、`LeaseFence`、`ExecutionTask`、`TaskBundle`、`BundleFile` |
| 后台 | `OverviewResponse`、`PlatformAdministrator`、`AuthStateResponse`、`DeviceFlowPurpose`、`DeviceFlowStartRequest`、`DeviceFlowStartResponse`、`DeviceFlowPollResponse` |
| 模型 | `CatalogModel`、`ModelPool`、`ModelPoolsResponse` |
| JSON Schema | `RESOURCE_BUDGET_SCHEMA`、`EXECUTOR_SLOTS_SCHEMA`、`LEASE_FENCE_SCHEMA`、`TASK_RESULT_SCHEMA`；对象一律拒绝未知字段，数值和长度都有上限 |

节点协议各字段的含义、取值和错误码只在 [节点协议](../node/protocol.md) 里写；模型目录、模型池与预算的规则见 [control 服务契约](../control/README.md)。

## 谁在用

- control：运行时导入 `NODE_PROTOCOL_VERSION`、`TASK_KINDS` 和四个 JSON Schema 常量，路由的 `contracts.ts` 用 `structuredClone` 复制后嵌进自己的 schema；其余是 type 导入。
- node：运行时导入 `NODE_PROTOCOL_VERSION`、`EXECUTORS`；节点协议的请求、响应、`ExecutionTask`、`TaskEvent`、`TaskResult` 是 type 导入。
- runner：只做 type 导入（`Executor`、`TaskKind`、`ModelPoolEntry`、`TaskResult`、`TaskFinding`、`TaskBundle`、`BundleFile`、`TaskEvent`、`JsonValue`）。
- console：只做 type 导入，用于后台 API 与 SSE。

## 契约规则

- 契约变更要在同一次改动里改两端，并按 [DOCUMENTATION](../../conventions/DOCUMENTATION.md)「同步规则」更新本文、[节点协议](../node/protocol.md) 和 [node 服务契约](../node/README.md)。
- 改请求字段、删字段或改字段含义要提升 `NODE_PROTOCOL_VERSION`；给响应加字段不提升。
- protocol 不拥有任何运行时数据。

## 验证

```bash
pnpm --filter @geek-bot/protocol typecheck
pnpm exec vitest run tests/protocol
```

`pnpm check:boundaries` 检查 protocol 没有导入任何 app。

## 验证状态

#34 已执行 Core HTTP 回归 8 项和真实 HTTP/SQLite 烟雾，包括实际 ControlClient 的领取、续租、取包、事件与结果往返（见 [节点协议](../node/protocol.md)）。`tests/protocol` 仍只覆盖常量，没有完整的跨包自动契约矩阵；不能用类型检查或主路径 smoke 代替边界覆盖。

## 已知限制

- `TASK_CHANNEL`、`CHANNEL_EXECUTOR`、`CHANNELS`、`PR_CHANNEL_PRIORITY` 目前没有 app 在运行时使用。control 派发按自己的规则：fix、rework 只能派到 VM，review、triage、followup 由派发时选择执行器，优先级用 control 的 `KIND_PRIORITY`。所以 `CHANNEL_EXECUTOR` 的「pr 通道 → vm」与实际派发不一致，读代码时以 control 为准。
- `MachineHeartbeat.health` 是开放的 `JsonValue` 对象；control 认的健康字段和自检形状由 control 的 `platform/health.ts` 解析，没有放进本包的类型。
- 本包只有四个 JSON Schema 常量；其余请求的 schema 写在 control 的 `contracts.ts` 里，两边一致靠审查和 control 的 HTTP 测试，没有自动比对。
