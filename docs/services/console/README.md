# console 服务契约（`app/console`）

> 管理后台：Vue 3.5 + vue-router 4 + Tuffex 0.6.0 + Vite 7 的单页应用，按项目、需求、机器管理共享执行平台，构建产物由 control 同源托管。

状态：`current` · 更新：2026-10-03 · 适用：`app/console`（`@geek-bot/console`）、`tests/console`、`tests/e2e`（#4 建外壳，#34 改成共享执行平台后台）

`current` 只表示本文与 `app/console` 的代码一致，不表示后台已在预发布或正式实例验收。已执行和没执行的验证见「#34 的验证记录」。

## 职责

- 给实例的管理员一个后台。主导航是项目、需求、机器；「运行」里是任务；「设置」里是渠道连接、模型池与管理员。另有登录页（认领实例、GitHub 登录）和重新认证弹层。
- 只调用 control 的 `/api/v1/*`、`/api/release` 和 SSE `/api/v1/stream`，请求同源、带 cookie。不直接访问 GitHub、GitLab、飞书、节点或模型网关。会话 cookie 是 HttpOnly，浏览器脚本拿不到任何令牌。
- console 不拥有数据。界面按角色置灰按钮只是提示，授权只在 control 服务端判断。
- 全部控件用 Tuffex；界面硬性规则只在 [DESIGN](../../design/DESIGN.md)「硬性规则」定义，Tuffex 的引入与版本规则见 [Tuffex 使用政策](../../components/tuffex/USAGE-POLICY.md)，本文不重复。

## 页面与路由

侧栏、窄屏抽屉和列表页路由都由 `src/shell/pages.ts` 的页面清单生成；详情页挂在列表页下，侧栏高亮所属列表页。`/` 跳到 `/projects`，未知地址显示「页面不存在」并提供「回到项目」。

| 分组 | 路由 | 页面文件 | 读取 |
|---|---|---|---|
| 无 | `/login` | `LoginPage.vue` | `GET /api/v1/auth/state` |
| 项目与需求 | `/projects` | `ProjectsPage.vue` | `GET /api/v1/projects`，筛选 `connection_id`、`search`；连接清单用于筛选与显示名称 |
| 项目与需求 | `/projects/:id` | `ProjectDetailPage.vue` | `GET /api/v1/projects/:id`（ETag）、`GET /:id/items`（筛选 `kind`，游标 `items_cursor`）、`GET /api/v1/machines`（机器分配的选项） |
| 项目与需求 | `/demands` | `DemandsPage.vue` | `GET /api/v1/demands`，筛选 `status`、`project_id` |
| 项目与需求 | `/demands/:id` | `DemandDetailPage.vue` | `GET /api/v1/demands/:id`（ETag）、`GET /api/v1/tasks?demand_id=`（游标 `tasks_cursor`） |
| 项目与需求 | `/machines` | `MachinesPage.vue` | `GET /api/v1/machines` |
| 项目与需求 | `/machines/:id` | `MachineDetailPage.vue` | `GET /api/v1/machines/:id`（ETag） |
| 运行 | `/tasks` | `TasksPage.vue` | `GET /api/v1/tasks`，筛选 `status`、`project_id`；`GET /api/v1/overview` 的排队中、运行中、待发布、失败四个计数，点计数切换状态筛选 |
| 运行 | `/tasks/:id` | `TaskDetailPage.vue` | `GET /api/v1/tasks/:id`、`GET /:id/events`（游标 `events_cursor`）；未结束时订阅 SSE `task:<id>` |
| 设置 | `/connections` | `ConnectionsPage.vue` | `GET /api/v1/connections` |
| 设置 | `/connections/:id` | `ConnectionDetailPage.vue` | `GET /api/v1/connections/:id`（ETag） |
| 设置 | `/model-pools` | `ModelPoolsPage.vue` | `GET /api/v1/model-pools`（各任务类型的池与 catalog 模型） |
| 设置 | `/admins` | `AdminsPage.vue` | `GET /api/v1/admins` |
| 无 | 其它地址 | `NotFoundPage.vue` | 无 |

进入任何非公开页面前，路由守卫先读一次 `/api/v1/me`。返回 401 或 409 `not_claimed` 时转到 `/login?redirect=<原地址>`；登录成功后只回到站内路径，不接受 `//` 开头和 `/login` 本身。

