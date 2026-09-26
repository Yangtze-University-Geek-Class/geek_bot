# ADR-0009：管理后台用 Vue 3 + Tuffex 0.6.0，由 control 同源托管

> console 是 Vue 3.5 + vue-router 4 + Tuffex 0.6.0 + Vite 的单页应用，版本钉死；构建产物打进 control 镜像，与后台 API 和 SSE 同源提供，不另起静态服务器。

状态：`accepted` · 更新：2026-09-26 · 适用：`app/console` 的技术选型与构建产物的托管方式（由 #4 实现，同源托管随 #3、#7 的 control 镜像落地）

## 背景

- 所有者的硬性要求：管理后台全部用 Tuffex，[Tuffex 使用政策](../components/tuffex/USAGE-POLICY.md) 已按这一条写成现行规范。Tuffex 0.6.0 是 Vue 3 组件库。
- 后台要实时显示任务输出和节点状态，用 SSE 推送（`/api/v1/stream`）。SSE 每经过一层反向代理，就要在那一层关闭响应缓冲，否则事件会被攒着不发。
- 部署只用 Docker（[AGENTS](../../AGENTS.md) §3），运行件越少，部署、回滚和版本核对越简单；镜像按 digest 跨环境复用（[ADR-0007](0007-ghcr-pull-deploy.md)）。
- 会话 cookie 是 HttpOnly、host-only 的（[RELEASES](../conventions/RELEASES.md)「环境与入口绑定」），后台不应该跨源带凭据调 API。
- 上游 Tuffex 0.6.0 的 manifest 声明 Node >=26、Vue ^3.5.27，本仓库基线是 Node 22；文档快照里 agent-trace、tool-call-card、spark-chart 等组件标为 beta（[Tuffex 文档库](../components/tuffex/README.md)）。

## 决策

- console 用 Vue 3.5、vue-router 4、`@talex-touch/tuffex` 0.6.0 和 Vite，版本以 `app/console/package.json` 与锁文件为准，钉死；组件按子路径引入；图标用 UnoCSS 的图标预设（[STACK](../design/STACK.md)）。
- 界面的硬性规则只在 [DESIGN](../design/DESIGN.md)「硬性规则」定义（不用原生下拉框和复选框、不用 emoji、外部文本按纯文本渲染、危险操作先确认等）；Tuffex 的引入、封装和版本规则只在 [Tuffex 使用政策](../components/tuffex/USAGE-POLICY.md) 定义。本 ADR 不另写一份。
- 构建产物在 control 镜像的构建阶段打进镜像，由 control 和 `/api/v1/*`、`/api/v1/stream` 同源提供，不另起 nginx 或别的静态服务器。
- 同源托管的理由：
  - SSE 从 control 直接到浏览器，不经过多层代理的缓冲；中间最多只有部署者自己加的一层 TLS 反代，只要在这一层对 SSE 路径关闭缓冲；
  - 会话 cookie 保持 host-only，不需要 CORS，也不需要跨源带凭据；
  - 少一个镜像和一个运行件；后台与 API 来自同一个镜像 digest，版本天然一致。
- SSE：`/api/v1/stream?topics=…`，支持 `Last-Event-ID`，每 15 秒发一条心跳注释；断线后退回每 5 秒轮询一次，只在页面顶部显示 TxAlert，不整页换成错误页（[DESIGN](../design/DESIGN.md)「状态、表单和导航」）。
- 不做 SSR，不做深色主题，不引入多语言框架（[STACK](../design/STACK.md)「不采用」）。
- 升级 Tuffex 版本单独立项，并同步更新 `docs/components/tuffex/` 的参考资料。

## 替代方案

- **另起 nginx 容器托管静态文件**：SSE 要在又一层关闭缓冲；多一个镜像、一个运行件，还要保证它和 control 的版本配套。
- **用别的组件库，或自己写一套通用组件**：所有者硬性要求 Tuffex，使用政策也禁止平行的 UI 体系。
- **SSR（例如 Nuxt）**：后台不需要首屏渲染和搜索收录，多一个服务端运行时。
- **WebSocket 代替 SSE**：后台只需要服务端单向推送；SSE 走普通 HTTP，自带断线续传（`Last-Event-ID`），反代配置也更简单。
- **把后台放到另一个源（CDN 或别的域名）**：要跨源带凭据、开 CORS，会话 cookie 不再是 host-only。

## 后果

- 改后台就要重新构建 control 镜像，两者一起发版；后台没有独立的版本号。
- Tuffex 0.6.0 上游声明 Node >=26。#4 实测它在 Node 22 上能安装、构建和运行，不需要换 Node 版本；另为它传递依赖里的 Electron peer 加了 `pnpm.packageExtensions`。结论见 [console 服务契约](../services/console/README.md)「Tuffex 0.6.0 在 Node 22 上的实测」。
- beta 组件的接口可能变化；版本钉死，升级单独立项并重新验收。
- 部署者在前面加 TLS 反代时，必须对 SSE 路径关闭缓冲；写进 DEPLOY（#7 写入）。
- control 多了托管静态文件的职责，负载很小；静态文件的缓存头和安全响应头由 #3 在 control 托管静态产物时定；#4 只产出 `dist/`，不涉及响应头。

## 实施状态

- #4（已实现）：console 外壳、依赖引入、样板数据模式、浏览器回归，以及 Node 22 兼容性实测（能装、能构建、能跑，结论见 [console 服务契约](../services/console/README.md)）。
- #3：control 托管静态产物（与 control 的 Dockerfile 一起）。
- #14：SSE 实时推送。
- #7：镜像构建与发布。

## 重新评估条件

- Tuffex 在 Node 22 上不可用，也没有可接受的办法；
- 所有者不再要求 Tuffex；
- 需要把后台和 control 分开部署（例如控制面只在内网、后台要放到公网）；
- 需要双向实时通信，SSE 不够用。

## 所有者结论

接受：所有者 2026-09-26 答复「ADR 全部接受」，记在 #25。按本 ADR 执行（#22 的 18 项待定事项里没有对应条目）。

- 用 Tuffex 是所有者的硬性要求，已经写进 Tuffex 使用政策；「由 control 同源托管、不另起静态服务器」和「版本钉死在 0.6.0、升级单独立项」随「ADR 全部接受」一并确认。
