# 后台 API

> control 给管理后台的 HTTP 接口：路径、格式、会话与 CSRF、角色、校验、错误、幂等、分页、SSE 的约定，以及端点表 A-01…。

状态：`proposed` · 更新：2026-09-26 · 适用：`app/control` 的 `/api/v1/*`、`/healthz`、`/readyz`、`/api/release`，调用它们的 `app/console`，`packages/protocol` 里的 console API DTO（由 #3–#20 实现，每个端点的实现 issue 见端点表）

本文是设计。已经实现的只有 A-53 `/healthz`、A-54 `/readyz`（#3），以及「错误格式」里的通用形状、未知路径 404、`X-Request-Id`、请求体 64 KB 上限、非 JSON 请求体 415、Ajv 不删多余字段（#3，`app/control/src/app.ts`）；其余端点都还没有实现。实现以后，接口的来源是代码：control 各路由模块的 `contracts.ts`（入参与出参的 JSON Schema）和 `@geek-bot/protocol` 的 DTO 类型；本文与代码不符时，在同一次改动里改文档（[DOCUMENTATION](../conventions/DOCUMENTATION.md)「同步规则」）。

节点使用的 `/api/node/v1/*` 不在本文，见 [节点协议](../services/node/protocol.md)。整体设计见 [ARCHITECTURE](ARCHITECTURE.md)，安全不变量见 [SECURITY](SECURITY.md)。

## 约定

### 路径与格式

- 后台 API 的路径前缀是 `/api/v1`。例外只有三个：`/healthz`、`/readyz`（健康检查）和 `/api/release`（版本）。前缀里的 `v1` 只在出现不兼容改动时提升；新增端点和新增响应字段不提升。
- 请求与响应都是 JSON（UTF-8）。带请求体的请求必须写 `Content-Type: application/json`，否则返回 415。请求体上限 64 KB，超出返回 413。
- 字段名用 snake_case。时间用 ISO 8601 的 UTC 字符串（例 `2026-09-26T08:00:00Z`）；时长用整数秒，字段名以 `_s` 结尾。GitHub 的数字 id 用 JSON 整数；control 自己生成的 id（任务、节点、告警、outbox 项）在 JSON 里一律是字符串，不管库里怎么存，客户端当作不透明的值，不做运算和比较大小。
- 列表响应统一是 `{ "items": [...], "next_cursor": "…" | null }`（见「分页」）。
- 来自 GitHub、omp、节点的文本按原样作为字符串返回，已经过打码；console 一律按纯文本渲染（[SECURITY](SECURITY.md) S-05）。
- 响应里永远没有机器人令牌、会话 id、每任务模型令牌、master key、网关密钥和其它密钥。节点令牌只出现在生成它的那一次响应里（A-38、A-43，带 `Cache-Control: no-store`），之后任何端点都不再返回它的明文。
- 每个响应带 `X-Request-Id`，与服务端日志对应；报错时把它告诉维护者即可，不需要复制请求内容。

### 会话与 CSRF

- 会话 cookie 名 `gb_session`，值是 256 位随机数，另带会话签名密钥的 HMAC；库里只存随机数的 SHA-256，先验签再查库（[SECURITY](SECURITY.md) S-09）。属性：`HttpOnly`、`SameSite=Strict`、`Path=/`；`GEEK_BOT_PUBLIC_ORIGIN` 是 https 时加 `Secure`。只有显式设置了 `GEEK_BOT_ALLOW_PLAINTEXT_MESH=true` 的私网明文模式才不加 `Secure`，这时后台常驻「非安全上下文」提示。这两个是部署环境变量，随 #7 写进 ENVIRONMENTS。
- 会话空闲 2 小时过期，最长 12 小时；登出删除库里的会话行。移除管理员时，他的全部会话同时失效。
- 登录过程中用到两个短期 cookie：
  - `gb_claim`：认领码通过后 15 分钟内有效，只允许发起认领用的 device flow；`HttpOnly`、`SameSite=Strict`。
  - `gb_flow`：把一次 device flow 或 web flow 绑定到发起它的浏览器，别的浏览器拿到 `flow_id` 也用不了；`HttpOnly`、`SameSite=Lax`，因为 web flow 的回调是 GitHub 发起的跨站顶层跳转，Strict 的 cookie 带不回来。
- 所有非 GET、HEAD 的请求（包括不需要登录的认领和登录请求）都做 CSRF 检查，任何一项不满足都返回 403 `csrf_rejected`：
  1. 必须带 `Origin` 头，并且等于实例的 origin；缺少 `Origin` 也拒绝；
  2. 带了 `Sec-Fetch-Site` 时，值必须是 `same-origin`；
  3. `Content-Type` 必须是 `application/json`（见上），这样普通表单提交发不出合法请求。
