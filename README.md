# geek_bot

> 可自部署的跨平台项目维护与需求执行系统：接入 GitHub、GitLab 和消息渠道，共用项目、需求、任务与机器池；批准与合并始终由人来做。

状态：`current` · 更新：2026-10-03 · 适用：第一次打开本仓库的人

中文 | [English](README.en.md)

## 是什么

geek_bot 在一个实例里集中管理项目、需求和机器。管理员配置渠道账号、项目权限与执行资源，控制面按权限、标签、信任等级、槽位和 CPU / 内存预算分配任务。不划分租户、团队空间或用户专属机器池。

- GitHub 和 GitLab 适配器发现已授权账号参与的项目，读取 issue、PR 和 MR。项目的逐类开关决定是否审查、受理、修复或返工。
- 飞书事件回调和签名 Webhook 接收日常需求。需求必须关联项目才能派发，进展与结果通过受控出口回传。
- 无网、只读 sandbox 执行只读任务；一次性 QEMU/KVM VM 执行需要修改文件或运行仓库代码的任务。机器只向控制面发起连接，不开放外部入站端口。

后台管理员身份与渠道账号分离。管理员登录沿用 GitHub device flow，只取数字身份并撤销临时令牌；连接账号独立绑定，凭据只在控制面加密保存。安全限制不会被仓库文本或模型输出放宽。机器人不批准、不合并，不推主干或 tag。

## 组成

| 目录 | 包名 | 做什么 | 契约 |
|---|---|---|---|
| `app/control` | `@geek-bot/control` | Fastify 5 + SQLite 单写者；认证、渠道读取、需求、任务与资源调度、租约、模型中继、publisher 持久 outbox；同源托管真实后台 | [control](docs/services/control/README.md) |
| `app/console` | `@geek-bot/console` | Vue 3.5 + Tuffex 0.6.0；项目、需求、机器、任务、渠道、模型池和管理员页面 | [console](docs/services/console/README.md) |
| `app/node` | `@geek-bot/node` | 出站工作节点；自检、资源上限、sandbox / VM 执行、模型代理、磁盘 spool 与取消回收 | [node](docs/services/node/README.md) |
| `app/runner` | `@geek-bot/runner` | Node 标准库单文件程序；隔离配置、显式工具白名单、omp、结果和补丁 | [runner](docs/services/runner/README.md) |
| `packages/protocol` | `@geek-bot/protocol` | 共享 DTO 与 JSON Schema；不导入 app，不做 I/O | [protocol](docs/services/protocol/README.md) |

## 现状

- #34 实现了共享平台的持久化 API、真实后台、渠道适配、节点与 runner 源码。业务事实来源是各服务契约和源码，不以设计文档代替实现证据。
- 本机真实 HTTP / SQLite 已验证：项目发现与同步、需求关联派发、租约与迟到结果拒绝、一次性令牌重放拒绝、角色授权和重启后的结果保存。外部 API 使用隔离协议服务，不是在线账号验收。
- 生产模式后台已在 Ego 浏览器验证桌面与 390px 视口下的项目列表、需求录入关联、派发和取消。登录态来自隔离授权流程，不算真实 GitHub OAuth 验收。样板数据模式只用于开发与浏览器回归，写请求明确返回 405。
- 真实 GitHub OAuth、GitLab、飞书账号的外部写入、node / sandbox 镜像与 Linux/KVM 任务环境仍需具备授权和硬件条件后验收，不标为通过。
- 控制面与 node / sandbox 有 Dockerfile；发布 tag、部署栈和目标机部署仍受 [RELEASES](docs/conventions/RELEASES.md) 约束。本次不自动提交、推送、打 tag 或部署。

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
   pnpm dev:node        # 启动出站节点；先在后台登记机器并配置 node_token 文件与执行器资产
   PLAYWRIGHT_BROWSERS_PATH=/tmp/geek-bot-playwright pnpm test:e2e # 首次用同一路径运行 playwright install chromium
   ```

4. 一件事一个 issue、一个 `task/<issue>/<slug>` 分支、一个 worktree、一个 PR 回 `stage`：见 [CONTRIBUTING](docs/conventions/CONTRIBUTING.md) 与 [BRANCHING](docs/conventions/BRANCHING.md)。

类型检查、构建成功、mock 预览、浏览器验证、线上验收是不同的证据，不能互相替代（[TESTING](docs/conventions/TESTING.md)）。

## 文档

- [AGENTS.md](AGENTS.md)：唯一的 agent 入口与硬门禁。
- [docs/README.md](docs/README.md)：文档总入口，目录 ↔ 服务契约 ↔ 规范的地图。
- [架构决策](docs/decisions/README.md)：为什么独立成通用产品（[ADR-0001](docs/decisions/0001-standalone-product.md)）等。

## 许可证

尚未选定。公开前由所有者选定许可证、补上 `SECURITY.md`，并满足 [ADR-0001](docs/decisions/0001-standalone-product.md) 列出的其它公开前条件（仓库文件、提交历史，以及 GitHub 上的 issue、PR、评论等内容都检查干净）。
