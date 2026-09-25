# geek_bot 架构

> 控制面加工作节点：control 单进程单写者、唯一 GitHub 写入方；节点只出站领任务，在无网 sandbox 或一次性 VM 里运行 omp。

状态：`proposed` · 更新：2026-09-25 · 适用：全部 `app/*` 与 `packages/protocol` · 由 #2 定稿

本文是架构草案，还没有任何一部分实现。#2 逐条核对并写定，涉及的决策记为 ADR-0002 到 ADR-0009（#2 写入）；各部分由后续 issue 实现，实现后把对应段落改成 `current`。标「未验证」的内容要由对应 issue 实测。

## 1. 定位

geek_bot 是一个可自部署的 GitHub 维护机器人，面向任何部署者。

- 部署者在 Web 后台用一个 GitHub 账号（一般是小号）登录，这个账号就成为机器人。机器人以**这个账号本人的身份**，在它能访问的全部仓库里工作：自己的、所在组织的、作为协作者的。
- 它做四件事：审查 PR（只发 `COMMENT`）；受理和跟进 issue；在一次性 VM 里修小改动并开 PR；返工自己开的 PR。
- 批准与合并始终由人来做。
- 每个仓库的规则由仓库自己决定（配置文件和规范文档，加上后台的覆盖）；没有规则时用内置默认规范，默认规范可以在后台修改。
- 代码和文档不写死任何组织、仓库、网关、主机和网段。所有者定下的行为规则都是可配置的默认值，见 [control 服务契约](../services/control/README.md)「计划中的默认行为」。

## 2. 拓扑

```text
                    管理员浏览器
                         │ HTTPS（或显式开启的私网明文 HTTP）；SSE 实时推送
                         ▼
┌──────── 控制主机（每个环境一个 compose 项目）─────────────────────────┐
│ control 容器：Fastify 5 + better-sqlite3，单进程，SQLite 唯一写入者     │
│  ├─ console 静态产物（Vue 3.5 + Tuffex 0.6.0），同源托管               │
│  ├─ /api/v1/*        后台 API 与 SSE                                   │
│  ├─ /api/node/v1/*   节点 API                                          │
│  ├─ discovery → poller → items → scheduler（队列、租约、epoch）         │
│  ├─ rules（只读 base 分支）                                            │
│  ├─ publisher（唯一 GitHub 写入方：白名单 + 输出中和 + outbox）         │
│  ├─ model relay（每任务令牌换成网关密钥）                              │
│  └─ 命名卷：数据库、镜像克隆、任务包、任务事件、备份                   │
└──────────────▲──────────────────────────────────────┬─────────────────┘
               │ 节点主动发起的出站 HTTP(S) 长轮询      │ GitHub REST / GraphQL / git
               │（同机走 compose 网络；异机走私有组网或 https）
┌──────── 工作主机（每台一个 node 的 compose 项目）────┐   ▼
│ node 容器：非 root，只挂 /dev/kvm，没有入站端口      │  GitHub
│  ├─ 任务端点：sandbox 走 unix socket，VM 走 guestfwd  │
│  ├─ 出网 CONNECT 代理：域名白名单，拒绝私网地址       │
│  ├─ 本地模型代理：每任务令牌转发到 control 中继       │
│  └─ qemu 一次性 VM × vm 槽位（PR 通道）              │
│ sandbox 容器 × 槽位：无网、根只读、不挂令牌（issue 通道）│
│ vmimage 一次性容器：把基础镜像拷进卷后退出           │
└──────────────────────────────────────────────────────┘
模型网关（OpenAI 兼容）只有 control 能访问。
```

第一台节点可以和控制面在同一台机器上，二者分属两个 compose 项目；以后加入的节点只运行 node 栈。

## 3. 组件

