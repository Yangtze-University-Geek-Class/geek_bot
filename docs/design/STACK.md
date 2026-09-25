# 技术栈与版本治理

> 已经引入的工具和计划中的选型分开写；版本以 manifest、锁文件和运行时检查为准，路线图不写成现状。

状态：`current` · 更新：2026-09-25 · 适用：根与各包的 `package.json`、`pnpm-lock.yaml`、`.nvmrc`、`.node-version`，以及以后的镜像与部署文件

## 版本从哪里来

| 问题 | 来源 |
|---|---|
| 声明的版本范围 | 根 `package.json` 与各包 `package.json` |
| 实际装的是哪个版本 | `pnpm-lock.yaml` |
| 当前用哪个 Node | `pnpm check:runtime` 的输出 |
| 运行时基线 | `.nvmrc`、`.node-version`、根 `package.json` 的 `engines`，三处表达同一个基线 |

声明 `^3.2.4` 不等于装的是 3.2.4，要看锁文件。本文只记录这些来源里已经有的内容；和它们不一致时，以它们为准，并在同一次改动里修正本文。

## 已引入（#1）

#1 只引入开发工具，五个包都没有第三方运行时依赖。

| 层 | 方案 | 声明 | 锁文件解析 |
|---|---|---|---|
| 运行时 | Node.js，全部是 ESM（各包 `"type": "module"`） | `engines.node: ">=22.13.0 <23"`；`.nvmrc` 与 `.node-version` 为 `22` | CI 按 `.nvmrc` 安装；`pnpm check:runtime` 要求 22.x 且不低于 22.13 |
| 包管理 | pnpm workspace：`app/control`、`app/console`、`app/node`、`app/runner`、`packages/protocol` | `packageManager: pnpm@9.15.9` | 9.15.9 |
| 语言 | TypeScript，`strict`；共用编译选项在 `tsconfig.base.json`，各包 `typecheck` 为 `tsc --noEmit`、`build` 产物进 `dist/` | `typescript: ^5.9.3`（`scripts/check-boundaries.mjs` 读 `ImportClause.phaseModifier` 判断 `import type`，这个 API 从 5.9 起才有） | 5.9.3 |
| Node 类型 | `@types/node` | `^22.10.0` | 22.20.4 |
| 测试 | vitest，根 `vitest.config.ts` 收集 `tests/**/*.test.ts`，在 Node 环境里跑 | `vitest: ^3.2.4` | 3.2.7 |
| 包间依赖 | 四个 app 依赖 `@geek-bot/protocol: workspace:*` | `workspace:*` | 工作区链接 |
| CI | GitHub Actions：`pnpm install --frozen-lockfile` 后跑 `pnpm check`、`pnpm test`、`pnpm build`；另有分支不变量检查和 actionlint 工作流自检；不挂载任何 secrets，权限只有 `contents: read` | `.github/workflows/ci.yml` | 第三方 action 按提交 SHA 钉死；actionlint 版本和 SHA-256 写在工作流里 |

包之间的导入方向见 [模块化开发规范](../conventions/MODULAR-DEVELOPMENT.md)；命令与验收见 [TESTING](../conventions/TESTING.md)。

## 计划中

下表每一行都还没有进入仓库，由括号里的 issue 引入；引入时按「升级与引入准入」一节核对，并把本行移到「已引入」，写上真实的声明范围和锁文件版本。新增生产依赖需要所有者批准（见 [CONTRIBUTING](../conventions/CONTRIBUTING.md)）。