## 写操作

请求形状来自 control 的路由实现（`app/control/src/routes/platform/*/index.ts` 与同目录 `contracts.ts`）和 `packages/protocol/src/shared.ts` 的 DTO。下表「服务端权限」照抄路由的 `access` 与重新认证要求；「界面」一列是按钮在什么角色下可点，只是提示。

| 操作 | 请求 | 并发与幂等 | 先确认 | 服务端权限 | 界面 |
|---|---|---|---|---|---|
| 核对认领码 | `POST /api/v1/auth/claim`（`code`） | 无 | 否 | 公开，只在未认领时 | 公开 |
| 认领、登录、重新认证、绑定 GitHub 连接 | `POST /api/v1/auth/device`（`purpose`：`claim`、`login`、`reauth`、`connection`），再按 `interval_s` 轮询 `POST /api/v1/auth/device/:flow_id/poll`，`slow_down` 时加 5 秒 | 无 | 否 | `claim` 要先核对过认领码；`login` 公开，只有管理员名单里的账号能完成；`reauth` 要会话；`connection` 要所有者并在 10 分钟内重新认证过 | 绑定按钮只给所有者 |
| 退出登录 | `POST /api/v1/auth/logout` | 无 | 否 | 任一角色 | 顶栏 |
| 修改项目执行开关、写入模式、机器分配、标签 | `PATCH /api/v1/projects/:id` | `If-Match` | 调到真实写入或打开处理开关时确认 | 操作员；打开任一处理开关、调高写入模式要所有者并重新认证 | 操作员只能关闭处理开关，所有者可打开 |
| 同步项目条目 | `POST /api/v1/projects/:id/sync` | 无 | 否 | 操作员 | 操作员 |
| 按平台条目派发任务 | `POST /api/v1/projects/:id/items/:item_id/dispatch` | `Idempotency-Key` | 否 | 操作员；服务端核对项目开关、条目、能力与任务类型 | 项目详情逐条派发，缺权限或开关时显示原因 |
| 录入需求 | `POST /api/v1/demands`（`title` 1～200 字、`body`、可选 `project_id`） | `Idempotency-Key` | 否 | 操作员 | 操作员 |
| 编辑需求、关联项目 | `PATCH /api/v1/demands/:id`（`title`、`body`、`project_id`） | `If-Match` | 否 | 操作员 | 操作员 |
| 派发任务 | `POST /api/v1/demands/:id/dispatch`（`kind`、`executor`、可选 `resources`） | `Idempotency-Key` | 否 | 操作员 | 操作员；需求没有关联项目时禁用 |
| 登记机器 | `POST /api/v1/machines` | `Idempotency-Key` | 否 | 所有者并重新认证 | 所有者 |
| 修改机器属性与上限 | `PATCH /api/v1/machines/:id` | `If-Match` | 否 | 所有者；信任调到「高信任」要重新认证 | 所有者 |
| 停止派发、恢复派发、排空 | `POST /api/v1/machines/:id/{cordon,uncordon,drain}` | 按目标状态幂等 | 停止派发与排空确认 | 操作员 | 操作员 |
| 重置节点令牌 | `POST /api/v1/machines/:id/reset-token` | `Idempotency-Key` | 是 | 所有者并重新认证 | 所有者 |
| 取消任务 | `POST /api/v1/tasks/:id/cancel` | 无 | 是 | 操作员 | 操作员；任务未结束时显示 |
| 重新排队 | `POST /api/v1/tasks/:id/requeue` | `Idempotency-Key` | 否 | 操作员 | 操作员；失败或已取消时显示 |
| 发布结果 | `POST /api/v1/tasks/:id/publish` | 无 | 是，说明项目当前的写入模式 | 操作员 | 操作员；待发布时显示 |
| 添加连接 | `POST /api/v1/connections`（`provider`、`name`、`base_url`、可选 `credentials`） | `Idempotency-Key` | 否 | 所有者并重新认证 | 所有者 |
| 修改连接名称、地址、启用、凭据 | `PATCH /api/v1/connections/:id` | `If-Match` | 否 | 所有者；改凭据、改地址或重新启用要重新认证 | 所有者 |
| 发现项目、同步条目 | `POST /api/v1/connections/:id/{discover,sync}` | 无 | 否 | 操作员 | 操作员；只对 GitHub、GitLab 连接显示 |
| 停用连接 | `POST /api/v1/connections/:id/disable` | 无 | 是 | 操作员 | 操作员用「启用」开关关掉已启用的连接；重新启用走 `PATCH`，只给所有者 |
| 保存模型池 | `PATCH /api/v1/model-pools/:kind`（`entries`：1～8 项 `{ model, effort }`） | `If-Match` | 否 | 操作员 | 操作员 |
| 加入管理员 | `POST /api/v1/admins`（`github_id`、`role`：`operator` 或 `viewer`） | `Idempotency-Key` | 否 | 所有者并重新认证 | 所有者 |
| 移除管理员 | `DELETE /api/v1/admins/:github_id` | 无 | 是 | 所有者并重新认证 | 所有者 |