| 组件 | 运行位置 | 职责 | 持有的密钥 |
|---|---|---|---|
| control（`app/control`） | 控制主机，每个环境一个容器 | 后台 API 与 SSE；认领与登录；机器人令牌生命周期；仓库发现与权限映射；轮询；工作项推导；调度与租约；规则画像；publisher；模型中继；确定性动作；审计；备份 | master key、OAuth client secret、模型网关密钥（均为文件挂载）；库内加密的机器人令牌 |
| console（`app/console`） | 管理员浏览器；产物打进 control 镜像 | Tuffex 后台 | 只有 HttpOnly 会话 cookie |
| node（`app/node`） | 每台工作主机一个容器 | 心跳与健康上报；领租约；校验任务包；调度 sandbox；启停 VM；出网代理；模型代理；事件打码与回传；取消；泄漏回收 | 只有本节点令牌 |
| sandbox | node 镜像的另一个入口，每个槽位一个容器 | issue 通道与规则画像提取：只读快照上跑 omp，只给 read/grep/glob | 只有本任务的模型令牌，只在内存里 |
| runner（`app/runner`） | sandbox 或 VM 内 | 单文件：解包、干净 HOME、运行钉版本的 omp、转发 JSONL、外层降级、抽取结果 | 只有本任务的模型令牌 |
| 一次性 VM | node 容器里的 qemu 进程，默认 1 vCPU / 2 GiB | PR 审查（可运行仓库的校验命令）、修复、返工；结束后删除 | 只有本任务的模型令牌和仓库快照 |
| `packages/protocol` | 各包构建时引用 | 纯类型加 JSON Schema | 无 |
| CI | GitHub Actions | 日常 `pnpm verify` 与 PR 正文检查；tag 触发构建并推 ghcr。CI 不部署 | 只有 `GITHUB_TOKEN` |
| 部署脚本 | 维护者获授权后在目标机执行 | 按 digest 拉取、部署前备份、健康门、自动回滚、写部署历史 | 只检查 secrets 文件的权限与属主，不打印值 |

## 4. 数据流

1. **发现**：绑定机器人账号后，control 列出该账号能访问的全部仓库，按 `permissions` 映射出能做的事；新仓库默认只监控，写入类开关逐个仓库开启（#6）。
2. **轮询与入队**：control 用条件请求（ETag）轮询已监控仓库的 issue 与 PR，推导工作项。条目在最后一次非机器人变动后过了静默窗口，才按通道和优先级入队（#8）。
3. **规则**：control 从 base 分支按 blob sha 读取仓库规则，合成规则画像；打任务包时 head 上的规则文件用 base 版本覆盖（#10）。
4. **派发**：节点长轮询领任务；control 在一个 SQLite 事务里选任务、写租约和 epoch（#11）。
5. **执行**：节点下载并校验任务包，交给 sandbox（issue 通道）或新起的 VM（PR 通道）；runner 运行 omp，模型请求经节点的本地代理转到 control 中继（#13、#14、#17）。
6. **事件**：节点打码后批量回传事件，control 写入任务事件文件并经 SSE 推给后台（#14）。
7. **结果**：节点回报结构化结果，只进入 control 的「待发布」状态；epoch 不匹配的结果被拒（#11）。
8. **发布**：publisher 校验白名单、中和输出、写 outbox，再以机器人身份写 GitHub；修复补丁由 control 在自己的镜像克隆里提交并推送（#9、#15、#16、#18）。

## 5. 身份与登录

- 机器人身份用 OAuth App 用户令牌，默认「登录即成为机器人」：部署者在目标机拿一次性认领码，用 device flow 登录，申请 scope `repo read:org`，这个账号同时成为 owner 和机器人账号（#5）。
- 可以按 GitHub 数字 id 另外邀请管理员；被邀请者只申请 `read:user`，拿到身份后立即单独吊销那一枚令牌。
- 绑定时拒绝过大的 scope（`workflow`、`admin:org`、`delete_repo`、`write:packages`、`admin:repo_hook`）；每天校验一次令牌，401 或 scope 变化时自动暂停全部写入。
- 浏览器只拿到随机会话 id；高危操作要求 10 分钟内重新认证。
- 后台和节点 API 共用一个端口，默认只绑回环地址；公网部署要在前面加 TLS 反代，并对 SSE 路径关闭缓冲；私网明文 HTTP 必须显式开启，后台常驻「非安全上下文」提示。