- 实例的 origin：监听非回环地址时必须配置 `GEEK_BOT_PUBLIC_ORIGIN`，没配就拒绝启动；只监听回环地址时取回环地址对应的 origin。每个请求都校验 `Host` 头与 origin 一致。在反代后面时要配置可信代理，只有来自可信代理的 `X-Forwarded-*` 头才被采信（部署环境变量，随 #7 写进 ENVIRONMENTS）。
- GET 请求不改变状态，所以 SSE 和列表查询只校验会话。唯一的例外是 web flow 的回调 A-06：它必须是 GitHub 跳转回来的 GET，靠 `state`、PKCE 和 `gb_flow` 三者一起核对。
- **重新认证**：高危操作只归 owner，并要求当前会话在 10 分钟内重新认证过，否则返回 403 `reauth_required`；清单见 [SECURITY](SECURITY.md) S-09，本文不另列。重新认证只走 device flow：用 A-03（`purpose: "reauth"`）申请空 scope，control 核对 GitHub 数字 id 与会话相同，记下时间，然后立即吊销这一枚令牌。端点表里标「（重新认证）」的就是 S-09 覆盖的端点。

### 角色与鉴权

角色有三个，与 [ADR-0002](../decisions/0002-github-identity.md) 和 [data-model](../services/control/data-model.md) 的 `admins.role` 一致：

- `owner`：认领实例的账号，默认路径下它同时是机器人账号；拥有全部权限。
- `operator`：owner 按 GitHub 数字 id 邀请；做日常操作。
- `viewer`：owner 按 GitHub 数字 id 邀请；只读。viewer 能看到机器人读到的私有仓库内容，不按他自己在 GitHub 上的权限过滤（见 A-10）。

每个端点在路由的 `contracts.ts` 里声明需要的角色，由服务端检查；不以按钮是否显示为准。没有会话返回 401 `unauthenticated`，角色不够返回 403 `forbidden`。

| 操作类别 | owner | operator | viewer |
|---|---|---|---|
| 查看：全部 GET 端点与 SSE、登出 | 可以 | 可以 | 可以 |
| 日常操作：暂停与恢复派发（全局、通道、仓库）、暂停全部写入（不能恢复）、取消、重新排队、提到最前、开关仓库的「监控」、关掉仓库的任何开关、调低写入模式、cordon、解除 cordon、排空节点、改模型池、确认告警、立即校验机器人令牌 | 可以 | 可以 | 不可以 |
| 身份：邀请或移除管理员；绑定、重新授权或解绑机器人账号 | 可以 | 不可以 | 不可以 |
| 开启写入：打开任何写入类开关（「审查 PR」「受理 issue」「自动修复」「返工」）、调高写入模式（包括关闭 dry-run）、改仓库覆盖、确认规则画像、接受协作邀请、恢复被暂停的写入 | 可以 | 不可以 | 不可以 |
| 节点令牌与节点属性：登记节点并生成节点令牌、重置令牌、改节点的标签、槽位与信任等级、移除节点 | 可以 | 不可以 | 不可以 |
| 设置：全部设置项，包括出网白名单 | 可以 | 不可以 | 不可以 |

需要重新认证的操作都在上表 owner 独有的几行里，清单见 [SECURITY](SECURITY.md) S-09。

实例还没被认领时，除 A-01 至 A-04、健康检查和版本接口以外，所有端点返回 409 `not_claimed`。

### 入参校验

- 每个端点的 body、querystring、params 都在路由的 `contracts.ts` 里用 JSON Schema 声明：对象一律 `additionalProperties: false`，字符串有 `maxLength`，数组有 `maxItems`，取值有限的字段用 `enum`。
- **未知字段拒绝，不静默丢弃。** Fastify 默认的 Ajv 配置是 `removeAdditional: true`（遇到 `additionalProperties: false` 时删掉多余字段而不是报错），并对类型做强制转换（`coerceTypes: "array"`）。control 必须把 `removeAdditional` 设为 `false`，并对 body 关闭类型强制转换，使多余字段和类型不符返回 400 `validation_failed`；`allErrors` 保持 `false`（官方文档说明打开它有拒绝服务风险）。来源：Fastify「Validation and Serialization」（[REFERENCES](../conventions/REFERENCES.md)），2026-09-26 核对。
- 响应也声明 JSON Schema，作为序列化白名单：没声明的字段不会出现在响应里，防止把库里的密文列、哈希列带出去。
- 格式合法但业务上不成立的值（例如模型不在 catalog 里、档位不被模型支持、槽位超过节点声明的上限）返回 422，`code` 写明原因。

### 错误格式

所有错误都是同一个形状，只有这两个字段：

