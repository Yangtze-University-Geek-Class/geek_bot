# 后台 API

> control 的单实例共享平台 HTTP 接口：后台身份、连接、项目、需求、机器、任务、模型池和事件流。

状态：`current` · 更新：2026-10-03 · 适用：`app/control`、`app/console` 和 `packages/protocol`（#34）

## 来源与边界

接口来源是 `app/control/src/routes/platform/*/{index,contracts}.ts`、`platform/schemas.ts` 与 protocol 的 DTO。本文描述现有代码，不表示真实外部账号、预发布实例、生产实例或 Linux/KVM 已通过验收。

节点的出站接口在 [节点协议](../services/node/protocol.md)。产品范围和后台身份与渠道账号的分离见 [ADR-0012](../decisions/0012-shared-cross-platform-workspace.md)。旧的 `/repos`、`/nodes`、`/bot-account` 和 `/queue` 不保留别名。

## 公共约定

- 后台路径为 `/api/v1`；例外是 `/healthz`、`/readyz` 和 `/api/release`。JSON 字段用 snake_case，时间用 UTC ISO 8601。
- id 是不透明字符串。列表返回 `{items,next_cursor}`，`limit` 为 1～200，缺省 50；`cursor` 绑定当前资源、排序和过滤条件，条件改变必须重新从首页查询。
- 请求体只能是 JSON。body、params、query 的 schema 拒绝未知字段；`coerceTypes:false`，不会把字符串静默改为布尔或数组。查询里的数字先以受约束字符串校验，再由路由读取。
- 配置类 GET 带 `ETag:"<revision>"`。PATCH 带 `If-Match`；缺失返回 428 `revision_required`，陈旧返回 412 `revision_mismatch`。
- 创建、派发、重新排队、登记机器和重置令牌使用 `Idempotency-Key`。同一个键配不同 body 返回 409 `idempotency_key_reused`。一次性节点令牌不存幂等响应明文；重放返回 409 `secret_already_issued`，不再生成一枚。
- 所有响应带 `X-Request-Id`。错误只有 `{error:{code,message}}`，不返回堆栈、SQL、内部路径、凭据、密文或令牌哈希。

## 身份与权限

后台用 GitHub 数字 id 判断身份，不按可改名的 login。owner 是认领者，operator 可日常操作和关闭处理范围，viewer 只读。具体权限在各路由声明并由服务端拦截，按钮隐藏不能代替授权。

会话 cookie 是 `gb_session`：随机值带独立 session-secret 的 HMAC，库里只存 SHA-256。HttpOnly、SameSite=Strict，HTTPS 时 Secure；空闲 2 小时、最长 12 小时。独立会话密钥不能与 master 或 backup 共用或派生。

所有浏览器非 GET/HEAD 请求必须有正确 Origin，若带 Sec-Fetch-Site 必须为 same-origin；Host 必须与配置 origin 或受约束回环地址一致。缺失或不匹配返回 403 `csrf_rejected`。IM 回调与 node API 不用浏览器 cookie，走自己的签名或 bearer，但不放宽 Host。

打开逐类处理、提高写入模式、绑定凭据、邀请管理员、登记或重置节点令牌等高危操作只允许 owner，并要求 10 分钟内重新认证。临时登录令牌取完身份经 publisher 撤销；代码连接的 GitHub scope 只接受 `repo` 和 `read:org` 的子集。

## 登录与管理员

| 方法与路径 | 输入 | 结果与限制 |
|---|---|---|
| `GET /auth/state` | 无 | `claimed,login_methods,insecure_context,bot_bound`；无需会话 |
| `POST /auth/claim` | `code` | 204，设置 `gb_claim`；认领码来自目标机 `geek-bot bootstrap-code`，100 位熵、15 分钟、一次性 |
| `POST /auth/device` | `purpose:claim/login/reauth/connection`，connection 时加 `connection_id` | `flow_id,user_code,verification_uri,expires_in_s,interval_s`；设备码留在服务器，设置绑定浏览器的 `gb_flow` |
| `POST /auth/device/:flow_id/poll` | 空对象 | `pending/slow_down/expired/denied/done`；遵守轮询间隔，流程只归发起它的浏览器 |
| `POST /auth/logout` | 空对象 | 204，删除当前会话 |
| `GET /me` | 无 | `github_id,login,role,is_bot_account,reauth_valid_until,session_expires_at` |
| `GET /admins` | 列表参数 | 共享管理员名单 |
| `POST /admins` | `github_id,role:operator/viewer` | owner 重新认证、创建幂等；不允许再创建 owner |
| `DELETE /admins/:github_id` | 无 | owner 重新认证；不能移除 owner，移除使该账号的全部会话失效 |