## 6. 节点协议原则

- 只有节点主动发起连接；control 从不连节点；节点不开入站端口。
- HTTP/JSON 长轮询，路径前缀 `/api/node/v1`；消息形状定义在 `@geek-bot/protocol`，消息表由 #2 写入，实现在 #11。
- 节点用 bearer 节点令牌认证：令牌只显示一次，库里只存哈希，可重置，重置后旧令牌立即失效。
- 租约带 epoch：结果的 epoch 不匹配或租约已被收回时返回 409，节点丢弃结果，防止同一任务被两个节点各发布一次。
- 失联双方对称判定（默认 10 分钟）：control 收回租约、epoch 加一、换节点重排；节点自行终止任务、销毁 VM。control 计划内重启后有宽限期，不重排。
- 协议版本是整数，control 支持 N 与 N-1；不兼容的节点只收心跳、不派任务；升级顺序先 control 后节点。
- 节点自检通过、管理员解除 cordon 后才接任务；主机健康越线（温度、磁盘、内存、电源）时自动 cordon，恢复带回滞。

## 7. 调度

- 两类槽位：`sandbox` 与 `vm`。节点在本地声明并强制上限，后台设置不能超过它。
- PR 通道用 vm 槽位，issue 通道用 sandbox 槽位；提醒、到期关闭、标签维护等确定性动作由 control 直接执行，不占节点。
- 各通道的优先级、静默窗口、轮询间隔都是可配置的默认值，见 [control 服务契约](../services/control/README.md)。
- 同一条目同时最多一个活跃任务；同一仓库同时最多一个写入类任务；同一个 PR 只审最新 head，新 head 让旧审查失效。
- 基础设施失败换节点重排，最多 2 次；模型失败按池降级，池走完判失败，由人重新排队。
- 暂停分全局、通道、仓库、节点四个范围；「暂停全部写入」是单独的开关。

## 8. 执行隔离

**issue 通道 sandbox**：每个槽位一个独立容器，无网络、根只读、tmpfs 工作目录、去掉全部 capability、非 root、限制内存、CPU 和进程数，不挂任何令牌文件；通过共享卷里的 unix socket 访问节点。omp 只给 read、grep、glob，不执行仓库代码。每个任务结束后容器退出并重建。

**PR 通道 VM**（以 #12 的实测结论为准）：

- node 容器里的 qemu，每个任务一台，qcow2 overlay 叠在只读基础镜像上，任务结束删除 overlay 和磁盘。
- 网络用 QEMU 用户态网络的受限模式，只加两条 guestfwd：一条到本地模型代理，一条到出网代理。任务输入输出走原始盘上的 tar，实时事件走 virtio-serial。
- 任务令牌经 fw_cfg 以文件方式传入，不进 qemu 的命令行参数。
- 出网代理默认只放包管理源，不放 GitHub 的域名；域名解析后拒绝私网、CGNAT、链路本地和回环地址，以及部署者配置的组网网段。
- VM 里是干净的 HOME；omp 用 `--no-extensions`、`--no-lsp`、工具白名单，并关闭项目级 MCP 配置。
- VM 里没有任何 GitHub 凭据；修复结果以补丁带回，由 control 提交和推送。
- node 容器非 root，只挂 `/dev/kvm`，不挂 docker.sock，不用 privileged。

control 永远不运行 omp，也不执行目标仓库里的任何代码。

## 9. 写入出口

publisher 是 control 里唯一的 GitHub 写入方，默认拒绝，按方法、路径、参数逐项校验。允许的写入只有：