派发表单里，修复与返工只能选一次性 VM，审查、受理、跟进可以选只读 sandbox；资源预算不填时用控制面默认值，填时 CPU 1～256 核、内存 128～1,048,576 MiB。

## 共用做法

**（1）列表与分页**。`components/use-data.ts` 的 `useCursorList` 每页读 50 条，游标和筛选都写在地址栏里，刷新、分享后状态不丢。换筛选回到第一页。一页上有两个列表时用不同的游标参数名（`items_cursor`、`tasks_cursor`、`events_cursor`）。`CursorPager.vue` 只有「第一页」「上一页」「下一页」，接口不返回总数，所以没有页码。列表一律是 `TxDataTable`，窄屏在自己的容器里横向滚动。

**（2）读取与更新单个资源**。`useRecord` 用 `getVersioned` 读取，优先取响应头 `ETag`，没有时用记录里的 `revision` 拼成 `"<revision>"`。更新带 `If-Match`，成功后用返回的新记录替换并换上新 ETag。control 对缺少 `If-Match` 回 428 `revision_required`，版本不符回 412 `revision_mismatch`；项目详情在更新失败后重新读取，界面回到服务端的真实值。

**（3）创建类请求**。`lib/api.ts` 的 `newIdempotencyKey` 生成 32 位十六进制的 `Idempotency-Key`。同一个表单重试时复用，成功后换新；派发表单换任务类型、连接表单换平台时也换新。客户端只接受 1～64 位 `[A-Za-z0-9_-]`，和服务端一致。

**（4）操作反馈与重新认证**。每个写操作经 `components/use-action.ts` 执行：进行中禁用按钮，成功给轻提示，失败给不自动消失的提示，内容带 `HTTP 状态 · 机器码 · request id`，表单还在原位显示错误。服务端回 403 `reauth_required` 时打开 `shell/ReauthDialog.vue`，走 `purpose=reauth` 的 device flow（空 scope），完成后原操作自动重试一次；关闭弹层按失败处理。收到 401 时重新读会话。所有者的顶栏另有「重新认证」按钮，页脚显示重新认证的有效期。

**（5）危险操作确认**。`components/ConfirmDialog.vue` 包一层 `TxModal`：打开后焦点在「取消」，不监听 Enter 直接确认，Esc、遮罩和「取消」都关闭；进行中两个按钮都禁用；失败时弹层保持打开，错误写在弹层里。用到它的操作见上表「先确认」一列。

**（6）一次性令牌与凭据**。登记机器和重置令牌的响应里有节点令牌，`components/NodeTokenNotice.vue` 明确写「只显示这一次」，提供复制，说明节点用 `GEEK_BOT_NODE_TOKEN_FILE` 读取；点「已保存，隐藏令牌」后页面不再保留明文。连接凭据只写不读：`components/CredentialFields.vue` 按平台显示字段（GitLab 令牌；飞书 App ID、App Secret、Verification Token、可选 Encrypt Key；签名 Webhook 的签名密钥和可选回传地址），全部用密码输入框；`lib/credentials.ts` 只提交填了值的字段，更新时留空表示不改。界面只显示「已配置」与否。GitHub 连接不填凭据，用 device flow 绑定，服务端只接受 `repo`、`read:org` 范围内的授权。