```json
{ "error": { "code": "validation_failed", "message": "请求体里有不认识的字段：/labels/0/color" } }
```

- `code` 是稳定的 snake_case 标识，console 按它分支；`message` 是给人看的中文说明，可以改写，不能拿来做判断。
- `message` 不含密钥、令牌、堆栈、SQL、内部文件路径，也不回显请求体里的原始值（字段路径可以写）。
- 通用状态码与 `code`：

| HTTP | `code` | 何时返回 |
|---|---|---|
| 400 | `invalid_json` | 请求体不是合法 JSON |
| 400 | `validation_failed` | 不符合 JSON Schema，包括未知字段、类型不符、越界 |
| 401 | `unauthenticated` | 没有会话、会话过期或已被删除 |
| 403 | `forbidden` | 角色不够 |
| 403 | `reauth_required` | 高危操作，10 分钟内没有重新认证 |
| 403 | `csrf_rejected` | 写请求缺 `Origin`、`Origin` 不符，或 `Sec-Fetch-Site` 不是 `same-origin` |
| 404 | `not_found` | 资源或路由不存在 |
| 409 | `invalid_state` | 当前状态不允许这个动作（例如取消已完成的任务） |
| 409 | 端点表里列出的专用 `code` | 例如 `not_claimed`、`capability_unavailable`、`secret_already_issued` |
| 412 | `revision_mismatch` | `If-Match` 与当前版本不符 |
| 413 | `payload_too_large` | 请求体超过上限 |
| 415 | `unsupported_media_type` | 带请求体但不是 `application/json` |
| 422 | 端点表里列出的专用 `code` | 业务值不成立 |
| 428 | `revision_required` | 要求 `If-Match` 的端点没有带 |
| 429 | `rate_limited` | 超过限速；带 `Retry-After` |
| 500 | `internal_error` | 未预期的错误；只写「内部错误」和请求 id |
| 503 | `not_ready` | control 正在启动、迁移或数据库不可用 |

### 幂等

- GET、HEAD 没有副作用，可以随意重试。
- **状态切换类**（暂停、恢复、取消、cordon、解除 cordon、排空、确认告警、开关某个仓库开关）按目标状态幂等：已经处于目标状态时返回 200 和当前状态，不重复写审计；当前状态到不了目标状态时返回 409 `invalid_state`。
- **创建类**（邀请管理员、重新排队、接受协作邀请、登记节点、重置节点令牌）接受 `Idempotency-Key` 头（1 到 64 个字符，`[A-Za-z0-9_-]`）。control 按「会话账号 + 路由 + key」保存第一次的响应 24 小时，同一个 key 重放时返回同样的状态码和响应体；同一个 key 配不同的请求体返回 409 `idempotency_key_reused`。**会返回一次性密钥的端点（A-38、A-43）重放时不再给出密钥**，返回 409 `secret_already_issued`，也不会生成第二枚。
- **配置更新类**（仓库开关、仓库覆盖、模型池、设置、节点属性）用乐观并发：GET 响应带 `ETag: "<revision>"`，PUT、PATCH 必须带 `If-Match`；不符返回 412 `revision_mismatch`，没带返回 428 `revision_required`。这样两个管理员同时改不会互相覆盖。
- 对 GitHub 的写入（例如接受协作邀请）只经 publisher 的 outbox，由 outbox 的去重键保证不重复写；API 层的幂等只保证不重复入队。

### 分页

- 列表端点用游标分页：`limit`（1 到 200，默认 50）和 `cursor`（上一页响应里的 `next_cursor`，不透明字符串，不要自己拼）。最后一页 `next_cursor` 为 `null`。
- 每个列表端点的排序是固定的（端点表写明），游标只在同一个排序和同一组过滤条件下有效；换了过滤条件拿旧游标返回 400 `validation_failed`。
- 不返回总条数；概览页需要的计数由 A-35 单独给出。

### 限速

- 认领和登录端点按来源地址限速；同一个认领码连续输错 5 次即作废，要在目标机重新生成。
- 其它端点按会话限速，超过返回 429 `rate_limited` 并带 `Retry-After`。具体额度由 #3 定并写回本文。

### SSE

