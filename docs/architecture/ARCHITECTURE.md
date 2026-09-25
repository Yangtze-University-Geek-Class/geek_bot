# geek_bot 架构

> 控制面加工作节点：control 单进程单写者、唯一 GitHub 写入方；节点只出站领任务，在无网 sandbox 或一次性 VM 里运行 omp。

状态：`proposed` · 更新：2026-09-26 · 适用：全部 `app/*`、`packages/protocol` 与部署文件（由 #3–#21 实现）

本文是设计，还没有任何一部分实现。每节末尾写涉及的决策（ADR）和实现它的 issue；某一节实现落地后，把它改成 `current`，此后文档与代码不符就在同一次改动里修正。标「未验证」的内容由括号里的 issue 实测后改写。

相关文档：安全不变量与密钥表见 [SECURITY](SECURITY.md)；后台 API 见 [API](API.md)；节点协议消息表见 [节点协议](../services/node/protocol.md)；写入白名单见 [write-whitelist](../services/control/write-whitelist.md)；默认行为与配置项见 [behavior](../services/control/behavior.md)；数据表见 [data-model](../services/control/data-model.md)。

## 1. 定位

geek_bot 是一个可以自己部署的 GitHub 维护机器人，面向任何部署者。

- 部署者在 Web 后台用一个 GitHub 账号（一般是小号）登录，这个账号就成为机器人。机器人以**这个账号本人的身份**，在它能访问的全部仓库里工作：自己的、所在组织的、作为协作者的。
- 它做四件事：审查 PR（只发 `COMMENT`）；受理和跟进 issue；在一次性 VM 里修小改动并开 PR；按审查意见返工自己开的 PR。
- 批准与合并始终由人来做。机器人不批准、不请求修改、不合并、不改仓库设置。
- 每个仓库的规则由仓库自己决定（仓库里的配置文件和规范文档，加上后台的覆盖）；没有规则时用内置默认规范，默认规范可以在后台修改。
- 代码和文档不写死任何组织、仓库、网关、主机、网段和组织专属的记录格式。所有者定下的行为规则（PR 必审只评论、issue 两条通道、等回复第 5 天提醒第 7 天关闭最多追问 2 轮、改写后重开、PR 通道优先级、模型按池降级、PR 通道每任务一台临时 VM、写入走白名单）都是**可配置的默认值**，逐条见 [behavior](../services/control/behavior.md)。
- control 永远不运行 omp，也不执行目标仓库里的任何代码。

涉及：[ADR-0001](../decisions/0001-standalone-product.md)。实现：#3–#21。

## 2. 拓扑

```text
                    管理员浏览器
                         │ HTTPS（或显式开启的私网明文 HTTP）；SSE 实时推送
                         ▼
┌──────── 控制主机（每个环境一个 compose 项目 geek-bot-<env>）──────────┐
│ control 容器：Fastify 5 + better-sqlite3，单进程，SQLite 唯一写入者     │
│  ├─ console 静态产物（Vue 3.5 + Tuffex 0.6.0），同源托管               │
│  ├─ /api/v1/*        后台 API 与 SSE（/api/v1/stream）                 │
│  ├─ /api/node/v1/*   节点 API                                          │
│  ├─ /healthz、/readyz、/api/release                                    │
│  ├─ discovery → poller → items → scheduler（队列、租约、epoch）         │
│  ├─ rules（只读 base 分支，按 blob sha 缓存）                          │
│  ├─ publisher（唯一 GitHub 写入方：白名单 + 输出中和 + outbox）         │
│  ├─ model relay（每任务令牌换成网关密钥）                              │
│  └─ 命名卷：数据库、镜像克隆、任务包、任务事件、备份                   │
└──────────────▲──────────────────────────────────────┬─────────────────┘
               │ 节点主动发起的出站 HTTP(S)             │ GitHub REST / GraphQL / git
               │（同机走 compose 网络；异机走私有组网或 https）
┌──────── 工作主机（每台一个 compose 项目 geek-bot-node-<env>）┐   ▼
│ node 容器：非 root，只挂 /dev/kvm，没有入站端口              │  GitHub
│  ├─ 任务端点：sandbox 走 unix socket                          │
│  │            VM 走原始盘上的 tar、virtio-serial 和 guestfwd  │
│  ├─ 出网 CONNECT 代理：域名白名单，解析后拒绝私网地址         │
│  ├─ 本地模型代理：每任务令牌转发到 control 中继               │
│  └─ qemu 一次性 VM × vm 槽位（PR 通道）                      │
│ sandbox 容器 × 槽位：无网、根只读、不挂令牌（issue 通道）      │
│ vmimage 一次性容器：把基础镜像拷进卷后退出                   │
└──────────────────────────────────────────────────────────────┘
模型网关（OpenAI 兼容，例如 https://gateway.example.com/v1）只有 control 能访问。
```

- 第一台节点可以和控制面在同一台机器上，二者分属两个 compose 项目；以后加入的节点只运行 node 栈。架构允许以后把 control 迁到更稳定的机器，原来的机器只当节点。
- 后台、节点 API、健康检查共用 control 的一个端口。默认只绑回环地址；公网部署在前面加 TLS 反代，并对 `/api/v1/stream` 关闭缓冲；私网明文 HTTP 必须显式开启（见第 5 节）。
- control 从不主动连接节点；节点不开入站端口。

涉及：[ADR-0003](../decisions/0003-single-writer-control.md)、[ADR-0004](../decisions/0004-execution-isolation.md)、[ADR-0007](../decisions/0007-ghcr-pull-deploy.md)、[ADR-0009](../decisions/0009-tuffex-console.md)。实现：#3、#7、#11、#20。

## 3. 组件

