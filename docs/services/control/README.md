# control 服务契约（`app/control`）

> 控制面是唯一数据库写者和多渠道外部写出口，管理身份、连接、项目、需求、任务、机器、模型中继与同源后台。

状态：`current` · 更新：2026-10-03 · 适用：`app/control`、`tests/control`（#3 的基础与 #34 的共享平台）

## 职责与边界

Fastify 5 + better-sqlite3 的单进程服务独占 SQLite。后台、节点、CLI 和 publisher 在这一个写者内共享事务；其它包不能打开业务数据库。

control 不运行 omp，不执行仓库脚本。读取适配器和 publisher 在请求期间解密渠道密文；浏览器、node、sandbox 和 VM 不拿平台凭据或 gateway key。所有外部写入经具名 publisher 意图，不提供任意方法、路径或模型指定的目标。

产品边界见 [ADR-0012](../../decisions/0012-shared-cross-platform-workspace.md)，后台身份与连接账号分离。current 表示本文对应源码，不表示真实外部账户、镜像、KVM 或线上验收通过。

## 源码地图

| 路径 | 当前责任 |
|---|---|
| `src/index.ts` | 可执行进程入口，监听与信号 |
| `src/services.ts` | 配置、独立密钥、独占数据库、迁移前备份、服务组装、平台启动与优雅停机；StartOptions 可注入 clock 和 fetchImpl |
| `src/app.ts` | Fastify、请求 id、JSON 错误、输入限制与 Ajv 拒绝未知字段和类型强制转换 |
| `src/config.ts` | 基础部署和备份配置；不读取真实环境或文件 |
| `src/db/` | 数据库、版本 SQL、结构收缩检查、审计与告警；`0001_foundation.sql` 和 `0002_shared_platform.sql` |
| `src/platform/config.ts` | 平台配置与独立 session / OAuth / gateway 密钥文件；拒绝直接密钥值 |
| `src/platform/{http,context,security,auth,admins}.ts` | 协议、幂等、限流、cookie HMAC、CSRF/Host、device flow、会话和数字身份角色 |
| `src/platform/{connections,demands,records,schemas}.ts` | 连接与项目的发现同步、密文写入、需求与入站事务、公共记录和序列化白名单 |
| `src/platform/{tasks,intake,machines,health}.ts` | 平台条目任务、需求派发、系统审计的自动入队、去重、资源租约、回收、自检与健康门 |
| `src/platform/{models,relay}.ts` | 只读 catalog、模型池、短期模型令牌和预算、有界模型中继 |
| `src/platform/{events,static,registry,index}.ts` | SSE 缓存、同源静态后台、组装与生命周期 |
| `src/routes/platform/*/{index,contracts}.ts` | auth、admins、connections、projects、demands、machines、tasks、models、node 的真实 HTTP 映射与 schema |
| `src/routes/platform/{stream,console}/index.ts` | SSE 与 SPA 产物托管 |
| `src/connectors/{types,http,credentials,bundle,index}.ts` | 适配器契约、有界同源读取、AES-256-GCM、base 规范与快照输入、可信代码注册 |
| `src/connectors/{github,gitlab,im}.ts` | 实际平台端点、权限映射、issue/change、飞书验证解密和签名 Webhook |
| `src/publisher/{index,git}.ts` | 输出中和、持久 outbox、未知结果核对、COMMENT、受保护分支、OAuth 单枚撤销和 IM 回传 |
| `src/log/` | JSON 日志、密钥形态与已知凭据打码 |
| `src/ops/` | 流式加密备份、恢复校验、保留策略、每日任务和 CLI Unix socket |
| `src/cli.ts` | backup、verify-backup、restore --dry-run 和 bootstrap-code |
| `scripts/dev.mjs` | 本机生成独立 master / backup / session 临时密钥并启动，不读取任何实例真实配置 |
| `Dockerfile` | 非 root 控制面镜像定义；镜像构建或部署不等于此源码已验收 |

## 配置

变量的直接事实来源为 `src/config.ts`、`src/platform/config.ts` 与根 `.env.example`。真实实例值只放目标机，密钥经 `*_FILE`，不进仓库、镜像或日志。