- 端点：`GET /api/v1/stream?topics=<逗号分隔>`（A-56），用会话 cookie 鉴权。响应 `Content-Type: text/event-stream`，并带 `Cache-Control: no-cache` 和 `X-Accel-Buffering: no`；前面有反代时，还要在反代上对这个路径关闭缓冲。
- `topics` 取值：`overview`、`queue`、`nodes`、`repos`、`alerts`、`task:<task_id>`；每个连接最多 20 个；不认识的 topic 返回 400 `validation_failed`。
- 每个事件有 `id:`（实例内单调递增的整数）、`event:`（类型）和 `data:`（一行 JSON）。断线重连时浏览器带 `Last-Event-ID`，control 从内存里的环形缓冲补发之后的事件；缓冲默认保留最近 10 分钟，超出范围时发一个 `reset` 事件，console 收到后重新拉取当前页的数据。
- 连接建立时先发 `retry: 5000`；每 15 秒发一行心跳注释 `: ping`。会话过期时发 `session_expired` 事件后关闭连接。
- console 断线后退回每 5 秒轮询一次对应的 GET 端点，恢复后再切回 SSE；失败时只在顶部显示提示。
- 事件里的文本已经过打码，按纯文本渲染。

| 事件类型 | topic | `data` 要点 |
|---|---|---|
| `overview.stats` | `overview` | 与 A-35 同形状的计数快照，最多每 5 秒一次 |
| `task.created` | `queue` | 任务摘要（同 A-27 的一项） |
| `task.updated` | `queue`、`task:<id>` | 任务 id、新状态、节点、epoch、失败原因分类 |
| `task.event` | `task:<id>` | 一批时间线行：`seq`、收到时间、类别（文本、工具、错误、重试、降级）、文本 |
| `task.attempt` | `task:<id>` | 一次模型尝试：来源（`runner` 或 `relay`）、模型、档位、HTTP 状态、耗时、用量、是否降级 |
| `publish.updated` | `queue`、`task:<id>` | outbox 项 id、状态（含 `dry_run`、`unknown`）、对应的白名单编号 |
| `node.updated` | `nodes`、`overview` | 节点 id、状态、有效槽位与占用、版本、协议版本 |
| `node.health` | `nodes` | 节点 id、一个健康采样点（每分钟最多一次） |
| `repo.updated` | `repos` | 仓库 id、权限、能力、开关、状态（含 `lost`） |
| `bot.status` | `overview` | 令牌状态、是否暂停全部写入及原因 |
| `alert.raised`、`alert.resolved` | `alerts`、`overview` | 告警 id、类别、级别、对象、说明 |
| `settings.updated` | `overview` | 改动的设置项名和新 revision（不含值） |
| `reset` | 全部 | 无；表示补发不了，需要重新拉取 |
| `session_expired` | 全部 | 无；随后连接关闭 |

## 端点表

角色一栏：「公开」表示不需要登录；「任一角色」表示 owner、operator、viewer 都可以；「（重新认证）」表示要求 10 分钟内重新认证过（清单见 [SECURITY](SECURITY.md) S-09）。列表端点都支持「分页」一节的 `limit` 与 `cursor`，下表不再重复。

### 登录与会话

| 编号 | 方法 | 路径 | 角色 | 请求要点 | 响应要点 | 实现 |
|---|---|---|---|---|---|---|
| A-01 | GET | `/api/v1/auth/state` | 公开 | 无 | `claimed`、可用的登录方式（`device`，https origin 时另有 `web`）、`insecure_context`、`bot_bound` | #5 |
| A-02 | POST | `/api/v1/auth/claim` | 公开，只在未认领时 | `code`（目标机 CLI `bootstrap-code` 打印的认领码，熵不低于 100 位） | 204，设置 `gb_claim`；码错 403 `claim_code_invalid`；已认领 409 `already_claimed` | #5 |
| A-03 | POST | `/api/v1/auth/device` | 公开（`claim` 要 `gb_claim`；`reauth` 要会话） | `purpose`：`claim`（申请 `repo read:org`）、`login` 与 `reauth`（申请空 scope）；`bot_reauthorize` 在这里一律拒绝（400），只能经 A-14 发起 | `flow_id`、`user_code`、`verification_uri`、`expires_in_s`、`interval_s`，并设置 `gb_flow`；`device_code` 只留在 control | #5 |
| A-04 | POST | `/api/v1/auth/device/{flow_id}/poll` | 发起该 flow 的浏览器（核对 `gb_flow`） | 无请求体；每次最多替浏览器向 GitHub 轮询一次，遵守 `interval_s` 和 `slow_down` | `status`：`pending`、`slow_down`、`expired`、`denied`、`done`；`done` 时按 `purpose` 建会话（`gb_session`）、记下重新认证时间或更新机器人令牌。机器人令牌的 scope 不是 {`repo`, `read:org`} 的子集 403 `scope_rejected`；不在管理员名单 403 `not_an_admin`（这枚令牌同样立即吊销）；重新授权换了账号 409 `bot_account_mismatch`。登录与重新认证拿到的令牌取完数字 id 就吊销 | #5 |
| A-05 | POST | `/api/v1/auth/web/start` | 公开，只在 `GEEK_BOT_PUBLIC_ORIGIN` 是 https 时注册 | 空对象；只用于登录（`purpose` 固定为 `login`），重新认证不走 web flow | `authorize_url`（带 `state` 与 PKCE S256 的 `code_challenge`，申请空 scope），并设置 `gb_flow`；console 再跳转过去 | #5 |
| A-06 | GET | `/api/v1/auth/web/callback` | 公开，同上 | GitHub 回传的 `code`、`state` | 先核对 `gb_flow`、`state` 与 PKCE，完成 flow 后才签发会话；吊销这枚登录令牌，302 回后台；失败 302 回登录页并带错误 `code`。响应带 `Referrer-Policy: no-referrer`，访问日志去掉查询串，`code` 不落日志 | #5 |
| A-07 | POST | `/api/v1/auth/logout` | 任一角色 | 空对象 | 204，删除会话 | #5 |
| A-08 | GET | `/api/v1/me` | 任一角色 | 无 | `github_id`、`login`、`role`、`is_bot_account`、`reauth_valid_until`、`session_expires_at` | #5 |

