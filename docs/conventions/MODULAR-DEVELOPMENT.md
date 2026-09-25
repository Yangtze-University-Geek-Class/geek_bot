# 模块化开发规范

> 五个工作区包职责清楚、依赖单向、只经 `@geek-bot/protocol` 共享契约；`app/`、`packages/` 与 `docs/services/` 严格对齐，不为目录形式制造部署复杂度。

状态：`current` · 更新：2026-09-25 · 适用：`app/control`、`app/console`、`app/node`、`app/runner`、`packages/protocol` 与 `scripts/check-boundaries.mjs`

## 当前边界

工作区由 `pnpm-workspace.yaml` 声明五个包。本仓库骨架（#1）里每个包只有最小源码；下面的职责是各包的契约，业务代码由后续 issue 加入，标「计划中」的内部结构以对应 issue 为准。

| 目录 | 包名 | 职责 | 契约 |
|---|---|---|---|
| `app/control` | `@geek-bot/control` | 控制面。Fastify 5 + better-sqlite3（计划中，#3）。唯一的 SQLite 写入者、唯一的 GitHub 写入者（publisher 白名单 + outbox）；负责登录、令牌加密存放、仓库发现、轮询、调度、模型中继；同源托管 console 的静态产物 | [control](../services/control/README.md) |
| `app/console` | `@geek-bot/console` | 管理后台。Vue 3.5 + vue-router 4 + @talex-touch/tuffex 0.6.0 + Vite（计划中，#4）。不用原生下拉框和复选框，不用 emoji | [console](../services/console/README.md) |
| `app/node` | `@geek-bot/node` | 工作节点代理。只向外连 control（HTTP 长轮询 `/api/node/v1`），不开入站端口；管理 issue 通道的无网只读 sandbox 容器和 PR 通道的一次性 QEMU/KVM VM（计划中，#11、#14、#17） | [node](../services/node/README.md) |
| `app/runner` | `@geek-bot/runner` | 在 sandbox 或 VM 里驱动 omp 的单文件程序，只用 Node 标准库（计划中，#14） | [runner](../services/runner/README.md) |
| `packages/protocol` | `@geek-bot/protocol` | 纯类型加 JSON Schema：节点协议、TaskSpec、结果、RepoProfile、catalog 文件契约、console API DTO | [protocol](../services/protocol/README.md) |

control 内部的计划分层（#3 起，细节写进 control 契约）：`src/index.ts` 只负责监听，`src/app.ts` 负责组装；`src/routes/<module>/index.ts` 是路由模块入口、`contracts.ts` 是输入协议源，路由只做 HTTP 映射、授权与调用；GitHub 读取客户端、调度、publisher（唯一写 GitHub 的出口）、数据库与密钥各自成层。多处写操作共用的规则（幂等、去重、限速、熔断）放在 publisher 与具名服务里，不在每个 handler 复制。

跨包只通过 `@geek-bot/protocol` 的类型与 JSON Schema，以及显式的 HTTP/JSON 契约连接：console 调 control 的后台接口，node 调 control 的节点接口，runner 只经 node 提供的本地通道通信。禁止共用可变 store，禁止直接读取别的包的数据库或内部文件。

## 目录与文档对齐（硬规则）

**新增包 = 新增 `app/<name>` 或 `packages/<name>` + 新增 `docs/services/<name>/README.md`**，两处缺一即视为未完成（`pnpm check:docs` 会查）；同时要在 `pnpm-workspace.yaml` 登记、在 `scripts/check-boundaries.mjs` 里给它划定所属边界。模块细节放同目录子文档。[docs/README.md](../README.md) 是 app ↔ docs ↔ 规范的三列地图。

## 允许的依赖方向

```text
console ─┐
control ─┼─> @geek-bot/protocol   （protocol 不导入任何 app）
node    ─┤
runner  ─┘   runner 只许 type 导入 protocol；运行时只用 node: 内置模块

control 内部（计划中）：index -> app -> routes/<module> -> 服务 -> publisher / 调度 / db / GitHub 读取客户端
```

规则（与 `scripts/check-boundaries.mjs` 一致）：