| 分组 | 变量 | 作用 |
|---|---|---|
| 身份和监听 | `GEEK_BOT_INSTANCE_ROLE`, `GEEK_BOT_HOST`, `GEEK_BOT_PORT`, `GEEK_BOT_PUBLIC_ORIGIN`, `GEEK_BOT_ALLOW_PLAINTEXT_MESH` | role 必须 preview/production；非回环必须显式 origin 和 TLS 或明确私网明文 |
| 数据与备份 | `GEEK_BOT_DB_PATH`, `GEEK_BOT_BACKUP_KEEP_DAILY`, `GEEK_BOT_BACKUP_KEEP_WEEKLY`, `GEEK_BOT_BACKUP_HOUR_UTC` | 库目录下备份、run 和 tmp；基础保留策略不因平台改动消失 |
| 三把独立密钥 | `GEEK_BOT_MASTER_KEY_FILE`, `GEEK_BOT_BACKUP_KEY_FILE`, `GEEK_BOT_SESSION_SECRET_FILE` | 32 字节 key，各自随机生成，不能共用或从 master 派生 session |
| 后台 OAuth | `GEEK_BOT_GITHUB_CLIENT_ID`, `GEEK_BOT_OAUTH_CLIENT_SECRET_FILE`, `GEEK_BOT_GITHUB_WEB_URL`, `GEEK_BOT_GITHUB_API_URL` | device flow 与单枚令牌撤销；未配置 App 时不假造身份 |
| 模型 | `GEEK_BOT_MODEL_GATEWAY_URL`, `GEEK_BOT_MODEL_GATEWAY_KEY_FILE`, `GEEK_BOT_MODEL_CATALOG_FILE` | catalog 与配置 URL 必须匹配；密钥只在 relay，模型目录不建表 |
| 上限与租约 | `GEEK_BOT_WRITE_MODE`, `GEEK_BOT_PUBLISHER_REPO_ALLOWLIST`, `GEEK_BOT_PUBLISHER_REPO_DENYLIST`, `GEEK_BOT_LEASE_LOST_AFTER_SECONDS`, `GEEK_BOT_INFRA_RETRY_MAX` | 新项目 off；全局 dry_run 上限，preview 清单空不能写任何项目，包括演练 |
| 任务预算 | `GEEK_BOT_TASK_TOKEN_BUDGET`, `GEEK_BOT_TASK_REQUEST_BUDGET`, `GEEK_BOT_TASK_TIMEOUT_SECONDS` | 每任务令牌的请求、token 和时间约束 |
| 后台和身份显示 | `GEEK_BOT_CONSOLE_DIST`, `GEEK_BOT_RELEASE_DISPLAY`, `GEEK_BOT_RELEASE_VERSION`, `GEEK_BOT_RELEASE_COMMIT` | 同源实际产物与发布来源，本机明确未发布；不自行升版本或打 tag |

直接写 `GEEK_BOT_SESSION_SECRET`、`GEEK_BOT_OAUTH_CLIENT_SECRET` 或 `GEEK_BOT_MODEL_GATEWAY_KEY` 被拒绝。错误只写变量名，不回显误填的值。

## 身份、项目和需求

后台登录只确认数字身份并撤销临时令牌；机器人连接另行授权。owner、operator、viewer 的数据池相同，操作权限不同。owner 在开启高危范围前重新认证，UI 只是提示，服务端最终拒绝。

项目 id 由连接和平台 id 稳定识别，名称和转移不是身份。权限取平台角色、token scope、项目开关、写入模式与任务能力的交集；unknown 不能被猜成可写。新项目四类处理开关全关。lost、archived、禁用连接不能继续派发或写入。

消息需求按连接和 event_id 去重。未关联项目不能派发；平台条目生成稳定 item 关联需求，模型自由文本不决定目标。Project ItemDispatch 路由与手工需求共用任务校验，但任务包按实际 item 的固定 head/base 生成。

## 调度、执行和结果

control 在事务里检查槽位、CPU、内存、标签、信任和管理员机器范围，写 lease/epoch。私有项目只派 high；同一条目最多一个活跃任务，同一项目最多一个活跃 fix/rework。新 head 会 supersede 旧结果。

节点报告必须有正确名字、协议、令牌及一致的头／体租约。401 使身份失效，409 作废该任务；迟到结果不改任务，也不能产生外部写入。节点自检报告和健康是数据，不是指令。

无条目的只读需求产生真实本地报告并完成；有平台条目的结果经 publisher 受控发布。IM 进展在事务后排 outbox，不等待网络才应答飞书，未知结果不盲重发。自动 review/triage 与管理员按条目派发的来源、去重和限制见 `platform/intake.ts`、[行为契约](behavior.md) 和 [后台 API](../../architecture/API.md)。

## 启动、运维与停机

1. 校验基础配置，读取 master 和 backup。
2. 独占打开库，清理受权限保护的明文 tmp。
3. 检查已应用迁移校验和、编号和兼容版本；非空库有待迁移时先加密备份，失败不迁移。
4. 应用只扩不缩的 SQL，组装共享平台，读取独立 session 和配置所需的其它文件。
5. `/readyz` 全部条件通过后监听；启动平台循环、运维本地通道和每日备份。

SIGTERM/SIGINT 后拒绝新请求，关闭派发与中继，等待已进行请求、publisher 和备份，做 WAL checkpoint 再关库。停机不能丢掉 sending 的不确定状态或未确认节点数据。

`geek-bot bootstrap-code` 经同一运维 socket 生成 100 位、15 分钟、一次性认领码，只打印到授权终端。backup、verify-backup 也经同一单写者；离线 CLI 必须独占库并核对版本。restore 目前只做 dry-run，不覆盖实例数据。

## 验证和实际边界

```bash
pnpm --filter @geek-bot/control typecheck
pnpm exec vitest run tests/control
pnpm --filter @geek-bot/protocol build
pnpm --filter @geek-bot/control build
pnpm --filter @geek-bot/console build
pnpm dev:control
```

本机真实 HTTP/SQLite 已观察：GitLab 条目形成有 item 的任务，真实 ControlClient 续租、下载和回报，GitHub 同步自动形成 review，重复同步不重复任务，COMMENT-only dry_run、role 403、late epoch 409、一次性令牌重放 409和重启结果保存。

Ego 用生产 console 连本机真实服务验证桌面与 390px 的需求操作。外部接口为隔离协议服务；没有真实 GitHub/GitLab/飞书账号授权或发布，也没有用真实模型或 KVM 验证。类型、构建、协议 smoke、浏览器和外部上线证据必须分开。

告警数据、审计和备份已持久化。异地备份、正式恢复、生产发布和未在当前路由注册的管理页面不由本次源码虚构成已交付。发布和部署仍按原门禁单独授权。
