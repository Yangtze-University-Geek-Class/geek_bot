# geek_bot

> 可自部署的 GitHub 维护机器人：用一个 GitHub 账号当机器人，审查 PR、受理和跟进 issue、在临时 VM 里修小改动并开 PR；批准与合并始终由人来做。

状态：`current` · 更新：2026-09-26 · 适用：第一次打开本仓库的人

中文 | [English](README.en.md)

## 是什么

geek_bot 是一个可以自己部署的通用产品。部署者在 Web 后台用一个 GitHub 账号（一般是小号）登录，这个账号就成为机器人。它自动发现该账号能访问的所有仓库，按它在每个仓库的实际权限做事：

- 审查 PR，只发 `COMMENT`，不批准；
- 受理和跟进 issue；
- 在一次性 VM 里修小改动并开 PR，收到审查意见后返工。

批准与合并始终由人来做。每个仓库按自己的规范工作，没有规范时用可以在后台修改的默认规范。控制面可以带多台工作节点，节点只向外连接控制面，不开入站端口。

## 组成

| 目录 | 包名 | 做什么 | 契约 |
|---|---|---|---|
| `app/control` | `@geek-bot/control` | 控制面（Fastify 5 + better-sqlite3，计划中）：登录、令牌加密存放、仓库发现、轮询、调度、模型中继；唯一的 SQLite 写入者和唯一的 GitHub 写入者（写入白名单 + outbox）；同源托管后台的静态产物 | [control](docs/services/control/README.md) |
| `app/console` | `@geek-bot/console` | 管理后台（Vue 3.5 + vue-router 4 + Tuffex 0.6.0 + Vite，#4 引入）；不用原生下拉框和复选框，不用 emoji | [console](docs/services/console/README.md) |
| `app/node` | `@geek-bot/node` | 工作节点代理：只向外连 control；管理 issue 通道的无网只读 sandbox 容器和 PR 通道的一次性 QEMU/KVM VM | [node](docs/services/node/README.md) |
| `app/runner` | `@geek-bot/runner` | 在 sandbox 或 VM 里驱动 omp 的单文件程序，只用 Node 标准库 | [runner](docs/services/runner/README.md) |
| `packages/protocol` | `@geek-bot/protocol` | 纯类型加 JSON Schema：节点协议、任务、结果、仓库画像、模型目录、后台 API；任何包都可以导入它，它不导入任何包 | [protocol](docs/services/protocol/README.md) |

## 现状

- **骨架阶段（#1）**：pnpm 工作区、规范文档、门禁脚本、CI 与 issue / PR 模板。
- **后台外壳（#4）**：`app/console` 有了 Tuffex 外壳（侧栏、窄屏抽屉、各种状态）和样板数据模式，`pnpm dev:console` 可以在本机打开；各页面的内容还没做，也还不连控制面。
- **控制面骨架（#3）**：`app/control` 能启动，有 `/healthz`、`/readyz`、版本化迁移（只扩不缩，迁移前自动备份）、审计表、结构化日志与打码、每天的加密备份与恢复校验、运维命令 `backup` / `verify-backup` / `restore --dry-run` 和优雅停机；`pnpm dev:control` 可以在本机运行。登录、GitHub 调用和后台页面还没有。node、runner、protocol 只有最小源码和测试，没有业务功能。
- 架构、安全模型、后台 API、节点协议、写入白名单和默认行为已写成设计文档（[ARCHITECTURE](docs/architecture/ARCHITECTURE.md)、[SECURITY](docs/architecture/SECURITY.md)、[API](docs/architecture/API.md)），决策记为 ADR-0002 到 ADR-0009（所有者 2026-09-26 全部接受，`accepted`）；设计文档还没有对应代码，状态是 `proposed`。
- 功能按 #22 的路线图逐个 issue 推进：控制面（#3）、后台外壳（#4）、机器人账号登录（#5）、仓库发现（#6）、预发布栈与部署（#7）、节点（#11）；第一个能看到效果的里程碑是 PR 收到机器人的只评论审查（#15）；正式上线是 #20，达到可公开状态是 #21。
- **部署**：部署文件与部署文档随 #7 加入，现在仓库里没有可部署的东西。

## 参与开发

1. 先读 [AGENTS.md](AGENTS.md)，按 §0 的顺序读完规范再动手。
2. 准备 Node 22（`.nvmrc`，≥ 22.13）和 pnpm 9.15.9，详见 [LOCAL-DEV](docs/ops/LOCAL-DEV.md)。
3. 安装、验证、启用 Git 钩子：

   ```bash
   pnpm install --frozen-lockfile
   pnpm verify          # 运行时、包边界、文档、执行记录、密钥、公开安全、类型检查 → 单测 → 构建
   pnpm hooks:enable    # pre-push 核对分支不变量与发布 tag 规则
   pnpm dev:console     # 本机打开后台（样板数据模式，数据全部虚构）
   pnpm dev:control     # 本机运行控制面（本机用的一次性密钥，库在 ./data/）
   pnpm test:e2e        # 后台的浏览器回归；第一次先 pnpm exec playwright install chromium
   ```

4. 一件事一个 issue、一个 `task/<issue>/<slug>` 分支、一个 worktree、一个 PR 回 `stage`：见 [CONTRIBUTING](docs/conventions/CONTRIBUTING.md) 与 [BRANCHING](docs/conventions/BRANCHING.md)。

类型检查、构建成功、mock 预览、浏览器验证、线上验收是不同的证据，不能互相替代（[TESTING](docs/conventions/TESTING.md)）。

## 文档

- [AGENTS.md](AGENTS.md)：唯一的 agent 入口与硬门禁。
- [docs/README.md](docs/README.md)：文档总入口，目录 ↔ 服务契约 ↔ 规范的地图。
- [架构决策](docs/decisions/README.md)：为什么独立成通用产品（[ADR-0001](docs/decisions/0001-standalone-product.md)）等。

## 许可证

尚未选定。公开前由所有者选定许可证、补上 `SECURITY.md`，并满足 [ADR-0001](docs/decisions/0001-standalone-product.md) 列出的其它公开前条件（仓库文件、提交历史，以及 GitHub 上的 issue、PR、评论等内容都检查干净）。