| 组件 | 运行位置 | 职责 | 持有的密钥 |
|---|---|---|---|
| control（`app/control`） | 控制主机，每个环境一个容器 | 后台 API 与 SSE；认领与登录；机器人令牌生命周期；仓库发现与权限映射；条件请求轮询；工作项推导（静默窗口、识别自身写入、关联 PR）；调度与租约；规则画像；publisher；模型中继；确定性动作（提醒、到期关闭、标签维护）；审计；备份与恢复校验 | master key、OAuth client secret、模型网关密钥、会话签名密钥、备份加密密钥（都以 `*_FILE` 文件挂载）；库内加密的机器人令牌 |
| console（`app/console`） | 管理员浏览器；产物打进 control 镜像 | Tuffex 后台：概览、队列、任务实时详情、未接的条目、仓库、节点、模型池、机器人账号、设置、告警与审计 | 只有 HttpOnly 会话 cookie |
| node（`app/node`） | 每台工作主机一个容器 | 心跳与主机健康上报；领租约；下载并校验任务包；调度 sandbox；启动和销毁 VM；出网代理；本地模型代理；事件打码、批量回传和断线缓存；取消；VM 泄漏回收；失联后自行终止任务 | 只有本节点令牌（0400，属主是节点 uid） |
| sandbox | node 镜像的另一个入口，与 node 同一 compose 项目，每个槽位一个容器 | issue 通道和规则画像提取：在只读快照上跑 omp，只给 read、grep、glob，产出结构化结果；每个任务结束后容器退出、自动重建 | 只有本任务的模型令牌，只在内存里 |
| runner（`app/runner`） | sandbox 或 VM 内 | 只用 Node 标准库的单文件：解包、剔除仓库里的代理配置、准备干净 HOME 和 overlay、运行钉版本的 omp、原样转发 JSONL、外层降级、抽取 review.v1 / triage.v1 / patch.v1 结果 | 只有本任务的模型令牌 |
| 一次性 VM | node 容器里的 qemu 进程，默认 1 vCPU / 2 GiB | PR 审查（可以运行仓库画像里声明的校验命令）、修复、返工；结束后删除 overlay 和磁盘 | 只有本任务的模型令牌和仓库快照 |
| vmimage | node 栈里的一次性容器，按 digest 固定 | 携带 VM 基础镜像、内核和 initrd，拷进节点的基础镜像卷后退出 | 无 |
| `packages/protocol` | 各包构建时引用 | 纯类型加 JSON Schema：节点协议、TaskSpec、任务结果、RepoProfile、catalog 文件契约、console API DTO | 无 |
| CI | GitHub Actions | 日常 `pnpm verify` 与 PR 正文检查；发布 tag 触发构建一次并推 ghcr。CI 不部署 | 只有 `GITHUB_TOKEN`；发布工作流只给 `contents: read` 与 `packages: write`，做构建证明时再加 `id-token: write`、`attestations: write` |
| 部署脚本 | 维护者获授权后在目标机执行 | 按 digest 拉取、部署前备份、健康门、失败自动回滚、写部署历史 | 只检查 secrets 文件的权限与属主，不打印值 |

涉及：[ADR-0003](../decisions/0003-single-writer-control.md)、[ADR-0004](../decisions/0004-execution-isolation.md)、[ADR-0007](../decisions/0007-ghcr-pull-deploy.md)、[ADR-0009](../decisions/0009-tuffex-console.md)。实现：#3（control 骨架）、#4（console 外壳）、#11（node）、#14（sandbox 与 runner）、#17（VM 与 vmimage）、#7（CI 发布与部署脚本）。

## 4. 数据流

1. **发现**：绑定机器人账号后，control 列出该账号能访问的全部仓库，按 `permissions` 映射出能做的事；新仓库默认只监控，写入类开关逐个仓库开启（#6）。
2. **轮询与入队**：control 用条件请求（ETag）轮询已监控仓库的 issue 与 PR，推导工作项。条目在最后一次非机器人变动后过了静默窗口，才按通道和优先级入队（#8）。
3. **规则**：control 从 base 分支按 blob sha 读取仓库规则，合成规则画像；打任务包时，head 上的规则文件用 base 版本覆盖（#10）。
4. **派发**：节点长轮询领任务；control 在一个 SQLite 事务里选任务、写租约和 epoch（#11）。
5. **执行**：节点下载并校验任务包，交给 sandbox（issue 通道）或新起的 VM（PR 通道）；runner 运行 omp，模型请求经节点的本地代理转到 control 中继（#13、#14、#17）。
6. **事件**：节点打码后批量回传事件，control 写入任务事件文件并经 SSE 推给后台（#14）。
7. **结果**：节点回报结构化结果，只进入 control 的「待发布」状态；epoch 不匹配的结果被拒（#11）。
8. **发布**：publisher 校验白名单、中和输出、写 outbox，再以机器人身份写 GitHub；修复补丁由 control 在自己的镜像克隆里提交并推送（#9、#15、#16、#18）。

## 5. 身份与登录

**选型**：OAuth App 用户令牌。

- 不用 GitHub App：它只能访问装了这个 App 的账号的资源，每个组织都要 owner 安装，作为协作者的仓库装不了；它的 `[bot]` 身份也不能被分配 issue。
- 不用 fine-grained PAT：只能选一个资源所有者，覆盖不了作为协作者参与的仓库。
- classic PAT 只作兜底，给组织禁用 OAuth App 的情况用，默认关闭。
- 每个环境注册一个 OAuth App，并在 App 设置里开启 Device Flow。

**首次认领**：在目标机执行 control 的 CLI `bootstrap-code`，打印一个一次性认领码（熵不低于 100 位，15 分钟有效，只输出到终端，不写日志）。浏览器打开后台，先输入认领码，才能开始登录。公开部署在被认领之前不会被路人抢先接管。

**默认主路径：登录即成为机器人**。

- 认领后用 device flow 登录，申请 scope `repo read:org`；这个账号同时成为 owner 和机器人账号。
- 令牌只以 AES-256-GCM 密文存在库里，只有 publisher 和 GitHub 读取层能解密；浏览器只拿到随机会话 id（库里存哈希）；后台里一切写 GitHub 的操作都进 publisher 白名单，会话本身不能直接写 GitHub。
- 后台常驻提示「机器人以你的身份发言」。

**可选路径：另设管理员**。

- owner 在后台按 GitHub **数字 id** 邀请 operator 或 viewer。不按 login 判定，因为 login 可以改名，也可能被别人重新注册。
- 管理员和机器人本人登录后台时申请**空 scope**；control 用这枚令牌调一次 `GET /user` 取到数字 id，随即调用 `DELETE /applications/{client_id}/token` 吊销**这一枚**令牌，不删 grant，否则同一个 App 的机器人令牌会一起失效。不在管理员名单里的账号登录，拿到的令牌同样立即吊销。
- 原因：同一个 OAuth App 对同一用户已授权的 scope 会沿用，每个 user/app/scope 组合最多保留 10 枚令牌，超出后 GitHub 吊销旧的；立即吊销可以避免挤掉机器人令牌。重新认证（见下文）也走这条「取完身份即吊销」的路径。

**角色**（与 ADR-0002、[data-model](../services/control/data-model.md) 的 `admins.role` 一致）：

- `owner`：认领者，默认路径下同时是机器人账号；全部权限。打开任何写入类开关、调高写入模式、邀请管理员、生成节点令牌这类高危操作只归 owner。
- `operator`：日常操作：关掉仓库开关、开关「监控」、暂停和恢复派发、暂停写入（不能恢复）、取消、重新排队、提到最前、cordon、解除 cordon、排空、改模型池、确认告警。
- `viewer`：只读。viewer 能看到机器人读到的私有仓库内容（任务输出、审查预览、事件），邀请时后台会提示这一点。

每个 `/api/v1/*` 端点在服务端按角色鉴权，不以按钮是否显示为准；逐项的角色矩阵见 [API](API.md)「角色与鉴权」。

**绑定校验**：

- 读响应头 `X-OAuth-Scopes`，按允许名单核对：必须是 {`repo`, `read:org`} 的子集，其它 scope 一律拒绝绑定（`workflow`、`admin:org`、`delete_repo`、`write:packages`、`admin:repo_hook` 作为拒绝测试的样例）。
- 每天用 `GET /user` 校验一次，同时起保活作用：GitHub 会吊销长期未使用的 OAuth 令牌。
- 出现 401 或 scope 变化时，自动进入「暂停全部写入」，后台告警；重新绑定、新令牌校验通过后才恢复。
- 同一个账号不要反复绑定为机器人：每次绑定都会在同一组 scope 下新增一枚令牌，攒到上限时 GitHub 会吊销旧令牌，可能正好是在用的那一枚；换绑时先吊销旧令牌。