### 管理员与机器人账号

| 编号 | 方法 | 路径 | 角色 | 请求要点 | 响应要点 | 实现 |
|---|---|---|---|---|---|---|
| A-09 | GET | `/api/v1/admins` | 任一角色 | 无；按加入时间升序 | 每项：`github_id`、最近一次看到的 `login`、`role`、`invited_by`、`invited_at`、`last_login_at` | #5 |
| A-10 | POST | `/api/v1/admins` | owner（重新认证） | `github_id`（数字）、`role`（`operator` 或 `viewer`）、可选 `note`；`Idempotency-Key` | 201 新管理员；已在名单 409 `already_admin`。邀请界面提示：被邀请的人能看到机器人读到的私有仓库内容，不按他自己在 GitHub 上的权限过滤 | #5 |
| A-11 | DELETE | `/api/v1/admins/{github_id}` | owner | 无 | 204，并删除他的全部会话；不能移除 owner，409 `cannot_remove_owner` | #5 |
| A-12 | GET | `/api/v1/bot-account` | 任一角色 | 无 | `bound`、`github_id`、`login`、`scopes`、`token_status`（`valid`、`invalid`、`revoked`、`scope_changed`、`unknown`）、`last_verified_at`、`writes_paused` 与原因、各组织的 `access_state`（`ok`、`oauth_restricted`、`unknown`）；不含令牌 | #5、#6 |
| A-13 | POST | `/api/v1/bot-account/verify` | owner、operator | 空对象 | 立即用 `GET /user` 校验一次，返回与 A-12 同形状 | #5 |
| A-14 | POST | `/api/v1/bot-account/reauthorize` | owner（重新认证） | 空对象 | 发起 `purpose: "bot_reauthorize"` 的 device flow，响应同 A-03，之后用 A-04 轮询；新令牌必须属于同一个 GitHub 数字 id，成功后吊销旧令牌 | #5 |
| A-15 | DELETE | `/api/v1/bot-account` | owner（重新认证） | 无 | 204；吊销机器人令牌，全局进入只读 | #5 |
| A-16 | GET | `/api/v1/invitations` | 任一角色 | 无；按收到时间降序 | 机器人收到的待接受协作邀请：`invitation_id`、仓库全名、邀请人、权限、时间 | #6 |
| A-17 | POST | `/api/v1/invitations/{invitation_id}/accept` | owner（重新认证） | 空对象；`Idempotency-Key` | 202 与 `outbox_id`；由 publisher 按写入白名单接受 | #6、#9 |

### 仓库与规则