| 层 | 选型 | issue | 引入时要核对的事 |
|---|---|---|---|
| 控制面 HTTP | Fastify 5 | #3 | 构造与监听分离，路由测试用 `inject` |
| 持久化 | SQLite（WAL）+ better-sqlite3 | #3 | 原生模块：在 Node 22 上核对预编译包和 ABI；只有 control 写库 |
| 管理后台 | Vue 3.5、vue-router 4、@talex-touch/tuffex 0.6.0 | #4 | Tuffex 0.6.0 上游声明 Node >=26，要实测它在 Node 22 上安装、构建与运行，结论写进 [console 服务契约](../services/console/README.md) |
| 前端构建 | Vite 7、@vitejs/plugin-vue、vue-tsc | #4 | console 的类型检查改为 vue-tsc；构建产物由 control 同源托管 |
| 图标 | UnoCSS 的图标预设 | #4 | 只用图标预设，不引入原子类样式体系 |
| 浏览器回归 | Playwright | #4 | 随 #4 加入 `test:e2e`；浏览器下载目录不进仓库 |
| 容器与发布 | Docker、Docker Compose v2、ghcr | #3（control 镜像）、#7（release.yml、compose、部署脚本） | 镜像非 root、带健康检查；同一 digest 跨环境 |
| sandbox 执行器 | 无网、根只读的独立容器 | #14 | 容器里没有任何令牌文件 |
| VM 执行器 | QEMU/KVM 一次性 VM，默认 1 vCPU / 2 GiB | #12 实测，#17 实现 | 节点容器里能否用 `/dev/kvm`、用户态网络能否隔离、2 GiB 是否够用，以 #12 的实测为准 |
| agent | omp，版本钉死，按 SHA256SUMS 校验后打进 node 镜像和 VM 基础镜像 | #14 | 设计草案选的版本是 18.3.0，以 #14 的实现为准 |
| runner 打包 | 只用 Node 标准库，打成单文件 | #14 | 不引入任何 npm 包；对 `@geek-bot/protocol` 只做 type 导入 |
| 运行时校验 | JSON Schema 的校验方式 | 第一个需要运行时校验的 issue | 是否引入校验库在那时决定，写回 [protocol 契约](../services/protocol/README.md) |
| GitHub 访问 | REST、GraphQL 与 git | #6、#8、#9 | 是否引入客户端库在 #6 决定；写入一律经 publisher |

整体设计见 [ARCHITECTURE](../architecture/ARCHITECTURE.md)。

## 不采用

- 管理后台只用 Vue 3.5 与 Tuffex，不引入别的 UI 框架和组件库，不另建平行的通用 UI 体系（[Tuffex 使用政策](../components/tuffex/USAGE-POLICY.md)）。
- 不做 SSR；console 是单页应用，由 control 托管静态产物，不另起 nginx。
- 数据层不用 ORM 或迁移框架，迁移是按编号的 SQL 文件（#3）。
- 容器编排只用 Docker Compose；多节点调度由 control 自己完成，不引入 Kubernetes。
- 第一版不做深色主题，也不引入多语言框架（见 [DESIGN](DESIGN.md)）。

改变这里的任何一条，要先写 ADR 并取得所有者批准。

## 升级与引入准入

- 有明确理由：安全修复、支持周期或实际收益；不为追新而升级。
- 查官方的兼容性说明；外部来源和核对日期登记在 [REFERENCES](../conventions/REFERENCES.md)。
- 先验证运行时和原生模块（better-sqlite3、Node 大版本），再改代码。
- 锁文件固定解析结果，跑完整的 `pnpm verify`；涉及界面的再跑浏览器回归。
- 框架大版本单独一次改动，不和功能改动打包；升级 Tuffex 单独立项，并同步更新 `docs/components/tuffex/` 的参考资料。
- PR 里写明用途、许可证、运行环境、体积和维护代价。

## 环境一致性

`.nvmrc`、`.node-version` 和 `engines` 表达同一个基线：Node 22，至少 22.13。系统里装的 Node 可以不同，但项目命令必须用这个版本跑；`pnpm check:runtime` 和 `pnpm build` 会先检查。切换 Node 后重新安装依赖（原生模块要按新的 ABI 重新准备）。运行时下载、缓存和本机路径不提交。

Node 22 是 LTS 版本线（代号 Jod），支持周期以 [Node.js 官方发布页](https://nodejs.org/en/about/previous-releases) 为准（2026-09-25 核对）；升级 Node 时重新核对，本文不是永久的兼容矩阵。