**登录方式**：

- 默认 device flow：不需要回调地址，控制面只在私有组网内可达时也能用。
- 部署者配置的公开地址（`GEEK_BOT_PUBLIC_ORIGIN`，部署环境变量，随 #7 写进 ENVIRONMENTS）是 https 时，额外提供 web flow + PKCE（S256），只用于登录，不用于重新认证。流程 cookie 用 `SameSite=Lax`（GitHub 回调是跨站的顶层跳转），会话 cookie 仍是 Strict；回调先完成 state 与 PKCE 核对，再签发会话。非回环地址的 http 回调 GitHub 是否接受，未验证，由 #5 实测。
- device flow 有设备码钓鱼的风险（RFC 8628 §5.4）：登录页提示不要输入不是自己发起的码，新会话通知 owner，并对登录端点限速。

**会话**：

- 空闲 2 小时过期，最长 12 小时。
- 写请求校验 Origin 和 `Sec-Fetch-Site`；会话 cookie 为 HttpOnly、SameSite=Strict，https 部署时加 Secure。规则细节见 [API](API.md)「会话与 CSRF」。
- 高危操作只归 owner，并要求 10 分钟内重新认证过，清单见 [SECURITY](SECURITY.md) S-09。重新认证只走 device flow。

**网络位置**：

- 后台和节点 API 共用一个端口，默认只绑回环地址。
- 监听非回环地址时必须配置 `GEEK_BOT_PUBLIC_ORIGIN`，并校验 `Host` 头；在反代后面时要配置可信代理，只信任它转发的客户端地址与协议头。这些都是部署环境变量，随 #7 写进 ENVIRONMENTS。
- 公网部署必须在前面加 TLS 反代，并对 SSE 路径关闭缓冲。
- 私网明文 HTTP 模式必须显式设置 `GEEK_BOT_ALLOW_PLAINTEXT_MESH=true`（部署环境变量，随 #7 写进 ENVIRONMENTS）：cookie 没有 Secure 属性，保密性依赖组网本身的加密；后台顶部常驻「非安全上下文」提示。
- 只在组网内可达、又不想开明文模式时，退路是只绑回环地址，再用 SSH 隧道访问。

涉及：[ADR-0002](../decisions/0002-github-identity.md)。实现：#5（会话的基础设施随 #3）。

## 6. 仓库发现与权限

**发现**：

- 绑定后立即扫描一次，之后每 10 分钟一次，都带 ETag：`GET /user/repos?affiliation=owner,collaborator,organization_member&per_page=100`（分页）、`GET /user/orgs`、`GET /user/memberships/orgs`。
- 每个仓库按 GitHub 数字 id 跟踪，改名或转移后不会丢。
- 仓库失去访问权后标为 `lost`，取消它排队中的任务，历史保留。
- 已归档的仓库只监控、不做动作；fork 默认只展示。
- 机器人收到的待接受协作邀请在后台列出；只有 owner 在后台点击后，才由 publisher 接受。

**组织的 OAuth App 访问限制**：新建组织默认开启这项限制，未批准的 App 拿不到组织私有资源，受限组织的私有仓库**根本不会出现在** `/user/repos` 里。识别方式：账号在 memberships 里是这个组织的成员，但列表里没有这个组织的任何私有仓库，就提示「该组织需要 owner 在 Settings → Third-party access 批准本 OAuth App」。部署者所在组织是否开启了限制，由部署者在 #6 验收前确认。

**权限到能力**：以仓库的 `permissions` 字段为准，每 10 分钟刷新一次；publisher 每次写入前再核对一次。GitHub 仓库角色与能做的操作以官方「Repository roles for an organization」为准（见 [REFERENCES](../conventions/REFERENCES.md)，2026-09-26 核对）。

| GitHub 角色（`permissions` 里的键） | 机器人能做的事 |
|---|---|
| 只读 Read（`pull`） | 监控；审查 PR（只发 `COMMENT`）；在 issue 和 PR 上评论与追问；为改写新开 issue |
| Triage（`triage`） | 只读的全部，加上：增删受管标签；按状态机条件关闭 issue |
| Write（`push`） | Triage 的全部，加上：推机器人分支、开修复 PR、返工自己的 PR、创建受管标签 |
| Maintain / Admin（`maintain`、`admin`） | 按 Write 对待；后台标红提示「权限大于需要」 |

- 推荐给机器人账号的角色：只审查的仓库给 Read 或 Triage，需要自修的仓库给 Write，绝不给 Admin，也不设为组织 owner。
- 权限映射的每一行都要有测试（#6）。

**能否被分配**：对每个仓库调用 `GET /repos/{owner}/{repo}/assignees/{bot}`，204 表示可以分配，404 表示不行。不能被分配的仓库，后台写明「机器人在此仓库不能被分配 issue，『分给机器人优先接』不会发生」。

**逐仓库开关**：

- 新发现的仓库默认开「监控」：只读，走条件请求，按活跃度降频。
- 「审查 PR」「受理 issue」「自动修复」「返工」默认全部关闭，「写入模式」（`off` / `dry_run` / `on`）默认 `off`，都要逐个仓库开启，并写审计。打开任何写入类开关（「审查 PR」「受理 issue」「自动修复」「返工」）和调高写入模式（包括关闭 dry-run）只归 owner，并要求重新认证（清单见 [SECURITY](SECURITY.md) S-09）；operator 可以开关「监控」、关掉任何开关、调低写入模式。
- 权限不够的开关置灰，写明原因；服务端同样拒绝。
- 全局写入模式的上限由环境变量 `GEEK_BOT_WRITE_MODE`（取值同上）决定，后台不能超过它。preview 实例写沙盒仓库以外的仓库，一律拒绝并写审计（第 11 节）。

涉及：[ADR-0002](../decisions/0002-github-identity.md)。实现：#6（开关的后台页面随 #6，写入模式的执行随 #9）。

## 7. 各仓库的规则

**读取范围**：

- 规则文件一律从默认分支（或该仓库配置的 base 分支）按 blob sha 读取，**从不**从 PR head 读取。
- 读取的文件：`.github/geek-bot.yml`、`AGENTS.md`、`CONTRIBUTING*`、`.github/pull_request_template.md`、`.github/ISSUE_TEMPLATE/*`，以及 `AGENTS.md` 链接到的、文件名匹配 CODE-REVIEW、PULL-REQUESTS、ISSUES、COMMITS、BRANCHING、TRACKING 的文档。
- 目标仓库的 base 分支上没有 `CONTRIBUTING*`、`.github/ISSUE_TEMPLATE/*`、PR 模板时，回退到所在组织（或用户）`.github` 仓库默认分支上的同名文件。这是 GitHub 自己的默认社区文件机制，也就是「组织默认规范」；读不到就跳过这一层。
- 每份最多 64 KB，合计最多 256 KB；超出的截断并在画像里记下。