**（7）外部文本按纯文本渲染**。需求正文、任务结果的摘要与正文、发现的问题、错误原因、执行事件、catalog 读取错误、条目标题都用文本插值显示，没有 `v-html`，也没有用 `TxMarkdownView`。补丁放在 `<pre>` 里按原文显示。外部地址只在协议是 https（设备授权地址）或 http(s)（项目的平台地址）时渲染成链接，带 `rel="noopener noreferrer"`，否则按文本显示。飞书与签名 Webhook 连接的详情页显示入站地址 `<当前 origin>/api/v1/intake/<provider>/<连接 id>`，供复制到对方平台。

**（8）实时刷新**。只有任务详情页用 SSE：任务没结束时，`lib/sse.ts` 订阅 `task:<id>`，收到 `task.updated` 或 `task.event` 就重新读取任务和当前页事件（不闪回加载状态）。连接出错时每 5 秒轮询；浏览器放弃重连（CLOSED）后按 5 秒起、翻倍、最长 60 秒退避自己重建，重建后第一次连上时整页重新拉取。收到 `reset` 时重新拉取，收到 `session_expired` 时关闭；任务读取返回 401 时页面也关闭连接。页面用 `role=status` 显示「实时更新中」「实时推送已断开，每 5 秒刷新一次」等状态。服务端（`app/control/src/routes/platform/stream/index.ts`）每 15 秒发心跳并复核会话，按 `Last-Event-ID` 从最近 10 分钟、最多 5,000 条的缓冲补发，补不了时发 `reset`。

**（9）会话与外壳**。`components/context.ts` 注入 API 客户端、运行模式和会话；会话状态分「未读」「已登录」「未登录」「读取失败」，角色高低是只读成员 < 操作员 < 所有者，只用于界面提示。顶栏显示账号与角色、退出登录；断网时顶部显示 `TxAlert`；页脚显示 `/api/release` 的版本展示值。

## 源码地图

