# console 服务契约（`app/console`）

> 管理后台：Vue 3.5 + vue-router 4 + Tuffex 0.6.0 + Vite 的单页应用，构建产物由 control 同源托管。

状态：`proposed` · 更新：2026-09-25 · 适用：`app/console`（`@geek-bot/console`）、`tests/console`

## 职责

- 给部署者和管理员一个后台：概览、队列、任务实时详情、未接的 issue、仓库、节点、模型池、机器人账号、设置、告警与审计。
- 只调用 control 的 `/api/v1/*` 和 SSE，不直接访问 GitHub、节点或模型网关；浏览器里只有 HttpOnly 会话 cookie，拿不到任何令牌。
- 全部控件用 Tuffex；不用原生下拉框和复选框，不用 emoji。界面规则见 [DESIGN](../../design/DESIGN.md)「硬性规则」，Tuffex 的引入与版本规则见 [Tuffex 使用政策](../../components/tuffex/USAGE-POLICY.md)。

Vue、vue-router、Tuffex、Vite 都是计划中的依赖，由 #4 引入。

## 现在有什么

#1 只建最小源码，还没有 Vue、没有页面，只有一个不依赖 Vue 的格式化函数：

| 路径 | 内容 |
|---|---|
| `app/console/package.json` | 包名 `@geek-bot/console`，依赖 `@geek-bot/protocol: workspace:*`；脚本 `typecheck`（`tsc --noEmit`）、`build` |
| `app/console/tsconfig.json` | 继承根 `tsconfig.base.json`，`src/` 编译到 `dist/`；不加载 Node 类型 |
| `app/console/src/lib/format.ts` | `formatDuration(ms)`：把毫秒格式化成中文时长，最多显示相邻两级单位（例：「2 小时 5 分钟」），0 显示「0 秒」，不足 1 秒显示「不到 1 秒」，负数、NaN、无穷大抛 `RangeError`。`lib/` 不导入 Vue |
| `app/console/src/index.ts` | 包入口，只导出 `formatDuration` |
| `tests/console/format.test.ts` | 按例子输出、两级单位与向下取整、0 与不足 1 秒、非法输入 |

新增或删除文件时同步更新本表。

## 计划中的模块与对应 issue

| 模块（计划路径） | 内容 | issue |
|---|---|---|
| `src/{main.ts,App.vue,router.ts}`、`src/shell/` | 入口、路由、外壳：侧栏导航、窄屏抽屉 | #4 |
| `src/components/` | 状态组件（加载、空、失败、无权限、离线）与共用组合 | #4 |
| `src/lib/{api,sse,format,types}` | 请求与错误、SSE 客户端、格式化；`lib` 不导入 Vue，可单测 | #4 |
| `src/mocks/` | 样板数据模式：数据全部虚构，不发任何外部请求 | #4 |
| 登录页、机器人账号页 | 认领、device flow 登录、「机器人以你的身份发言」提示 | #5 |
| 仓库页 | 按所有者和组织分组、权限标签、逐仓库开关与置灰原因 | #6 |
| 队列页、未接的 issue 页 | 每个条目的去向和原因 | #8 |
| 待发布预览 | dry-run 下显示「将要发布」的内容 | #9 |
| 仓库规则画像 | 规则来源、覆盖与确认 | #10 |
| 节点页 | 状态、版本、槽位、主机健康 | #11 |
| 模型池页 | 拖拽与键盘排序、窄屏上移下移、思考档位 | #13 |
| 任务详情页 | 实时输出、原始事件、模型尝试与降级时间线 | #14 |
| 设置页 | 轮询间隔、静默窗口、等回复天数与轮数等参数 | #16 |

## 接口与数据归属（计划中）

- 只调用 control 的 `/api/v1/*` 与 `/api/v1/stream`（SSE，支持 Last-Event-ID，断线后退回轮询）；请求同源、带 cookie。DTO 类型从 `@geek-bot/protocol` 导入，不另抄一份。
- console 不拥有任何数据；页面上能不能操作只是提示，授权只在 control 的服务端判断。
- 来自 GitHub、omp、节点的文本一律按纯文本渲染；只有审查预览用 TxMarkdownView，并显式净化。
- 构建产物打进 control 镜像同源托管，不另起 nginx。

## 验证

```bash
pnpm --filter @geek-bot/console typecheck
pnpm exec vitest run tests/console
```

#4 引入 Vue 后，类型检查改为 vue-tsc，并加入 Playwright 界面回归（`test:e2e` 随 #4 加入）：页面上原生 select 与 checkbox 数量为 0、emoji 扫描为 0、390px 宽度下没有页面级横向溢出、窄屏抽屉可用、键盘可达。

## 已知限制

- #1 没有实现任何界面；上文的页面和接口都是计划。
- 上游 Tuffex 0.6.0 声明 Node >=26，本仓库基线是 Node 22；能否在 Node 22 上安装、构建与运行，由 #4 实测并写回本文。
- 主题令牌清单、图标集和窄屏断点由 #4 写入本文。