**防止借 PR 改规范**：打任务包时，head 快照里的 `AGENTS.md`、`CLAUDE.md`、`CONTRIBUTING*`、`.github/*template*`、`.github/geek-bot.yml` 一律用 base 版本覆盖。PR 对这些文件的修改只出现在待审 diff 里，不会成为 omp 实际加载的规则（omp 会自动加载工作目录里的 `AGENTS.md`）。

**机器可执行的字段**：分支模板、base、PR 正文段落、记录格式、受管标签、禁改路径、校验命令、需要的节点标签。只从结构化来源取值，优先级：

1. 仓库的 `.github/geek-bot.yml`；
2. 后台对该仓库的覆盖；
3. 组织 `.github` 仓库里的同名文件；
4. geek_bot 内置默认（可在后台修改）。

上面的优先级只适用于天数、窗口、模板这类非安全设置。能力开关和写入模式以后台对该仓库的设置为基准，仓库的 `.github/geek-bot.yml` 和组织 `.github` 这两层只能调低，没设置的层不参与。出网白名单的全局名单只能由 owner 重新认证后扩大，仓库层只能缩小；禁改路径各层取并集。

**散文类规范**（`AGENTS.md` 等）只作为模型上下文，不由模型解读成可执行规则。可以用一次画像提取任务从中归纳「建议画像」，但凡是影响写入的字段，都要 owner 在后台确认后才生效；确认之前，这个仓库的修复通道保持关闭。

**审查读多少规范**：审查任务不强制遵守目标仓库「先读完全部规范」的入口要求，而是用追加系统提示把审查限定为读与审查相关的规范和相关服务文档，以控制 token 成本；每个仓库可以关闭这项精简。

**内置默认**：

- 审查评论是通用 Markdown，严重度分阻塞、应修、建议；
- 机器人分支 `geek-bot/<issue>-<slug>`，base 为默认分支；
- 机器人开的 PR，结论段固定写「**结论：阻塞**（等待人工审查）」；
- 仓库没有自己的记录格式时，每条写入的第一行是追踪记录头 `<!-- track v1 kind=<类型> stage=<阶段> -->`，可在 `stage=` 后加 `actor=bot model=<id> effort=<档位> commit=<40 位 SHA>`；这是可配置的默认值，不写死；
- 每条写入的最后一行另带产品的隐藏标记 `<!-- geek-bot v1 ... -->`，用于幂等、认出自己的写入和从 GitHub 重建状态；它格式固定，不随仓库格式变化，与记录头不能互相替代。记录头和隐藏标记都只由 publisher 生成，模型只能填字段。

涉及：[ADR-0005](../decisions/0005-rules-from-base-branch.md)、[ADR-0010](../decisions/0010-tracking-record-prefix.md)。实现：#10（画像与内置默认）、#9（隐藏标记与记录头模板）、#15（审查的规范精简）。

## 8. 节点协议原则

消息逐条见 [节点协议](../services/node/protocol.md)；这里只写原则。

- 只有节点主动发起连接；control 从不连节点；节点不开入站端口。
- HTTP/JSON，路径前缀 `/api/node/v1`；领任务用长轮询。消息形状定义在 `@geek-bot/protocol`。
- 节点令牌：owner 重新认证后在后台登记节点，control 生成一枚 256 位的节点令牌，只显示一次，库里只存 SHA-256。运维把它写进节点宿主的密钥文件，只读挂进 node 容器（`GEEK_BOT_NODE_TOKEN_FILE`）。节点用它的第一次心跳就是登记，没有单独的加入或换令牌接口。「重置令牌」后旧令牌立即返回 401。
- 协议版本是整数，control 支持 N 与 N-1；范围外的节点只收心跳、不派任务，后台标「需要升级」。升级顺序先 control 后节点。
- 租约带 epoch：结果、事件、续租的 epoch 不匹配或租约已被收回时返回 409，节点丢弃结果，防止同一任务被两个节点各发布一次。
- 失联双方对称判定（默认 10 分钟，control 侧配置 `GEEK_BOT_LEASE_LOST_AFTER_SECONDS`，经心跳响应下发给节点，两侧用同一个值）：control 收回租约、epoch 加一、换节点重排；节点自行终止任务、销毁 VM。control 计划内重启后给全部租约重新计时，宽限期内不重排。
- 节点状态：登记后是 `pending`，第一次心跳后变 `cordoned`；自检（起停一台 VM、`omp --version`、模型中继连通、出网代理拦截私网地址）通过、owner 或 operator 解除 cordon 后才接任务。主机健康越线时节点自动 cordon，恢复带回滞（第 9 节）。
- 节点、sandbox、VM 都不持有 GitHub 凭据；结果只进入 control 的待发布状态。

涉及：[ADR-0003](../decisions/0003-single-writer-control.md)。实现：#11（多节点部分 #19）。

## 9. 调度

**槽位**：

- 两类：`sandbox` 和 `vm`。节点在本地声明上限并在本地强制执行；后台给节点设的实际值不能超过这个上限。节点配置的默认值是 sandbox 1、vm 0（VM 要等 #12 实测通过，由部署者显式打开）。
- vm 槽位数上限 = floor(min(vCPU 预算 / 每台 VM 的 vCPU, 内存预算 / 每台 VM 的内存))。
- 健康门控，满足任一条件时 vm 槽位临时视为 0：可用内存小于「VM 内存 + 1 GiB」；温度到达告警线；内核与模块不一致，或 vhost 模块缺失。
- 自动 cordon：温度 ≥ 95°C、数据盘可用 < 8%、文件系统未分配空间 < 4 GiB（有这个概念的文件系统才检查）、切换到电池供电。恢复带回滞：例如温度低于 85°C 持续 10 分钟后才解除。阈值都是默认值，可按节点配置。
- preview 栈平时 vm 槽位为 0，只在验收时临时打开；同机时先排空 production 的 vm 槽位，避免两套栈抢资源。

**通道与优先级**（数字越小越先）：

| 通道 | 执行器 | 优先级 |
|---|---|---|
| PR | `vm` | 10 审查别人的 PR；20 返工自己的 PR；30 修分给机器人的 issue；40 修机器人自己决定修的 issue |
| issue | `sandbox` | 10 分给机器人的；20 追问后收到回复的；30 未分配的受理；40 规则画像提取 |
| 确定性动作 | 不占节点，由 control 直接执行 | 第 5 天提醒、第 7 天关闭、标签维护、改写后关闭原 issue |

- PR 通道的默认顺序已写在 `@geek-bot/protocol` 的 `PR_CHANNEL_PRIORITY`；任务类型到通道、通道到执行器的映射是 `TASK_CHANNEL` 与 `CHANNEL_EXECUTOR`。
- 同一优先级内先在仓库之间轮转，再按 `eligible_at` 先到先得。老化提升默认关闭，可以配置。后台可以把单个任务「提到最前」，写审计。
- VM 就绪之前，PR 审查可以临时在只读 sandbox 里执行（有自己的只读工具白名单、不执行代码；`GEEK_BOT_REVIEW_EXECUTOR=sandbox`），#17 完成后切回 VM。