| 编号 | 方法 | 路径 | 角色 | 请求要点 | 响应要点 | 实现 |
|---|---|---|---|---|---|---|
| A-18 | GET | `/api/v1/repos` | 任一角色 | 过滤：`owner`、`state`（`active`、`lost`、`archived`）、`permission`、`switch`；按所有者、仓库名排序 | 每项：`repo_id`、`github_id`、`full_name`、`private`、`fork`、`archived`、`state`、`permission`、能力列表、`assignable`、开关、每个置灰开关的原因、`paused`、`last_polled_at` | #6 |
| A-19 | GET | `/api/v1/repos/{repo_id}` | 任一角色 | 无 | 在 A-18 的基础上加：组织 OAuth 限制提示、规则画像摘要、各开关的 revision（`ETag`） | #6、#10 |
| A-20 | PATCH | `/api/v1/repos/{repo_id}/switches` | owner、operator：operator 只能开关 `monitor`、关掉其它开关、调低写入模式；打开 `review`、`triage`、`fix`、`rework` 或调高写入模式只许 owner（重新认证） | `If-Match`；`monitor`、`review`、`triage`、`fix`、`rework`（布尔，对应 [behavior](../services/control/behavior.md) 的 `switches.*`）和 `write_mode`（`off`、`dry_run`、`on`）中的任意几项 | 新的开关与 revision；权限不够 409 `capability_unavailable`；超过全局写入模式上限 409 `write_mode_ceiling`；已归档或 `lost` 409 `repo_inactive` | #6（写入模式的执行随 #9） |
| A-21 | GET | `/api/v1/repos/{repo_id}/profile` | 任一角色 | 无 | 生效的 RepoProfile、每个字段的来源（仓库文件、后台覆盖、组织默认、内置默认）与 blob sha、待确认的建议字段、`ETag` | #10 |
| A-22 | PUT | `/api/v1/repos/{repo_id}/overrides` | owner（重新认证） | `If-Match`；后台覆盖的完整对象（字段见 RepoProfile） | 新的覆盖与 revision，以及和仓库文件、组织层合并后的生效值（能力开关和写入模式以后台为基准，其它层只能调低）；字段不认识 400 | #10 |
| A-23 | POST | `/api/v1/repos/{repo_id}/profile/confirm` | owner | `suggestion_revision` | 确认后的画像；建议已变化 409 `suggestion_outdated` | #10 |

### 队列与任务

| 编号 | 方法 | 路径 | 角色 | 请求要点 | 响应要点 | 实现 |
|---|---|---|---|---|---|---|
| A-24 | GET | `/api/v1/pauses` | 任一角色 | 无 | 全局、两条通道、各仓库的暂停状态；「暂停全部写入」的状态、原因、是否自动触发 | #8、#9 |
| A-25 | POST | `/api/v1/pauses` | owner、operator | `scope`（`global`、`channel`、`repo`、`writes`）、`target`（通道名或 `repo_id`；`global`、`writes` 不带）、可选 `reason` | 当前暂停状态；已暂停返回 200 不重复写 | #8、#9 |
| A-26 | POST | `/api/v1/pauses/resume` | owner、operator；`scope: "writes"` 只许 owner（重新认证） | 同 A-25 | 当前暂停状态。恢复写入：令牌 401 或 scope 变化触发的暂停，要先重新绑定机器人账号（A-14），新令牌校验通过前返回 409 `rebind_required`（ADR-0002）；人工暂停和二级限额熔断触发的，owner 重新认证后用本端点恢复 | #8、#9 |
| A-27 | GET | `/api/v1/tasks` | 任一角色 | 过滤：`state`（`queued`、`leased`、`running`、`cancelling`、`pending_publish`、`done`、`failed`、`cancelled`、`superseded`）、`channel`、`kind`、`repo_id`、`node_id`；排队中按派发顺序，其余按更新时间降序 | 每项：`task_id`、`kind`、`channel`、`priority` 与来由、仓库、条目（类型与编号）、`state`、`eligible_at`、`node_id`、尝试次数、时间 | #8 |
| A-28 | GET | `/api/v1/tasks/{task_id}` | 任一角色 | 无 | 任务详情：租约（节点、epoch、阶段）、模型尝试列表（来源 `runner` 或 `relay`）、结果摘要、失败分类与说明、待发布预览（dry-run 标「未发布」）、`excluded_nodes` | #8、#14 |
| A-29 | GET | `/api/v1/tasks/{task_id}/events` | 任一角色 | `after_seq`、`limit`（最多 1000）；按 `seq` 升序 | 已打码的时间线行：`seq`、收到时间、类别、文本；`next_after_seq` | #14 |
| A-30 | POST | `/api/v1/tasks/{task_id}/cancel` | owner、operator | 可选 `reason` | `queued` 的直接变 `cancelled`；`leased`、`running` 的变 `cancelling`，经节点命令（N-11）终止后变 `cancelled`；已经是 `cancelling` 返回 200；已结束 409 `invalid_state` | #8、#11 |
| A-31 | POST | `/api/v1/tasks/{task_id}/requeue` | owner、operator | 空对象；`Idempotency-Key` | 只对 `failed`、`cancelled` 有效：回到 `queued`，清零重试计数和 `excluded_nodes`，写审计；已在排队返回 200 | #8 |
| A-32 | POST | `/api/v1/tasks/{task_id}/prioritize` | owner、operator | 可选 `reason` | 在本通道内提到最前，写审计；不在排队中 409 `invalid_state` | #8 |
| A-33 | GET | `/api/v1/items` | 任一角色 | 过滤：`taken=false`、`repo_id`、`type`（`issue`、`pr`）；按下次检查时间升序 | 未接的条目：仓库、编号、标题、不接的原因（分给了人、`bot:manual`、已有关联 PR、仓库没开开关等）、`next_check_at` | #8 |
| A-34 | GET | `/api/v1/outbox` | 任一角色 | 过滤：`state`（`pending`、`sending`、`sent`、`confirmed`、`failed`、`rejected`、`dry_run`、`unknown`）、`repo_id`、`task_id`；按创建时间降序 | 每项：`outbox_id`、`task_id`、仓库、写入类别、对应的白名单编号、状态、中和后的预览文本、时间 | #9 |
| A-35 | GET | `/api/v1/overview` | 任一角色 | 无 | 节点数与状态、槽位占用、各状态任务数、今日审查数、失败数、GitHub 剩余额度与重置时间、写入预算、最近一次备份时间与结果 | #4（外壳）、#8、#11、#3 |

