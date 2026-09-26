# console 服务契约（`app/console`）

> 管理后台：Vue 3.5 + vue-router 4 + Tuffex 0.6.0 + Vite 7 的单页应用，构建产物由 control 同源托管。

状态：`proposed` · 更新：2026-09-26 · 适用：`app/console`（`@geek-bot/console`）、`tests/console`、`tests/e2e`

## 职责

- 给部署者和管理员一个后台：概览、队列、任务实时详情、未接的条目、仓库、节点、模型池、机器人账号、设置、告警与审计。
- 只调用 control 的 `/api/v1/*`、`/api/release` 和 SSE，不直接访问 GitHub、节点或模型网关；浏览器里只有 HttpOnly 会话 cookie，拿不到任何令牌。
- 全部控件用 Tuffex；不用原生下拉框和复选框，不用 emoji。界面规则见 [DESIGN](../../design/DESIGN.md)「硬性规则」，Tuffex 的引入与版本规则见 [Tuffex 使用政策](../../components/tuffex/USAGE-POLICY.md)。

## 现在有什么

#4 建好了外壳、路由、状态组件、API 与 SSE 客户端和样板数据模式；各页面的列表与操作还没做，成功时只说明控制面返回了多少数据。

| 路径 | 内容 |
|---|---|
| `app/console/package.json` | 依赖 `vue`、`vue-router`、`@talex-touch/tuffex`（钉死 0.6.0）、`@geek-bot/protocol`；开发依赖 Vite、`@vitejs/plugin-vue`、`vue-tsc`、UnoCSS 图标预设与 Carbon 图标集。脚本：`dev`（样板数据模式的开发服务器）、`typecheck`（`vue-tsc` 查 `src/`，`tsc` 查 `vite.config.ts`）、`build`（正式构建到 `dist/`）、`build:sample`（样板数据模式构建到 `.sample-dist/`，已忽略）、`preview:sample`（在 127.0.0.1:4174 预览样板构建） |
| `app/console/tsconfig.json`、`tsconfig.node.json` | 前者查 `src/**/*.ts`、`src/**/*.vue`（DOM 类型、`vite/client`）；后者只查 `vite.config.ts`（Node 类型） |
| `app/console/vite.config.ts`、`index.html` | Vite 配置：Vue 插件、Tuffex 官方的按需样式插件（`@talex-touch/tuffex/vite`，按组件的样式依赖补全 CSS）、UnoCSS 只用图标预设；Tuffex 状态组件内部用到的 Carbon 图标类列在 `safelist` 里 |
| `src/main.ts`、`src/App.vue`、`src/router.ts` | 入口：引入 Tuffex 的 `base.css` 与图标 CSS，注入 API 客户端与运行模式；`--mode sample` 时动态导入样板数据，正式构建里这段代码被整段去掉。路由由页面清单生成，`/` 跳到概览，未知地址显示「页面不存在」，并同步 `document.title` |
| `src/shell/pages.ts` | 页面清单：名称、路径、中文标签、分组（运行、资源、管理）、Carbon 图标、读取的后台 API、空状态文案。侧栏、抽屉和路由都从这里生成 |
| `src/shell/AppShell.vue` | 外壳：宽屏是 `TxSidebarNav`，窄屏收进左侧 `TxDrawer`（「导航」按钮打开，Esc、遮罩、「关闭导航」关闭，焦点回到「导航」按钮）；顶栏显示样板数据标识（`TxStatusBadge`）与当前账号；断网时顶部显示 `TxAlert`；页脚显示版本（A-55 的展示值）；有「跳到主要内容」链接 |
| `src/components/StateView.vue`、`ResourcePage.vue` | 数据页：读取页面清单里的 API，按结果显示加载（`TxLoadingState`）、空（`TxEmptyState`）、成功、失败（`TxErrorState`，可重试）、未登录与无权限（`TxPermissionState`）、离线（`TxOfflineState`）。失败类状态带 `HTTP 状态 · 机器码 · request id`，用 `role=alert` 播报；加载与空用 `role=status` |
| `src/components/context.ts`、`use-environment.ts` | 注入 API 客户端与运行模式；在线状态与窄屏断点的组合函数 |
| `src/lib/api.ts` | API 客户端：只接受 `/api/v1/*` 与 `/api/release`（`isApiPath`：拒绝完整 URL、协议相对地址和任何写法的点段，按浏览器规则规范化后必须原样不变），同源带 cookie；错误统一成 `ApiError`（`http`、`network`、`invalid_response`，带状态码、机器码、`X-Request-Id`）；`describeError` 生成 `HTTP 状态 · 机器码 · request id`。`fetch` 由调用方注入 |
| `src/lib/page-state.ts` | 页面状态：列表没有条目算空；401 → 未登录，403 → 无权限，没有响应 → 离线，其余 → 失败 |
| `src/lib/sse.ts` | SSE 客户端（A-56）：`EventSource` 连接、监听事件表里的全部类型、断线后每 5 秒轮询、重新连上后停止轮询、`reset` 时让页面重新拉取、`session_expired` 时关闭。响应不是 200 时浏览器会放弃重连（CLOSED），这时按 5 秒起、翻倍、最长 60 秒退避自己重建；重建的连接不带 Last-Event-ID，第一次连上时让页面重新拉取；会话过期后重建会一直拿到 401，调用方的轮询收到 401 时要关闭连接（#14 接入时处理）。服务端 SSE 由 #14 实现，在那之前外壳不建立连接 |
| `src/lib/format.ts` | `formatDuration(ms)`：毫秒格式化成中文时长，最多两级单位 |
| `src/mocks/` | 样板数据模式：替代 `fetch`，全部虚构、不发网络请求；地址栏的 `?sample=` 切换数据端点的响应（`ok`、`empty`、`slow`、`error`、`forbidden`、`unauthenticated`、`offline`），外壳用的 `/api/v1/me`、`/api/release` 不受影响 |
| `src/pages/NotFoundPage.vue` | 未知地址 |
| `tests/console/` | `format`、`api`（错误格式、网络错误、非 JSON、取消、路径白名单与点段、页面状态映射）、`sse`（连接、轮询、CLOSED 后退避重建、旧连接的迟到事件、reset、session_expired、非 JSON）、`mocks`（场景、不调用真实 fetch、页面清单）、`glyphs`（浏览器回归用的被禁符号正则逐类自测） |
| `tests/e2e/` | Playwright 浏览器回归，见「验证」 |