**入队门槛**：

- 轮询默认 60 秒。每个仓库每轮两个条件请求：`issues?state=all&sort=updated` 和 `pulls?state=open`，都带 `If-None-Match`；带认证的 304 不计入主限额。24 小时没有变化的仓库降到 5 分钟一次。不用 events API，不用 search API。
- `eligible_at = 最后一次非机器人变动 + 静默窗口`。静默窗口默认 5 分钟，可以按仓库、按类型配置。另有「机器人被请求审查时立即入队」选项，默认关闭。
- 机器人自己的写入记在 `bot_writes` 里，不会重置窗口。判断「人已回复」时，排除一切 `[bot]` 账号。
- 机器人不审查自己开的 PR；来自 fork 的 PR 照常审查，只发评论。
- 同一个 PR 只审最新 head。新 head 出现时，排队中的旧审查变为 `superseded`，正在跑的旧审查被取消。
- 审查前已经合并的 PR 照样补审；control 停机恢复后只补审 72 小时以内的。
- 同一条目同时最多一个活跃任务；同一仓库同时最多一个写入类任务。

**派发**：节点调用领任务接口时，control 在一个 SQLite 事务里完成：

1. 过滤：任务处于 `queued`，`eligible_at` 已到，所在范围没有暂停；执行器类别有空闲槽位；任务需要的标签是节点标签的子集；节点不在任务的 `excluded_nodes` 里；满足信任等级。
2. 排序后取第一个，写入租约和 epoch。

**信任等级**：节点分 `high` 和 `standard`，新加入的节点默认 `standard`。私有仓库的任务默认只派给 `high` 节点（`GEEK_BOT_PRIVATE_REPO_MIN_TRUST`）；节点的信任等级只有 owner 能改。私有代码会随任务流到节点主机和模型网关，信任等级配错就会把私有代码派给不受信的节点。

多节点阶段再加入软亲和（仓库代码缓存命中）排序（#19）。

**失败**：

- 基础设施失败（节点失联、VM 起不来、任务包校验失败、runner 崩溃、租约未确认）：换节点重排，最多 2 次（`GEEK_BOT_INFRA_RETRY_MAX`），之后判失败。
- 模型失败分两层：omp 进程内用 `retry.fallbackChains` 处理瞬时错误；本轮已有输出后才失败时，omp 以退出码 1 结束、不会自己降级，这时 runner 按池换下一个模型从头重跑（修复任务重跑前先 `git reset --hard && git clean -fdx`）。超时也换下一个模型，但整个任务的总墙钟不超过单次上限的 2 倍。上下文溢出和主动取消不降级。
- 池走完即判失败，不自动重试，由人点「重新排队」。
- 结果不符合 schema：用同一个模型带修复提示重跑一次，仍不合格就按池降级。
- PR 审查最终失败时，可选在 PR 上发一条「自动审查未完成」的 COMMENT，默认关闭。

**暂停**：

- 四个范围：全局、通道、仓库、节点（节点的暂停就是 cordon）。暂停只影响派发，已经在跑的任务不中途冻结。
- 「暂停全部写入」是单独的开关。operator 和 owner 都能暂停，只有 owner 能恢复，恢复要重新认证（S-09）。以下情况自动触发：机器人令牌 401、scope 变化、二级限额连续命中 3 次。401 或 scope 变化触发的，要先重新绑定机器人账号、新令牌校验通过（ADR-0002）；二级限额触发的熔断和人工暂停，由 owner 重新认证后恢复。
- 遇到二级限额时至少等 1 分钟再按指数退避重试；权限不足的 403 和限额 403 分开处理，前者不计入熔断。

涉及：[ADR-0003](../decisions/0003-single-writer-control.md)、[ADR-0004](../decisions/0004-execution-isolation.md)、[ADR-0006](../decisions/0006-model-catalog-relay.md)。实现：#8（轮询、入队、优先级、暂停）、#11（租约与派发）、#14（外层降级）、#19（多节点、信任等级与接管）。

## 10. 执行与隔离

**issue 通道 sandbox**：

- 每个槽位一个独立容器，不与 node 进程同容器：node 进程去掉了全部 capability，切换不了 uid；同一容器里的进程还能读到节点令牌。
- 容器配置：`network_mode: none`、根只读、tmpfs 工作目录、去掉全部 capability、`no-new-privileges`、非 root，限制内存、CPU 和进程数，不挂任何令牌文件。
- 通过共享卷里的 unix socket 访问节点的任务端点（[节点协议](../services/node/protocol.md)「sandbox 与 VM 怎样访问节点」）。
- omp 只给 `read,grep,glob`，不给 bash，不执行仓库代码。
- 每个任务结束后容器退出，由 restart 策略重建，清空状态。

**PR 通道 VM**（以 #12 的实测结论为准；不通过时依次退到 passt 或宿主 incus，见 ADR-0004）：

- node 容器里的 qemu，每个任务一台：`-enable-kvm`，默认 1 vCPU / 2 GiB（`GEEK_BOT_VM_VCPUS`、`GEEK_BOT_VM_MEMORY_MIB`），qcow2 overlay 叠在只读基础镜像上；`-sandbox on,obsolete=deny,elevateprivileges=deny,resourcecontrol=deny`（不能禁 spawn，guestfwd 要起进程）。任务结束删除 overlay 和磁盘。
- 网络用 QEMU 用户态网络的受限模式（`restrict=on`），来宾访问不到宿主和外网，只加两条 guestfwd：一条到本地模型代理，一条到出网 CONNECT 代理。
- 任务输入是只读原始盘上的 tar，产物写到可写原始盘上的 tar，实时事件走 virtio-serial，减少对 guestfwd「每个连接起一个进程」的依赖。
- 任务令牌经 `-fw_cfg name=opt/geekbot/token,file=<0600 临时文件>` 传入，不进 qemu 的命令行参数；VM 起来后删除临时文件。
- 出网代理：默认只放包管理源，**不放** GitHub 的域名，免得 VM 直接把代码推到 GitHub；域名解析后拒绝私网、CGNAT、链路本地、回环等地址段（含 IPv6），以及部署者配置的组网网段，只连接校验过的那次解析结果；每个任务限制连接数和字节数。GitHub 域名清单和拒绝的地址段以 [SECURITY](SECURITY.md) S-14 为准。白名单只能限制从哪里下载，挡不住借允许的包源把代码外传（见第 16 节）。全局白名单只能由 owner 重新认证后扩大，仓库层只能缩小。
- 依赖缓存：每个节点维护只读的包管理器缓存盘，按锁文件哈希预热，只读挂进 VM，减少每个任务重新下载。效果未验证，由 #12 实测。
- VM 基础镜像：优先在 CI 用钉死的输入（cloud 镜像 URL 加 sha512、Node 22、pnpm、git、按官方校验和校验的 omp、runner）构建，装进 `geek-bot-vmimage` 载体镜像推到 ghcr。实测 CI 构建不可行时，退回节点本地构建。
- VM 与 sandbox 里是干净的 HOME：宿主的用户级规则曾经漏进 omp 的回复，所以不能继承宿主 HOME。
- omp 参数：`--no-extensions`、`--no-lsp`、`--tools` 白名单、`--approval-mode yolo`；overlay 关闭更新检查、memory、web_search、github、browser 工具，并设 `mcp.enableProjectConfig:false`。任务包剔除仓库里的 `.omp/`、`.claude/`、`.cursor/`、`mcp.json`、`.env*`。
- VM 里没有任何 GitHub 凭据。修复结果以补丁带回，由 control 提交和推送。