1. 五个包互不导入实现：`app/control`、`app/console`、`app/node`、`app/runner` 任何一个都不得导入另一个的文件（包名导入或相对路径都算）。
2. 每个 app 都可以导入 `@geek-bot/protocol`（或指向 `packages/protocol` 的相对路径）；这是跨包共享的唯一入口。
3. `packages/protocol` 不导入任何 app。
4. `app/runner/src`（runner 程序本身，#14 起打成单文件 `dist/runner.mjs`）不许导入任何 npm 包，只用 Node 标准库；唯一例外是对 `@geek-bot/protocol` 的 type 导入。`app/runner` 下 `src/` 以外的文件（例如 #14 的打包配置）不打进 runner 程序，不受这一条约束，但仍受规则 1。`src/` 里的文件也不能引用 `app/runner` 里 `src/` 以外的文件（不论 `.ts`、`.mjs`、`.js`，还是副作用导入），`check-boundaries` 会拦下。
5. `app/`、`packages/` 下出现没在 `check-boundaries` 里登记的目录时失败：新增包要先划定边界。
6. 每个包都要在 `pnpm-workspace.yaml` 里逐行列出（不用通配），`package.json` 里都要有非空的 `typecheck` 与 `build` 脚本：根脚本用 `pnpm -r --if-present run` 调用它们，缺了会被静默跳过。
7. 计划中（#3、#9）：control 的路由模块互不导入；底层（db、GitHub 读取客户端、密钥）不反向导入路由或应用组装；publisher 以外不得调用 GitHub 写接口；令牌解密接口只许 publisher 与 GitHub 读取层（读取客户端，计划路径 `src/github/client.ts`，#6）调用（[SECURITY](../architecture/SECURITY.md) S-01）。这些规则随对应 issue 加进 `check-boundaries`，加入前由审查逐项核对（见 [CODE-REVIEW](CODE-REVIEW.md) 第 11、12 项）。

检查由 TypeScript AST 解析静态 import、动态 import、re-export、import-type 与 `require`；Vue 单文件组件只解析 `<script>` 块；解析 `.js` 指向 `.ts` 以及 tsconfig 声明的路径别名；按解析后的文件路径判断所属包，不以导入名称判断。本地导入（相对路径、已声明别名、`@geek-bot/` 作用域）解析失败不是忽略理由，检查必须失败；非字面量的动态导入无法静态判定，同样失败；`app/`、`packages/` 下出现没在 `check-boundaries` 里登记边界的目录也失败。不允许靠新增别名绕过检查。运行时 HTTP 调用、跨包 URL 和 Schema 的语义还需测试，不宣称 import 检查覆盖它们。根 TypeScript 检查不自动证明 Vue 源码正确（console 另跑 `vue-tsc`，#4 起）。

## 数据与事务

- SQLite 只属于 control：库文件放在 control 栈的命名卷里，不跨环境共享；只有 control 进程写入（单写者）。console、node、runner 都不打开数据库，只经 control 的接口读写。
- 迁移用版本化 SQL 文件，只扩不缩（加表、加列、回填），保证上一版镜像仍能读库；迁移前自动备份，库版本比代码新时拒绝启动（计划中，#3）。
- SQL 值一律参数化，动态列名只来自代码里的允许列表。
- 一次本地业务状态变化及派生计数处于同一事务。外部请求（GitHub、模型网关）不能放进长事务。
- 对 GitHub 的写入先在事务里记下意图（outbox，带去重键），提交后再发送；结果未知时记为 unknown，发送前先复核 GitHub 当前状态，不能盲目重试；重试不得产生第二条写入（计划中，#9）。
- node 侧的事件暂存（spool）只是转发缓冲，不是业务数据的来源；任务结果以 control 收到并落库的为准。

## 新增功能的固定步骤

1. 明确属于哪个包、数据归谁、文档落点（`docs/services/<name>/`）。
2. 先定义请求/响应、错误和权限；跨包的消息与 DTO 先写进 `packages/protocol`。
3. 加入对应包的路由模块或 feature；对 GitHub 的写入只经 publisher，不绕过白名单。
4. 复用既有服务，不跨模块取数据库实现。
5. 补真实路由测试或协议契约测试（见 [TESTING](TESTING.md)）。
6. 更新服务契约、API 文档（#2、#3 写入）与 [LOCAL-DEV](../ops/LOCAL-DEV.md)。
7. 通过根 `pnpm verify`。

## 拆分尺度

按职责拆，不按任意行数拆。新增抽象必须至少解决一个真实重复、生命周期问题或测试隔离问题；公用文件不自动承接所有「以后可能复用」的代码。

现有五个包按运行位置与信任边界划分：control 持有令牌和网关密钥；console 跑在浏览器里；node 跑在可能是另一台主机的节点上；runner 跑在不可信的 sandbox 或 VM 里；protocol 只有类型和 Schema。只有出现新的运行位置、安全隔离、部署周期或扩缩容需求时，才评估新增包或新服务；不为目录审美增加服务或数据库。背景见 [ADR-0001](../decisions/0001-standalone-product.md)；单进程单写者与节点只出站的决策 ADR-0003 由 #2 写入。