| 路径 | 内容 |
|---|---|
| `package.json` | 依赖 `vue`、`vue-router`、`@talex-touch/tuffex`（钉死 0.6.0）、`@geek-bot/protocol`；开发依赖 Vite、`@vitejs/plugin-vue`、`vue-tsc`、UnoCSS 图标预设与 Carbon 图标集。脚本见「运行」 |
| `tsconfig.json`、`tsconfig.node.json` | 前者查 `src/**/*.ts`、`src/**/*.vue`；后者只查 `vite.config.ts` |
| `vite.config.ts`、`index.html` | Vue 插件、Tuffex 官方按需样式插件（`@talex-touch/tuffex/vite`）、UnoCSS 只用图标预设；Tuffex 状态组件内部用到的 Carbon 图标类列在 `safelist` 里 |
| `src/env.d.ts` | `vite/client` 类型与 `.vue` 模块声明 |
| `src/main.ts` | 入口：引入 Tuffex `base.css`、图标 CSS 和 `styles/console.css`，创建 API 客户端与会话，挂路由。`--mode sample` 时动态导入样板数据，正式构建里这段代码被去掉 |
| `src/App.vue` | 只挂外壳；全局 `box-sizing`、减少动态效果时去掉过渡动画、抽屉关闭时去掉面板阴影 |
| `src/router.ts` | 路由表与守卫（见「页面与路由」），同步 `document.title` |
| `src/shell/pages.ts` | 页面清单：名称、路径、中文标签、分组（项目与需求、运行、设置）、Carbon 图标、主列表端点；`DETAIL_PARENT` 给详情页定侧栏高亮 |
| `src/shell/AppShell.vue` | 外壳：宽屏 `TxSidebarNav`，窄屏收进左侧 `TxDrawer`；顶栏账号、重新认证、退出登录、样板数据标识；断网与样板数据提示；页脚版本；「跳到主要内容」链接；`TxToastHost` 与重新认证弹层只挂这里。登录页不显示侧栏 |
| `src/shell/ReauthDialog.vue` | 重新认证弹层 |
| `src/components/context.ts` | 注入键、会话（`load`、`allows`、`requestReauth`） |
| `src/components/use-environment.ts` | 在线状态与媒体查询；窄屏断点 |
| `src/components/use-data.ts` | `useCursorList`、`useRecord`、`useQueryFilters`、`queryText` |
| `src/components/use-action.ts` | 写操作的执行、提示与重新认证重试 |
| `src/components/use-connections.ts` | 连接清单（一次最多 200 条），按 id 显示「名称（平台）」 |
| `src/components/use-project-names.ts` | 按项目 id 逐个读取名称，同一 id 只读一次，读不到显示 id |
| `src/components/StateView.vue` | 加载、空、失败、未登录、无权限、离线六种状态，成功时渲染插槽；失败类带 `HTTP 状态 · 机器码 · request id` 并用 `role=alert`，加载与空用 `role=status` |
| `src/components/CursorPager.vue` | 游标分页按钮 |
| `src/components/ConfirmDialog.vue` | 危险操作确认 |
| `src/components/DeviceFlowPanel.vue` | GitHub device flow：用户码与复制、验证地址、轮询、过期、拒绝、出错与重新开始 |
| `src/components/CredentialFields.vue` | 按平台的凭据输入 |
| `src/components/NodeTokenNotice.vue` | 一次性节点令牌 |
| `src/components/ProjectPicker.vue` | `TxSelect` 远程搜索项目（`/api/v1/projects?search=`，最多 20 条）；归档或失去访问的项目不可选 |
| `src/components/ModelPoolEditor.vue` | 一个任务类型的模型池：`TxSortableList` 拖拽或键盘重排，另有上移、下移按钮；模型与档位只能从 catalog 选，没有档位的模型只接受 `off` |
| `src/lib/api.ts` | API 客户端：路径白名单 `isApiPath`（只接受 `/api/v1/*` 与 `/api/release`，拒绝完整 URL、协议相对地址和任何写法的点段）、`get`、`getVersioned`、`send`（`If-Match`、`Idempotency-Key`）、`withQuery`、`ApiError`（`http`、`network`、`invalid_response`）、`describeError`、`etagOf`、`newIdempotencyKey`。`fetch` 由调用方注入 |
| `src/lib/page-state.ts` | 页面状态：401 未登录，403 无权限（含 `reauth_required`），没有响应算离线，其余算失败 |
| `src/lib/sse.ts` | SSE 客户端，见「实时刷新」 |
| `src/lib/format.ts` | `formatDuration`、`formatTime`（`null` 写「从未」）、`formatMemory` |
| `src/lib/labels.ts` | 机器值到中文名与状态色调的映射：角色、平台、写入模式、任务类型与状态、执行器、需求状态与来源、机器状态、信任级别、项目状态、能力、连接状态 |
| `src/lib/credentials.ts` | 各平台凭据字段、默认平台地址、请求体转换 |
| `src/mocks/index.ts`、`src/mocks/data.ts` | 样板数据模式，见下节 |
| `src/styles/console.css` | 各页面共用的版式：页面头、分区、表单栅格、字段、说明列表、等宽与纯文本块 |
| `src/pages/*.vue` | 各页面，见「页面与路由」 |
| `tests/console/` | `api`、`format`、`sse`、`mocks`、`glyphs` 五个单测文件 |
| `tests/e2e/` | Playwright 浏览器回归：`fixtures.ts`（页面规则检查、网络隔离断言）、`glyphs.ts`、`shell.spec.ts`、`states.spec.ts` |

console 对 `@geek-bot/protocol` 只做 type 导入，DTO 在 `packages/protocol/src/index.ts`（`ApiList`、`MeResponse`、`ReleaseInfo`、`StreamTopic` 等）和 `src/shared.ts`（连接、项目、条目、需求、任务、机器、模型池、管理员、认证）。新增或删除文件时同步更新本表。

## 样板数据模式

样板数据模式只用于界面开发和浏览器回归，不能当作业务行为的证据。`vite --mode sample` 时 `src/mocks/` 替代 `fetch`，数据全部虚构，不发网络请求；顶栏和正文顶部都标明「样板数据」。

- 地址栏 `?sample=` 切换数据端点的响应：`ok`（默认）、`empty`、`slow`（1.5 秒后返回）、`error`（500）、`forbidden`（403）、`unauthenticated`（401）、`offline`（没有响应）。`/api/v1/me`、`/api/v1/auth/state`、`/api/release` 不受影响。
- 列表按查询参数做等值筛选，`search` 匹配名称或路径；不分页，`next_cursor` 总是 `null`。带 `revision` 的记录返回 `ETag`。
- 所有写请求一律返回 405 `sample_read_only`，界面按真实失败显示，不假装成功。认领、登录、派发、取消等写操作只能在连着 control 的真实模式里验证。
- 任务详情不建立 SSE 连接，未结束的任务每 5 秒轮询。