**node 容器**：非 root；`devices: /dev/kvm` 加 `group_add` 宿主 kvm 组的 gid；去掉全部 capability；不挂 docker.sock，不挂其它虚拟化管理 socket，不用 privileged。各主机 `/dev/kvm` 的权限不一样，不能假设它对所有人可读写。

control 永远不运行 omp，也不执行目标仓库里的任何代码。

涉及：[ADR-0004](../decisions/0004-execution-isolation.md)。实现：#12（VM 可行性实测）、#14（sandbox 与 runner）、#17（VM 执行器、出网代理、基础镜像）。

## 11. GitHub 写入

publisher 是 control 里唯一的 GitHub 写入方，默认拒绝，按方法、路径、参数逐项校验。允许了哪些写入、每一条的参数约束和前置核对、必须有拒绝用例的越权写入，以 [write-whitelist](../services/control/write-whitelist.md) 的允许清单（W 编号）和拒绝清单（D 编号）为准，每一条都对应 #9 的测试；本节只概括，不另列一份。

- 允许的写入大致是这几类：只发 `COMMENT` 的 PR review（`commit_id` 等于任务的 head）；issue 与 PR 上的记录评论，以及修改机器人自己发的、带标记的评论；增删和创建受管标签；按状态机条件关闭 issue（只关 issue、不关 PR，人重开过的不关，关闭前先发记录）；为改写新开 issue；推新的机器人分支和返工时追加推送（只快进、不带 tag）；从机器人分支开 PR（结论段固定写阻塞）；由 owner 在后台点击接受协作邀请；吊销登录、重新认证、换绑时产生的单枚 OAuth 令牌。
- 合并、批准、请求修改、改别人的 PR 或评论、推默认分支和长期分支、推 tag、强推、删分支或标签、改 `.github/workflows/**`、releases、提交状态与检查、仓库设置、webhook、成员管理等写入一律拒绝。

**git push 的执行**（细节以 write-whitelist 的 W-10、W-12 与 [SECURITY](SECURITY.md) S-06 为准）：

- 在 control 的一个非镜像的工作克隆里、按显式 URL 推送；`core.hooksPath=/dev/null`，不递归 submodule，不开 LFS；令牌只通过 `GIT_CONFIG_*` 环境变量注入 `http.extraHeader`，不进 URL、argv 和日志。
- 隔离 git 配置：`GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=/dev/null`；仓库配置里不许有 `push.followTags`、`remote.*.push`、`remote.*.mirror`。
- 用 `--no-follow-tags`（git 没有 `--no-tags` 这个推送选项，写了也挡不住 tag）；用 `--porcelain` 断言只更新了一个 ref，推送后用 ls-remote 再核对 `refs/tags/*` 没有变化。
- 新建分支用 `--force-with-lease=refs/heads/<分支>:`（期望值为空，表示这个 ref 必须还不存在），保证原子；返工只追加提交。

**输出中和**：删除模型文本里的 HTML 注释；中和机器可解析的串（例如「结论：通过」、`Closes #n`、`/approve`）；模型输出里的 @ 一律转义，机器人只会在自己的模板（追问、提醒、改写重开）里 @ 当前条目的作者；用密钥形态和已知令牌值打码，并限制长度。

**幂等与可恢复**：

- 每条写入（评论、review、新开的 issue、PR 正文）第一行是追踪记录头（仓库有自己的记录格式时照它的格式写），最后一行单独一行隐藏标记 `<!-- geek-bot v1 env=<env> kind=<kind> task=<id> sha=<head12> round=<n> -->`。`env=` 让同一个机器人账号在两个环境的写入互不混淆。
- outbox 状态：`pending → sending → sent → confirmed | failed | rejected | dry_run | unknown`。`unknown` 表示发出去了但结果未知，不盲目重发，先按标记查询 GitHub 再决定。
- 发送前再复核一次：head 没变、issue 没被人重开、权限仍然足够、写入没有被暂停。

**限速与环境隔离**：

- 令牌桶：每分钟 60 次、每小时 400 次，低于 GitHub 创建内容类请求的二级限额。同一仓库的写入串行；同一 PR 的两次审查至少间隔 5 分钟。
- 实例角色由 `GEEK_BOT_INSTANCE_ROLE`（`preview` 或 `production`）显式指定，没配就拒绝启动；不从别的配置推断。
- preview 实例在代码里强制只写配置的沙盒仓库，写沙盒以外的仓库一律拒绝并写审计；production 按排除名单跳过这些仓库，防止同一个账号在两个环境对同一仓库重复写入。preview 的沙盒名单和 production 的排除名单是两个变量，名字见 [behavior](../services/control/behavior.md)。

涉及：[ADR-0003](../decisions/0003-single-writer-control.md)、[ADR-0005](../decisions/0005-rules-from-base-branch.md)、[ADR-0008](../decisions/0008-sqlite-migrations-recovery.md)。实现：#9（publisher、白名单、中和、outbox、限速）、#15（审查）、#16（issue 写入）、#18（推送与开 PR）。

## 12. 模型

**目录**：只来自部署者挂载的只读 catalog 文件，不建模型表，不请求网关的 `/v1/models`。

- 文件契约（JSON Schema 放在 `@geek-bot/protocol`）：`{version, generatedAt, provider:{baseUrl, apiStyle:"openai"}, models:[{id, name, contextWindow, maxTokens, efforts?:string[], compat?:{...}}]}`。
- 网关地址由部署配置 `GEEK_BOT_MODEL_GATEWAY_URL` 固定（例如 `https://gateway.example.com/v1`），catalog 只提供模型列表；catalog 的 `baseUrl` 与配置不一致时拒绝加载并告警，免得改一个文件就把带密钥的请求引到别处。catalog 文件是不可信输入的来源之一，边界见 [SECURITY](SECURITY.md) 的信任边界表。
- 没有 `efforts` 的模型，思考档位只提供 `off`。
- 部署者按同一 schema 手写，或用自己的脚本生成；产品不内置任何具体模型，也不内置默认池内容。
- 网关密钥用 `*_FILE` 文件引用，只挂给 control。

**模型池**：

- 按任务类型分池：审查、分诊、跟进、修复、返工、规则画像。每项是 catalog 里的 id 加一个思考档位，越界的档位服务端拒绝保存。
- catalog 里消失的模型在后台标红，派发时跳过。
- 保存池配置时生成 omp 的 `modelRoles` 和 `fallbackChains`，并写审计。
- 每任务模型令牌：限定池内模型、请求数和 token 上限，租约结束即吊销，库里只存哈希。