console 对 `@geek-bot/protocol` 只做 type 导入（`ApiErrorBody`、`ApiList`、`MeResponse`、`ReleaseInfo`、`StreamTopic`），不依赖它的运行时产物。新增或删除文件时同步更新本表。

## 主题、图标与断点

- **主题**：只有浅色一套，全部颜色来自 Tuffex 的 `--tx-*` 令牌；自写 CSS 只管版式。外壳用到的令牌：`--tx-bg-color`（顶栏、卡片底色）、`--tx-bg-color-page`（页面底色）、`--tx-text-color-primary`、`--tx-text-color-regular`、`--tx-border-color-light`、`--tx-border-radius-base`、`--tx-font-family`、`--tx-bui-font-mono`（账号、版本等等宽文字）。组件变量只用了 `--tx-bui-sidebar-nav-width`（设为 `100%`，让侧栏导航填满侧栏和抽屉）。Tuffex 0.6.0 的 `base.css` 没有按系统设置自动切深色。
- **图标**：UnoCSS 图标预设 + Carbon 图标集（`@iconify-json/carbon`），类名写成 `i-carbon-<名称>`。选 Carbon 是因为 Tuffex 的状态组件默认就用它；页面清单里的图标和 Tuffex 内部用到的图标都由浏览器回归核对「有图形」。
- **窄屏断点**：宽度小于 960px（媒体查询 `(max-width: 959.98px)`）时侧栏收进抽屉。

## Tuffex 0.6.0 在 Node 22 上的实测（2026-09-26，Node v22.23.2、pnpm 9.15.9）

- 上游 `package.json` 声明 `engines.node >=26.0.0`、peer `vue ^3.5.27`。在 Node 22 上 `pnpm install` 成功（pnpm 对依赖的 engines 只告警），`vue-tsc`、`vite build`、`pnpm test:e2e` 全部通过。浏览器里运行的是构建产物，与 Node 版本无关；构建期只用到 Vite 和 Tuffex 的按需样式插件。
- Tuffex 依赖的 `@talex-touch/utils@2.1.0` 把 `electron` 声明为必选 peer，pnpm 会自动装上 Electron（二进制约 282 MB）。Tuffex 只导入 `@talex-touch/utils/env`，这个入口不导入 electron，所以根 `package.json` 用 `pnpm.packageExtensions` 把它标为可选 peer，不再安装 Electron。升级 Tuffex 或 utils 时重新核对这一条。
- `TxDrawer` 关闭时面板只是平移到视口外（根元素带 `inert` 与 `aria-hidden`，键盘进不去），但面板阴影会漏进视口左边缘；`App.vue` 在关闭状态下去掉了面板阴影，浏览器回归核对。
- `TxEmptyState` 各变体的默认标题与说明是英文；外壳里每个状态都传中文标题和说明。`TxDrawer` 默认关闭按钮的可访问名是英文，外壳用 `header` 插槽换成「关闭导航」。