## 主题、图标与断点

- **主题**：只有 Tuffex 0.6.0 的浅色一套，组件和自写 CSS 里没有颜色值，自写 CSS 只管版式。用到的令牌：`--tx-bg-color`、`--tx-bg-color-page`、`--tx-text-color-primary`、`--tx-text-color-regular`、`--tx-border-color`、`--tx-border-color-light`、`--tx-border-color-lighter`、`--tx-border-radius-base`、`--tx-fill-color-light`、`--tx-color-primary`、`--tx-color-danger`、`--tx-color-warning-light-5`、`--tx-color-warning-light-9`、`--tx-focus-ring-color`、`--tx-font-family`、`--tx-bui-font-mono`。组件变量只设了 `--tx-bui-sidebar-nav-width: 100%`，让侧栏导航填满侧栏和抽屉。Tuffex 0.6.0 的 `base.css` 不按系统设置切深色。
- **图标**：UnoCSS 图标预设 + Carbon 图标集（`@iconify-json/carbon`），类名写成 `i-carbon-<名称>`。Tuffex 的状态组件默认就用 Carbon。
- **窄屏断点**：宽度小于 960px（`(max-width: 959.98px)`）时侧栏收进抽屉。

## Tuffex 0.6.0 在 Node 22 上的实测（2026-09-26，#4，Node v22.23.2、pnpm 9.15.9）

- 上游 `package.json` 声明 `engines.node >=26.0.0`、peer `vue ^3.5.27`。在 Node 22 上 `pnpm install` 成功（pnpm 对依赖的 engines 只告警），当时 `vue-tsc`、`vite build`、`pnpm test:e2e` 都通过。浏览器里运行的是构建产物，与 Node 版本无关。
- Tuffex 依赖的 `@talex-touch/utils@2.1.0` 把 `electron` 声明为必选 peer。Tuffex 只导入 `@talex-touch/utils/env`，这个入口不导入 electron，所以根 `package.json` 用 `pnpm.packageExtensions` 把它标为可选 peer，不安装 Electron（约 282 MB）。升级 Tuffex 或 utils 时重新核对。
- `TxDrawer` 关闭时面板只平移到视口外，阴影会漏进视口左边缘；`App.vue` 在关闭状态下去掉面板阴影。
- `TxEmptyState` 各变体的默认文案、`TxDrawer` 和 `TxModal` 默认关闭按钮的可访问名是英文：状态组件一律传中文标题与说明，抽屉用 `header` 插槽换成「关闭导航」，`ConfirmDialog` 把弹层关闭按钮的可访问名改成「关闭对话框」。

## 运行

console 有两种运行方式。只看界面用样板数据模式；要验证写操作和真实数据，必须连 control。

```bash
pnpm dev:console                                # 样板数据模式的开发服务器（vite --mode sample）
pnpm --filter @geek-bot/console build           # 正式构建到 app/console/dist/
pnpm dev:control                                # 本机 control，默认托管 app/console/dist/，地址 http://127.0.0.1:8080
```

连 control 的本机步骤：

1. 先正式构建 console，再运行 `pnpm dev:control`。control 默认读 `app/console/dist/`，也可以用 `GEEK_BOT_CONSOLE_DIST` 指定；找不到产物时只在日志里提示，不托管页面。本机 control 的数据目录、一次性密钥和 `.env.local` 见 [LOCAL-DEV](../../ops/LOCAL-DEV.md)。
2. 没配 `GEEK_BOT_PUBLIC_ORIGIN` 时 control 只接受回环地址的 Host，所以用 `http://127.0.0.1:8080` 打开。
3. 认领和登录走 GitHub device flow，需要在 `.env.local` 里配 `GEEK_BOT_GITHUB_CLIENT_ID` 和 `GEEK_BOT_OAUTH_CLIENT_SECRET_FILE`（指向放 client secret 的文件）；OAuth App 要开启 Device Flow（[GitHub 文档](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)）。没配时 device flow 返回 409 `oauth_not_configured`。
4. 实例未认领时，在 control 运行期间执行 `node app/control/dist/cli.js bootstrap-code` 取认领码（15 分钟有效，环境变量与 `pnpm dev:control` 一致，写法见 LOCAL-DEV 的运维命令），在 `/login` 输入后完成 GitHub 授权，这个 GitHub 账号成为所有者。