当前只实现 device flow。web flow/PKCE 不注册空路由，也不以假的授权结果替代。

## 渠道连接

| 方法与路径 | 输入或结果 | 权限和数据 |
|---|---|---|
| `GET /connections` | 列表参数 | 返回公共连接记录，不返回 credentials |
| `POST /connections` | `provider,name,base_url,credentials?` | owner 重新认证、幂等创建；provider 为 github/gitlab/feishu/webhook |
| `GET /connections/:id` | 无 | 公共记录和 ETag |
| `PATCH /connections/:id` | `name?,base_url?,enabled?,credentials?` | If-Match；凭据只写，空字段不清掉原值；变更凭据、地址或重新启用需要 owner 重新认证 |
| `POST /connections/:id/discover` | 空对象 | operator 或 owner；`{discovered,lost}` |
| `POST /connections/:id/sync` | 空对象 | operator 或 owner；`{projects,items}` |
| `POST /connections/:id/disable` | 空对象 | operator 或 owner；停止后续读取、入站和写入，保留历史和密文 |

GitHub 经 connection-purpose device flow 绑定。GitLab 写入只接平台真实权限与令牌 scope 的交集；无法自省 scope 时不猜写权限。飞书凭据为 `app_id,app_secret,verification_token,encrypt_key?`；签名桥为 `signing_secret,webhook_url?`。所有凭据在 `connection_credentials` 以 AES-256-GCM 存储，仅读取适配器和 publisher 解密。

## 项目与平台条目

| 方法与路径 | 输入或结果 | 限制 |
|---|---|---|
| `GET /projects` | `connection_id?,search?` 和列表参数 | 根据连接与外部项目 id 稳定识别；失去访问记 lost |
| `GET /projects/:id` | 公共记录与 ETag | 权限、capabilities、归档状态、写入模式、四类开关、机器与标签 |
| `PATCH /projects/:id` | `enabled?,write_mode?,review_enabled?,triage_enabled?,fix_enabled?,rework_enabled?,machine_ids?,tags?` | If-Match；打开处理或提高模式只归 owner 重新认证；operator 可关闭 |
| `GET /projects/:id/items` | `kind:issue/change?` 和列表参数 | 返回来源、编号、标题、作者、head/base、服务器计算的 bot_authored 和 active_task |
| `POST /projects/:id/sync` | 空对象 | operator 或 owner；`{items}` |
| `POST /projects/:id/items/:item_id/dispatch` | `kind,executor,resources?,model_pool?` | operator 或 owner、幂等；条目必须属于项目，类别与开关、权限和状态匹配 |

新项目逐类开关全部 false、write_mode 为 off。空 machine_ids 表示全局池中满足约束的机器，不表示用户专属池。平台内容不选择发布目标；任务固定 project、item 和执行时的 head/base，新 head 作废旧结果。机器人自己的 change 不做 review，返工仍须本实例创建记录。

## 需求与消息入站