### 节点

| 编号 | 方法 | 路径 | 角色 | 请求要点 | 响应要点 | 实现 |
|---|---|---|---|---|---|---|
| A-36 | GET | `/api/v1/nodes` | 任一角色 | 过滤：`state`；按名称排序 | 每项：`node_id`、`name`、`state`（管理状态 `pending`、`cordoned`、`active`、`draining`、`disabled`；叠加的派生状态 `needs_upgrade`，以及按心跳推导的 `stale`、`offline`、`lost`）、版本、协议版本、标签、`trust`、每类槽位的声明上限、有效值与占用、`last_heartbeat_at`、健康摘要、VM 基础镜像 digest 与是否就绪 | #11 |
| A-37 | GET | `/api/v1/nodes/{node_id}` | 任一角色 | 可选 `health_window_s`（最长 7 天） | 在 A-36 的基础上加：每分钟一个点的健康采样、当前租约、最近一次自检结果、`ETag` | #11 |
| A-38 | POST | `/api/v1/nodes` | owner（重新认证） | 登记节点并生成节点令牌：`name`、`labels`、`trust`（`high`、`standard`，默认 `standard`）、`slots`（`sandbox`、`vm`）；`Idempotency-Key` | 201：`node_id`、`name`、`state: "pending"`、`node_token`（256 位，**只在这一次响应里出现**，库里只存 SHA-256）。运维把它写进节点宿主的令牌文件，节点经 `GEEK_BOT_NODE_TOKEN_FILE` 只读读取；节点用它第一次心跳后变 `cordoned`。响应带 `Cache-Control: no-store`。重放 409 `secret_already_issued`；名称已被占用 409 `node_name_taken` | #11 |
| A-39 | PATCH | `/api/v1/nodes/{node_id}` | owner；把 `trust` 调到 `high` 要重新认证 | `If-Match`；`labels`、`trust`、`slots` 中的任意几项 | 新的节点属性与 revision；槽位超过节点声明的上限 422 `slots_exceed_declared` | #11、#19 |
| A-40 | POST | `/api/v1/nodes/{node_id}/cordon` | owner、operator | 可选 `reason` | 节点状态；命令经下一次心跳送达节点 | #11 |
| A-41 | POST | `/api/v1/nodes/{node_id}/uncordon` | owner、operator | 空对象 | 节点状态；自检没通过 409 `self_check_failed`；健康门控未恢复 409 `health_gate_active`；需要升级 409 `protocol_unsupported` | #11 |
| A-42 | POST | `/api/v1/nodes/{node_id}/drain` | owner、operator | 可选 `reason` | 节点状态变 `draining`：运行中的任务做完，不再派新任务 | #11、#19 |
| A-43 | POST | `/api/v1/nodes/{node_id}/reset-token` | owner（重新认证） | 空对象；`Idempotency-Key` | 旧节点令牌立即失效（节点下一次请求得到 401）；该节点的租约全部收回、epoch 加一；节点回到 `pending`，保留节点 id；返回新的 `node_token`（只出现这一次），运维换掉节点上的令牌文件后重启节点；响应带 `Cache-Control: no-store`；重放 409 `secret_already_issued` | #11 |
| A-44 | DELETE | `/api/v1/nodes/{node_id}` | owner | 无 | 204；作废节点令牌，保留历史；对还没心跳过的 `pending` 节点，就是作废那枚还没用过的节点令牌；还有活动租约时 409 `node_busy`（先排空，或等它变成 `offline`、`lost`） | #11 |

### 模型、设置、告警、审计