**中继与降级**：

- sandbox 和 VM 的模型请求经节点的本地模型代理，再经 control 中继到网关；control 核对令牌与租约、模型是否在池里、预算、任务是否仍在运行，请求体按字段白名单放行（`n` 固定为 1、`max_tokens` 按剩余预算封顶、流式请求强制带用量统计，细节见 [节点协议](../services/node/protocol.md) N-09），通过后换成网关密钥流式转发。
- 降级两层：omp 进程内的 `fallbackChains`，加 runner 外层按池重跑（第 9 节）。每个请求的模型、HTTP 状态、耗时、用量由 control 中继记录；这份记录是降级记录里可信的一方，runner 报告的尝试只作对照。
- 某些模型经 catalog 定义后可能缺少多轮工具调用需要的兼容字段，导致降级链里的该项实际不可用；由 #13 用真实网关核对，兼容字段放在 catalog 的 `compat` 里。

涉及：[ADR-0006](../decisions/0006-model-catalog-relay.md)。实现：#13（catalog、模型池、每任务令牌、中继）、#14（外层降级与记录展示）。

## 13. 管理后台

Vue 3.5 + vue-router 4 + Tuffex 0.6.0 + Vite，版本钉死；构建产物打进 control 镜像同源托管，不另起 nginx。Tuffex 升级单独立项。

**硬性要求**：不用原生下拉框和复选框，不用 emoji，文案短而具体。所有来自 GitHub、omp、节点的文本都按纯文本渲染；只有审查预览用 TxMarkdownView，并显式净化。界面规则见 [DESIGN](../design/DESIGN.md)。

**页面**：

- 概览：节点、槽位、队列、今日审查、失败数、GitHub 剩余额度和写入预算、最近一次备份；趋势用 spark-chart（0.6.0 没有 timeseries-chart）。
- 队列：按排队、运行、待发布、完成、失败、取消分页签；操作有暂停、恢复、取消、重新排队、提到最前；危险操作经确认弹层，初始焦点在「取消」按钮上。
- 任务详情：实时输出、原始事件、模型尝试与降级时间线（来源分 runner 和中继）、待发布预览（dry-run 下标明「未发布」）。
- 未接的条目：每条写明原因和下次检查时间。
- 仓库：按所有者和组织分组；开关置灰时写明原因；规则来源、覆盖、画像确认；OAuth 限制提示；是否可被分配。
- 节点：状态、版本、槽位、主机健康曲线；添加（节点令牌只显示一次）、cordon、排空、重置令牌、移除。
- 模型池：拖拽和纯键盘重排，窄屏提供上移、下移按钮；档位用 Tuffex 选择器。
- 机器人账号：login、scope、令牌状态、各组织的访问状态；重新授权、解绑（解绑后全局只读）。
- 设置：轮询间隔、静默窗口、等回复天数与轮数、各类任务的时限、默认规范模板、出网白名单、写入模式。
- 告警与审计。

**实时性**：SSE `/api/v1/stream?topics=…`，支持 `Last-Event-ID`，每 15 秒发一次心跳注释；断线后退回每 5 秒轮询一次；失败时只在顶部显示提示，不整页换成错误页。事件类型见 [API](API.md)「SSE」。

**鉴权**：服务端按角色对每个 `/api/v1/*` 鉴权；入参都用 JSON Schema 声明并拒绝未知字段；错误、幂等、分页约定见 [API](API.md)。

涉及：[ADR-0009](../decisions/0009-tuffex-console.md)。实现：#4（外壳、状态组件、样板数据模式），各页面随 #5、#6、#8、#9、#10、#11、#13、#14、#16。

## 14. 数据

**存储**：SQLite（WAL、`synchronous=FULL`、`foreign_keys=ON`），库文件在 control 的命名卷里，只有 control 写。preview 和 production 各一个库。任务事件原文写在卷里的 `tasks/<id>/events.jsonl.gz`，保留 30 天，总量有上限；库里只存摘要。

**迁移**：`app/control/src/db/migrations/NNNN_*.sql` 按编号执行，执行后更新 `PRAGMA user_version`；**只扩不缩**（加表、加列、回填），不删表、不删列、不改列的类型或含义。迁移前自动备份。

**兼容版本**：库里除 `user_version` 外另记一个兼容版本，只有收缩类改动才抬高它。control 启动时只比较兼容版本：库的兼容版本高于代码能支持的版本才拒绝启动。只扩不缩的迁移不抬高兼容版本，所以上一版镜像打开新库仍能启动、能读写，按 digest 回滚不需要动库。每个迁移都要有「上一版代码能读写新库」的测试（#3）。

**表**：表清单、每张表的主键、归属和保留期见 [data-model](../services/control/data-model.md)。表名用 snake_case；令牌、会话、节点令牌、每任务模型令牌只存哈希或密文；审计日志只追加。

**备份**：

- 每天一次，另外在部署前、迁移前各一次。用 better-sqlite3 的在线 backup，之后加密并算 sha256；保留 7 份每日加 4 份每周。
- 每天自动把最新备份恢复到临时文件，跑 `PRAGMA integrity_check` 并核对行数。
- master key 不进备份；备份用单独的备份加密密钥（`*_FILE` 挂载），不和备份放在一起。可选的异地副本放在部署者指定的外置盘或网络存储目录，它的访问凭据同样按密钥管理（[SECURITY](SECURITY.md) 密钥表）。

**从 GitHub 重建**：库丢失又没有可用备份时，按写入最后一行的隐藏标记从 GitHub 重建追问轮次、已审的 head、关闭状态和机器人分支；有备份时先恢复备份，再按标记补齐备份之后的写入。管理员与会话、机器人令牌、节点登记与节点令牌、模型池、设置、审计日志重建不了，只能从备份恢复或重新配置。outbox 里的 `unknown` 同样按标记核对。

涉及：[ADR-0008](../decisions/0008-sqlite-migrations-recovery.md)。实现：#3（迁移、备份、恢复校验），#9（标记与 outbox），#20（备份保留、异地副本、恢复演练）。

## 15. 部署

**镜像**：`geek-bot-control`（内含 console）、`geek-bot-node`（内含 runner、omp、qemu、sandbox 入口）、`geek-bot-vmimage`。前两个以非 root 运行、带 HEALTHCHECK，由 CI 断言；基础镜像为 `node:22-bookworm-slim`。

**发布**（规则见 [RELEASES](../conventions/RELEASES.md)）：

- `vX.Y.Z-rc.N` tag 打在 stage 的提交上，触发 `release.yml`：核对 → 验证 → 构建一次 → 推 `ghcr.io/<owner>/geek-bot-*:<sha12>` 和 rc 别名 → 把 `release-manifest.json`（完整提交 SHA 与各镜像 digest）附到 Release。`release.yml` 只用 `GITHUB_TOKEN`，权限只给 `contents: read` 与 `packages: write`（做构建证明时再加 `id-token: write`、`attestations: write`，其余不给），不持有部署凭据。
- `vX.Y.Z` 打在已验收 rc 的同一提交上，不重新构建，只给同一 digest 加别名。正式环境运行的就是预发布验收过的那个 digest。
- 创建发布 tag 需要所有者授权；AI 不创建、不移动、不删除发布 tag。