| 方法与路径 | 输入或结果 | 限制 |
|---|---|---|
| `GET /demands` | `status?,project_id?` 和列表参数 | 共享需求列表 |
| `POST /demands` | `title,body,project_id?` | operator 或 owner；幂等，项目可以稍后关联 |
| `GET /demands/:id` | 公共记录与 ETag | 来源、来源引用、关联项目、状态和 revision |
| `PATCH /demands/:id` | `title?,body?,project_id?` | If-Match；已排队或运行时不能换项目 |
| `POST /demands/:id/dispatch` | `kind,executor,resources?,model_pool?` | operator 或 owner；未关联项目 409 `project_required` |
| `POST /intake/feishu/:connection_id` | 飞书原始事件字节与请求头 | 连接必须启用；verification token，配置 Encrypt Key 时校验签名与解密，URL challenge 正常应答 |
| `POST /intake/webhook/:connection_id` | `event_id,title,body,source_ref?,project_id?` | HMAC-SHA256 覆盖 `timestamp + '.' + rawBody`，5 分钟窗口；事件 id 去重 |

IM HTTP 响应不等网络回传。事务提交后排入 `im_publications`，publisher 受写入模式和连接状态约束发送进展或结果；未知结果保留 unknown，不盲目重发。

## 机器与任务

| 方法与路径 | 输入或结果 | 限制 |
|---|---|---|
| `GET /machines` | 列表参数 | 状态、信任、标签、资源和槽位，不返回令牌 |
| `POST /machines` | `name,trust,tags,slots,capacity` | owner 重新认证；一次性 `{machine,node_token}`，no-store，重放拒绝 |
| `GET /machines/:id` | 公共记录与 ETag | 共享机器详情 |
| `PATCH /machines/:id` | 名称、信任、标签、槽位或容量 | If-Match，不能超过本机声明；信任提升需 owner 重新认证 |
| `POST /machines/:id/cordon` | 空对象 | operator 或 owner；停止领取新任务 |
| `POST /machines/:id/uncordon` | 空对象 | 自检、健康门、协议与联络状态必须满足；拒绝伪造健康缺省值 |
| `POST /machines/:id/drain` | 空对象 | 做完手头任务，不再领取 |
| `POST /machines/:id/reset-token` | 空对象 | owner 重新认证、一次性；立即作废旧令牌和租约 |
| `GET /tasks` | `status?,project_id?,demand_id?` 和列表参数 | 真实任务队列 |
| `GET /tasks/:id` | 任务详情 | 固定 head/base、资源、机器、epoch、结果和错误 |
| `GET /tasks/:id/events` | 列表参数 | 已打码事件按 seq 返回 |
| `POST /tasks/:id/cancel` | 空对象 | 排队直接取消；运行任务通知节点停止，旧结果受 epoch 拒绝 |
| `POST /tasks/:id/requeue` | 空对象 | 幂等；只有允许的结束状态能重新排队 |
| `POST /tasks/:id/publish` | 空对象 | 受控 publisher 再核对最新权限、head、开关、范围和凭据，不接受任意目标或端点 |

机器名与 node 使用同一规则：小写字母、数字和连字符，1～63 字符，首尾不能为连字符。没有真实自检证据或必需资源数据不会获得有效槽位；采集不到的可选温度、供电不编值，也不当作越线证明。

## 模型与实时事件

`GET /model-pools` 返回 `{catalog:{models,error},pools:[{kind,entries,revision}]}`。目录只读挂载文件；网关地址必须与部署配置相同，响应不带密钥。`PATCH /model-pools/:kind` 带 If-Match 与 `{entries:[{model,effort}]}`，1～8 项；池外模型或非法档位返回 422。

`GET /overview` 返回项目、需求、机器、连接和任务状态计数，数字来自数据库。

`GET /stream?topics=...` 是会话授权的 SSE。事件带 id，支持 Last-Event-ID 补发、超出缓存 reset、ping 与 session_expired。topic 与事件来源见 `platform/events.ts` 和 `platform/schemas.ts`。断线客户端退回轮询，不把断线伪装为空列表。

## 验证与未验证

本机真实 HTTP/SQLite 已验证来源发现、需求派发、资源租约、迟到结果 409、角色 403、一次性令牌重放 409和重启持久化。独立作者的权限、并发和栅栏回归通过；外部 API 使用隔离协议服务。

真实 GitHub/GitLab/飞书账号授权和外部写入、Linux/KVM、node/sandbox 镜像、硬件传感器以及线上环境验收均需相应条件后单独验证，不能用本页或单测代替。