1. PR review：event 只能是字面量 `COMMENT`，`commit_id` 必须等于任务的 head；
2. issue 评论，以及修改机器人自己发的、带标记的评论；
3. 增删受管标签；
4. 按状态机条件关闭 issue：只关 issue、不关 PR，人重开过的不关，关闭前先发说明；
5. 为改写新开 issue：正文引用原 issue 并 @ 原作者；
6. git push：只推机器人分支、只快进、带 `--no-tags`，不推默认分支和 base 分支，不改 `.github/workflows/**`；
7. 开 PR：head 是同仓库的机器人分支，结论段固定写阻塞；
8. 接受协作邀请：只能由管理员在后台触发。

合并、批准、改别人的 PR、删分支或标签、改仓库设置等其它写入一律拒绝。发布前对模型输出做中和（去掉 HTML 注释、中和机器可解析的结论行和 `Closes #n`、转义 @ 提及、打码密钥）。每条写入带隐藏标记，outbox 保证不重复写，结果未知的先核对再决定是否重发；写入有令牌桶限速；preview 只能写配置的沙盒仓库。白名单的编号清单由 #2 写入，实现在 #9。

## 10. 模型

- 模型目录只来自部署者挂载的只读 catalog 文件，schema 在 `@geek-bot/protocol`；不建模型表。
- 模型按任务类型分池，每项是 catalog id 加思考档位；没有 efforts 的模型只提供 off 档位。
- 网关密钥只在 control；sandbox 和 VM 用每任务令牌经节点、再经 control 中继访问模型，令牌限定池内模型、预算和租约期。
- 降级两层：omp 进程内的 fallbackChains 处理瞬时错误；本轮已有输出后才失败时，由 runner 按池换下一个模型重跑。control 中继的记录是降级记录里可信的一方（#13、#14）。

## 11. 数据

- SQLite（WAL），只有 control 写；preview 与 production 各一个库。
- 迁移按编号的 SQL 文件加 `PRAGMA user_version`，只扩不缩；迁移前自动备份；库版本比代码新时拒绝启动（#3）。
- 每天加密备份，并自动恢复到临时文件做完整性校验；master key 不进备份（#3、#20）。
- 库丢失时，可以按隐藏标记从 GitHub 重建追问轮次、已审的 head 和关闭状态。

## 12. 部署拓扑

- 镜像：`geek-bot-control`（内含 console）、`geek-bot-node`（内含 runner、omp、qemu、sandbox 入口）、`geek-bot-vmimage`。都以非 root 运行、带健康检查。
- 发布：`vX.Y.Z-rc.N` tag 打在 stage 上，触发构建一次并推 ghcr；`vX.Y.Z` 打在已验收 rc 的同一提交上，只给同一 digest 加别名，不重新构建。正式环境运行的就是预发布验收过的那个 digest。
- 部署：CI 不部署。维护者获授权后在目标机运行仓库里的部署脚本：按 digest 拉取、部署前备份、`docker compose` 启动、健康门、失败自动回滚、写部署历史。手工改运行中的栈是禁止的。
- 环境：`production` 与 `preview` 两套完全独立的 Docker 栈（compose 项目、卷、端口、OAuth App、master key、节点令牌各一套）；节点另有 node 栈。
- env 文件只有 `.env.production` 与 `.env.preview` 两份；仓库里的模板只放占位符和通用默认值，实例的真实非密值只在目标机，密钥一律 `*_FILE`。
- release.yml、部署脚本、compose 与 env 模板都是计划中的，见 #7；正式上线见 #20。

## 13. 残余风险

- OAuth `repo` scope 不能按仓库收窄，免费计划的私有仓库没有分支保护和 rulesets；「不推主干、不打 tag、不合并」完全依赖 publisher 代码。
- 提示注入可能产生误导性的审查评论。
- qemu 或 KVM 逃逸。
- 控制面是单点，并且持有全部密钥。
- 私网明文 HTTP 模式的保密性依赖组网本身的加密。

安全不变量逐条见 [SECURITY](SECURITY.md)。