本机运行只算本地开发：没设 `GEEK_BOT_RELEASE_*` 时页脚显示「本地开发 · 未发布」，不能当作预发布验收（[RELEASES](../../conventions/RELEASES.md)）。

## 验证命令

```bash
pnpm --filter @geek-bot/console typecheck      # vue-tsc 查 src/，tsc 查 vite.config.ts（也在 pnpm check 里）
pnpm --filter @geek-bot/console build          # 正式构建（也在 pnpm build 里）
pnpm exec vitest run tests/console             # lib 与样板数据的单测（也在 pnpm test 里）
PLAYWRIGHT_BROWSERS_PATH=/tmp/geek-bot-playwright pnpm exec playwright install chromium # 首次下载放 /tmp
PLAYWRIGHT_BROWSERS_PATH=/tmp/geek-bot-playwright pnpm test:e2e # 样板数据构建、预览和 Playwright
```

`tests/e2e/fixtures.ts` 的页面规则检查是：原生 `select` 与 `input[type=checkbox]` 数量为 0；emoji 与被禁 unicode 符号扫描为 0；每个 `i-carbon-*` 图标都有图形；没有页面级横向溢出，也没有被 `overflow: hidden` 截掉的内容。每个用例结束时断言浏览器没有发往预览地址以外的请求。`shell.spec.ts` 按页面清单在 1280px 与 390px 下逐页检查，其余用例覆盖键盘、抽屉、样板数据标识、断网提示和各数据状态；验收截图写到 `test-results/evidence/`。

## #34 的验证记录

已执行（由主 agent 执行并提供结果）：

- console 的类型检查和 Vite 正式构建通过。`useRecord` 先前对泛型记录的弱类型约束已修正，之后再跑通过。
- 浏览器验证：在连着本机真实 control 的正式构建里（真实 HTTP 与 SQLite，不是样板数据模式），桌面宽度和 390px 宽度下看到项目列表，录入需求并关联项目，派发任务，取消任务。截图只保存在执行验证的本机，不是 PR 附件；PR 需要另行上传证据。
- 样板数据浏览器回归已按当前页面迁移，44 项通过，覆盖 1280px 与 390px、键盘、导航、各数据状态、网络隔离和裁切。屏幕阅读器专用文本仅在实际样式满足严格隐藏几何条件时排除，普通文本裁切仍拒绝。
- control 侧的真实 HTTP 与 SQLite 烟雾验证（项目发现与同步、需求派发、租约与 fence、一次性节点令牌的幂等重放、只读成员被拒、重启后持久化）属于 control 的证据，不是界面证据。

没有验证：

- 用真实外部账号的操作：GitHub OAuth 的认领、登录、重新认证与连接绑定，GitLab 令牌，飞书事件订阅，签名 Webhook 的入站与回传。
- 界面上的多页游标分页、412 版本冲突后的恢复、重新认证弹层的自动重试、任务详情的 SSE 实时刷新与断线轮询。
- 屏幕阅读器、多浏览器、对比度和文字放大（[DESIGN](../../design/DESIGN.md)「验收」）。
- 浏览器回归只覆盖样板数据；不证明真实后台的外部授权、发布或执行行为。console 单测随根 verify 核对，不能拿样板数据代替真实服务证据。
- 预发布实例、正式实例和需要 KVM 的 VM 执行。

## 已知限制

- 列表页不订阅 SSE。任务列表靠「刷新」按钮重新读取计数和列表，其它列表在进入页面或操作完成后重新读取。
- 需求和任务记录只带 `project_id`，control 没有批量查名称的端点，列表按 id 逐个读取项目名称。
- 项目详情的机器分配最多读 10 页、每页 200 台机器；连接清单一次最多读 200 条。
- 游标分页没有总数和页码。
- 登录只有 device flow；`/api/v1/auth/state` 目前只返回 `device`。
- 只有浅色主题。