| 编号 | 方法 | 路径 | 角色 | 请求要点 | 响应要点 | 实现 |
|---|---|---|---|---|---|---|
| A-45 | GET | `/api/v1/models/catalog` | 任一角色 | 无 | catalog 的 `version`、`generated_at`、`api_style`、模型列表（`id`、`name`、`context_window`、`max_tokens`、`efforts`）、读取时间、读取错误；catalog 的 `baseUrl` 与 `GEEK_BOT_MODEL_GATEWAY_URL` 不一致时拒绝加载，这里显示错误并告警。不返回网关地址和密钥 | #13 |
| A-46 | GET | `/api/v1/model-pools` | 任一角色 | 无 | 按任务类型的池（`review`、`triage`、`followup`、`fix`、`rework`、`profile`），每项 `model_id`、`effort`、是否仍在 catalog 里；`ETag` | #13 |
| A-47 | PUT | `/api/v1/model-pools/{pool}` | owner、operator | `If-Match`；`entries`：1 到 8 项 `{ model_id, effort }` | 新的池与 revision，写审计；模型不在 catalog 422 `model_not_in_catalog`；档位不被支持 422 `effort_not_supported`（没有 efforts 的模型只接受 `off`） | #13 |
| A-48 | GET | `/api/v1/settings` | 任一角色 | 无 | 每个设置项的当前值、来源（内置默认、环境变量、后台）、是否只读；`ETag`。设置项的名字、默认值、取值范围和作用范围以 [behavior](../services/control/behavior.md) 为准 | #3 起，各项随对应 issue |
| A-49 | PATCH | `/api/v1/settings` | owner；改出网白名单要重新认证 | `If-Match`；要改的设置项 | 新值与 revision，写审计；越界 400 `validation_failed`；只由环境变量决定的项（例如写入模式上限）409 `setting_locked` | #8、#16、#17 等 |
| A-50 | GET | `/api/v1/alerts` | 任一角色 | 过滤：`state`（`open`、`acked`、`resolved`）、`kind`；按触发时间降序 | 每项：`alert_id`、类别、级别、对象、说明、触发时间、确认人 | #3、#20 |
| A-51 | POST | `/api/v1/alerts/{alert_id}/ack` | owner、operator | 空对象 | 告警状态；已确认返回 200 | #3 |
| A-52 | GET | `/api/v1/audit` | 任一角色 | 过滤：`actor`、`action`、`target`、`since`；按 id 降序 | 每项：`id`、时间、操作者（GitHub 数字 id 与 login，或 `system`）、动作、对象、说明（不含密钥） | #3、#5 |

### 健康、版本与实时推送

| 编号 | 方法 | 路径 | 角色 | 请求要点 | 响应要点 | 实现 |
|---|---|---|---|---|---|---|
| A-53 | GET | `/healthz` | 公开 | 无 | 200 `{ "status": "ok" }`：进程活着就返回，不检查依赖 | #3 |
| A-54 | GET | `/readyz` | 公开 | 无 | 同时满足才返回 200：库可写；库的兼容版本 K ≤ 代码版本 C；已执行的迁移 D ≥ C（没有待执行的迁移）；必需的密钥文件可读。否则 503，列出没通过的检查项名称（不含路径和值）。catalog 没配置不算未就绪，只在后台状态里告警。回滚到旧镜像时 D > C、K ≤ C，健康门能过。部署脚本的健康门用它 | #3 |
| A-55 | GET | `/api/release` | 公开 | 无 | 展示值（正式 `X.Y.Z`、预发布 `X.Y.Z-rc.N@<sha12>`、本机「本地开发 · 未发布」）、`version`、完整提交 SHA、支持的节点协议版本范围；值由部署脚本写入运行时环境（[RELEASES](../conventions/RELEASES.md)「展示值与发布身份」） | #7（#3 没有实现：展示值的组合规则依赖只在 `scripts/release-tags.mjs` 实现的 tag 语法，见 [control 服务契约](../services/control/README.md)「已知限制」） |
| A-56 | GET | `/api/v1/stream` | 任一角色 | `topics`；可选 `Last-Event-ID` 头 | SSE 事件流，事件类型见「SSE」 | #14（客户端随 #4） |

## 节点 API

节点使用的 `/api/node/v1/*`（心跳与登记、领任务、续租、任务包、事件、产物、结果、释放、模型中继、命令）用 bearer 节点令牌认证，不用会话 cookie，逐条见 [节点协议](../services/node/protocol.md)。

## 验证（计划中）

- 每个端点至少有一个真实路由测试（Fastify inject）：正确路径、未登录 401、角色不够 403、缺 `Origin` 的写请求 403、未知字段 400、需要重新认证的端点在超时后 403（#3 起各 issue，见 [TESTING](../conventions/TESTING.md) 的回归矩阵）。
- 响应里没有令牌和密文列：对每个端点的响应做密钥形态扫描（#5）。
- console 的 DTO 与 `contracts.ts` 的 JSON Schema 一致，由 `@geek-bot/protocol` 的契约测试证明（#3 起；#4 先在 protocol 里加了 console 用到的类型）。