## 计划中的模块与对应 issue

| 模块（计划路径） | 内容 | issue |
|---|---|---|
| 登录页、机器人账号页 | 认领、device flow 登录、「机器人以你的身份发言」提示 | #5 |
| 仓库页 | 按所有者和组织分组、权限标签、逐仓库开关与置灰原因 | #6 |
| 队列页、未接的条目页 | 每个条目的去向和原因；接上 SSE | #8 |
| 待发布预览 | dry-run 下显示「将要发布」的内容 | #9 |
| 仓库规则画像 | 规则来源、覆盖与确认 | #10 |
| 节点页 | 状态、版本、槽位、主机健康 | #11 |
| 模型池页 | 拖拽与键盘排序、窄屏上移下移、思考档位 | #13 |
| 任务详情页 | 实时输出、原始事件、模型尝试与降级时间线 | #14 |
| 设置页 | 轮询间隔、静默窗口、等回复天数与轮数等参数 | #16 |
| 同源托管 | control 托管 `dist/` 的静态产物，打进 control 镜像 | #7 |

## 接口与数据归属

- 只调用 control 的 `/api/v1/*`、`/api/release` 与 `/api/v1/stream`（SSE，支持 Last-Event-ID，断线后退回轮询）；请求同源、带 cookie。DTO 类型从 `@geek-bot/protocol` 导入，不另抄一份。
- console 不拥有任何数据；页面上能不能操作只是提示，授权只在 control 的服务端判断。
- 来自 GitHub、omp、节点的文本一律按纯文本渲染；只有审查预览用 TxMarkdownView，并显式净化。
- 构建产物打进 control 镜像同源托管，不另起 nginx（ADR-0009）。样板数据模式的构建（`.sample-dist/`）只用于本机与浏览器回归，不发布。

## 验证

```bash
pnpm --filter @geek-bot/console typecheck      # vue-tsc 与 vite.config.ts 的类型检查（也在 pnpm check 里）
pnpm exec vitest run tests/console             # lib 与样板数据的单测（也在 pnpm test 里）
pnpm exec playwright install chromium          # 第一次跑浏览器回归前下载 Chromium，放在用户缓存目录，不进仓库
pnpm test:e2e                                  # 样板数据模式构建 → 127.0.0.1:4174 预览 → Playwright
pnpm dev:console                               # 本机开发：样板数据模式的开发服务器
```

`pnpm test:e2e` 覆盖（`tests/e2e/`）：

- 宽屏 1280px 与窄屏 390px 下，每个页面都检查四条：
  - 原生 `select` 与 `input[type=checkbox]` 数量为 0；
  - emoji 与被禁 unicode 符号扫描为 0，扫描范围是文字、常见属性和 `::before`/`::after`；
  - 每个 `i-carbon-*` 图标都生成了图形；
  - `document.documentElement.scrollWidth` 不超过 `clientWidth`，外壳与主内容区里也没有被 `overflow: hidden` 截掉的内容（带 `title` 的单行省略除外）。
- 侧栏的当前项带 `aria-current`，页面标题同步。
- 键盘：第一个 Tab 到「跳到主要内容」，Tab 与 Enter 能切换页面。
- 窄屏抽屉：鼠标和纯键盘都能打开；打开后焦点进入抽屉，连按 Tab 出不去；导航后自动关闭；Esc 关闭后焦点回到「导航」按钮；关闭时键盘进不去，面板完全在视口外。
- 样板数据标识与页脚版本。
- 断网提示：出现后能自动消失。
- 各数据状态：加载、空、失败与重试、401、403、离线。
- 每个用例结束时断言：浏览器上下文（含 service worker）没有发往预览地址以外的请求和 WebSocket，也没有 `/api/` 请求离开浏览器。
- 验收截图写到 `test-results/evidence/`，CI 的 `console-e2e` job 把它上传为 artifact。

## 已知限制

- 各业务页面的内容由上表的 issue 实现；#4 的页面在成功时只显示「数据已就绪」和返回的条数。概览、模型池、机器人账号三个端点不是列表，不会显示空状态；机器人账号未绑定（`bound: false`）时也显示「数据已就绪」，由 #5、#13 按各自的数据改写。
- SSE 客户端只有单测；服务端 SSE（#14）落地前，外壳不建立连接，也不显示「实时推送已断开」提示。
- 登录由 #5 实现；在那之前，真实模式下 `/api/v1/me` 返回 401 时，顶栏不显示账号，页面显示「需要登录」。
- 对比度、屏幕阅读器、多浏览器（只跑了 Chromium）和文字放大还没有单独测过（DESIGN「验收」）。