**部署**：目标机没有入站端口，免费计划的私有仓库也没有 Environments，所以 CI 不部署。维护者获得所有者对这个版本、这个环境的授权后，在目标机运行仓库里的部署脚本（`deploy/remote/deploy-stack.sh --environment <env> --role control|node --version <tag>`），依次：

1. 用 flock 串行，同一环境同一时间只允许一次部署；
2. 校验 env 字段契约，以及密钥文件的权限和属主，不打印值；
3. 按发布清单里的 digest 拉取镜像；
4. 部署 control 前先备份数据库；
5. `docker compose --env-file .env.<env> -p geek-bot-<env> up -d`；
6. 健康门：`/readyz` 连续 3 次 200（就绪条件见 [API](API.md) A-54；回滚到旧镜像时库的迁移比代码新、兼容版本不高于代码，仍能通过）；有同机节点时，60 秒内要看到节点心跳；
7. 健康门不过，自动回滚到上一组 digest；
8. 追加一行部署历史。

- 部署 production 时，脚本先核对部署历史里 preview 验收过同一个 digest，没有就拒绝（#20）；不要求 preview 此刻还在运行（preview 栈平时关着）。
- 回滚脚本（`deploy/remote/rollback-stack.sh --to previous|<version>`）从部署历史查 digest 后切换，不动数据卷；靠第 14 节的兼容版本保证上一版镜像能打开新库。
- 运行仓库里有版本的部署脚本是唯一合法的变更路径；手工改容器或 compose 属于「手工修改运行中的栈」，禁止。AI 只有在每一次得到明确授权后才可以代为执行部署脚本，任何情况下不自行部署。
- 仓库私有期间，目标机用一枚只有 `read:packages` 的令牌登录 ghcr 拉取镜像，令牌只在宿主的 docker 配置里。

**环境**：production 和 preview 两套完全独立：compose 项目、网络、卷、端口、OAuth App、master key、会话签名密钥、备份加密密钥、节点令牌都各自一套；每套栈用 `GEEK_BOT_INSTANCE_ROLE` 声明自己是哪个环境。

- 机器人账号可以共用：GitHub 服务条款规定每人最多一个免费机器账号，但两个环境各有自己的 OAuth App 和令牌。
- preview 的 publisher 只能写沙盒仓库；preview 栈只在验收期间开启，平时 vm 槽位为 0。

**env 文件**：只有 `deploy/env/.env.production` 和 `deploy/env/.env.preview` 两份，节点字段也在里面。仓库里的模板只放占位符和通用默认值，实例的真实非密值只在目标机；密钥一律 `*_FILE`。

**主机前置条件**：每台主机需要的改动（compose 插件、镜像仓库登录、栈目录与 secrets 目录、数据卷位置、网络绑定等）写在 HOST-PREREQS（#7 写入），每一项都要所有者单独批准、可以回退。本文不写任何具体主机的情况。

release.yml、部署与回滚脚本、compose 与 env 模板都是计划中的。

涉及：[ADR-0007](../decisions/0007-ghcr-pull-deploy.md)。实现：#7（release.yml、部署脚本、预发布栈）、#20（正式上线与恢复）。

## 16. 密钥与残余风险

每个密钥放在哪、谁能读、泄露后果、如何轮换，见 [SECURITY](SECURITY.md) 的密钥表；安全不变量 S-01 起逐条见同一篇。

残余风险逐条见 [SECURITY](SECURITY.md) 的残余风险表；与架构取舍直接相关的几条：

- OAuth `repo` scope 不能按仓库收窄，免费计划的私有仓库没有分支保护和 rulesets；「不推主干、不打 tag、不强推、不合并」完全依赖 publisher 代码。令牌对任何公开仓库也能写、也能触发 `workflow_dispatch`；机器人账号被封没有替补，服务条款只允许一个免费机器账号。
- 公开仓库里任何人都能开 issue、评论、提 PR，也就能驱动机器人。缓解：返工只认 `author_association` 为 OWNER、MEMBER、COLLABORATOR 的审查意见；「什么算回复」保留所有者原规则（非机器人评论或作者改正文），另有配置项 `followup.reply_from`（默认 `any_human`，可改为 `author_and_members`），见 [behavior](../services/control/behavior.md)。
- viewer 能看到机器人能读的私有仓库内容，不按被邀请人自己在 GitHub 上的权限过滤；邀请时后台提示（A-10）。按被邀请人的 GitHub 权限过滤列为以后的改进。
- 出网白名单只能限制从哪里下载，挡不住借允许的包源把代码外传。
- 同路径、同内容的文件已在其它分支存在时，修改 workflow 不需要 `workflow` scope，只能靠 publisher 拒绝触及 `.github/workflows/**` 的补丁。
- 提示注入可能产生误导性的审查评论；中和只能去掉可解析的机器指令，审查评论在发出前没有人工把关。
- qemu 或 KVM 逃逸。
- 控制面是单点，并且持有全部密钥：宕机期间机器人停摆（节点上的任务不丢），control 主机被攻陷等于机器人账号被接管。
- 私网明文 HTTP 模式的保密性依赖组网本身的加密。
- 私有仓库的代码会随任务流到节点主机和模型网关；数据外流的边界由部署者负责，信任等级配错会把私有代码派给不受信的节点。
- preview 与 production 共用一个机器人账号，只靠沙盒仓库白名单互斥；配置出错会在真实仓库重复写入。
- 机器人推分支会触发目标仓库的 CI，消耗对方的 Actions 额度。
- 机器人修 geek_bot 自己的仓库时，可能改到 publisher、密钥、部署、`.github` 这些保护自身的代码；这些路径默认列为禁改，并且始终由人审查。

涉及：[ADR-0002](../decisions/0002-github-identity.md)、[ADR-0003](../decisions/0003-single-writer-control.md)、[ADR-0004](../decisions/0004-execution-isolation.md)。实现：#9（白名单与拒绝测试）、#21（公开前核对）。

## 17. 与本仓库开发规范的关系

本仓库的开发流程（单一 agent 入口、docs 分类与状态词表、`app/<name>` 与 `docs/services/<name>` 成对、两条长期分支、task 分支加 worktree、issue 先行、SemVer tag 发版、只用 Docker、密钥不入库、证据门禁）来源见 [ADR-0001](../decisions/0001-standalone-product.md)。产品架构有意偏离的几处各有 ADR：

- 镜像只构建一次，跨环境用同一个 digest；拉取式部署，没有部署工作流（ADR-0007）；
- env 模板只放占位符和通用默认值，密钥用 `*_FILE`（ADR-0001）；
- 数据库用版本化迁移（ADR-0008）；
- console 由 control 同源托管（ADR-0009）；
- 新增 `packages/protocol` 作为唯一共享契约包，新增公开安全检查（ADR-0001）。
