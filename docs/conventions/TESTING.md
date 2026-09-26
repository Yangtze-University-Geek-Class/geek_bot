# 测试与验收规范

> 现在就有的测试与计划中的测试分开记录；类型检查、单元与路由测试、构建、浏览器验证、VM 冒烟和实例验收是不同证据，不相互替代。

状态：`current` · 更新：2026-09-26 · 适用：`tests/**`、各包的 `typecheck` / `build`、根 `pnpm check` / `pnpm test` / `pnpm build` / `pnpm verify`

## 根入口和分工

- `pnpm check`：依次运行 `check:runtime`、`check:boundaries`、`check:docs`、`check:notes`、`check:secrets`、`check:public-safety` 与 `typecheck`（各包的 `typecheck`：console 是 `vue-tsc`，其余是 `tsc --noEmit`；再用根 `tsconfig.json` 检查 `tests/**`（`tests/e2e` 除外）与 `vitest.config.ts`，用 `tests/e2e/tsconfig.json` 带 DOM 类型检查浏览器回归与 `playwright.config.ts`，不产出文件）。
- `pnpm test`：`vitest run`，覆盖 `tests/tooling/` 与 `tests/<包>/`。
- `pnpm build`：先 `check:runtime`，再逐包构建，产物进各包 `dist/`（console 是 `vite build`，其余是 `tsc -p tsconfig.json`）。
- `pnpm verify` = `pnpm check && pnpm test && pnpm build`，任一步失败必须非零退出。CI 与合并前自查都跑它。

浏览器回归 `pnpm test:e2e`（#4 加入）不在 `pnpm verify` 里：它以样板数据模式构建 console，在 127.0.0.1:4174 预览，用 Playwright（Chromium）跑 `tests/e2e/*.spec.ts`；CI 的 `console-e2e` job 每次都跑。本机第一次运行前用 `pnpm exec playwright install chromium` 下载浏览器。

还没有的入口：环境模板契约 `pnpm check:environments`（随 #7 加入）、只在有 `/dev/kvm` 的机器上手动跑的 VM 实验 `pnpm test:vm`（随 #12 加入）。它们加入之前，相关项在报告里写「未验证」，不能用 `pnpm verify` 通过代替。

运行时固定为 Node 22（`engines` 为 `>=22.13.0 <23`，`check:runtime` 核对），pnpm 9.15.9。未找到浏览器、未找到 KVM 都不能算对应套件通过。

## 隔离

- **工具测试**在临时目录里合成夹具（临时 Git 仓库、临时 `app/`、`docs/`），不改真实仓库的文件和 refs，不 fetch、不联网。需要仓库根目录的脚本通过 `--root <dir>` 或导出的纯函数接收根目录，反例都在夹具里跑。
- **被禁字面量不进仓库**：`check-public-safety` 的反例在运行时拼出来（如把地址按段 `join('.')`），或者给纯函数注入测试自己的哈希表；测试文件、夹具里不留明文。
- **control 的路由测试**（#3 起）用 `buildApp`/`inject` 注册真实路由，SQLite 用系统临时目录里的库文件或内存库，密钥文件每次随机生成，GitHub API 与模型网关经注入的 `fetch` 打桩并默认拒绝网络，需要响应的用例显式注入模拟。不复制 handler 去验证另一份实现，不读取 `.env`、目标机配置或真实数据库，不对真实仓库发任何写请求。时间相关的规则（静默窗口、5 天提醒、7 天关闭）用可注入的假时钟。
- **浏览器测试**（`tests/e2e/`，#4 起）连样板数据或 mock API；每次使用自己创建的临时浏览器 profile，不打开、不清理用户已有的浏览器配置和数据；只关闭本次创建的进程，禁止广泛 `pkill`。样板数据全部虚构。
- **node 与 runner 测试**默认把 VM 与容器驱动打桩；真实 KVM 冒烟只在有 `/dev/kvm` 的节点上手动跑，结果单独记录（#12、#17）。恶意夹具仓库（带 `.omp/hooks`、`mcp.json`、`.env`）只在 sandbox 或 VM 里使用。

## 现在就有的测试（本仓库骨架，#1）

`tests/tooling/` 覆盖门禁脚本本身。每个门禁至少有一个「必须失败」的反例，防止门禁假绿；新增门禁时反例测试同时加入，没有反例测试的门禁不算已覆盖：

| 门禁 | 测试文件 | 必须失败的反例 |
|---|---|---|
| 入口判断（`scripts/lib/cli.mjs` 的 `isDirectRun`） | `tests/tooling/cli-entry.test.ts` | 经符号链接路径启动 `task.mjs`、`pr-contract.mjs`、`note.mjs`（不带参数）或 `check-boundaries.mjs`（带不认识的参数）时静默退出 0；任一 CLI 带不认识的参数时不把用法写到 stderr、或以 0 退出 |
| 服务文档对齐（`check-docs`） | `tests/tooling/docs-check.test.ts` | 新增 `app/foo` 或 `packages/<name>` 但缺少 `docs/services/<name>/README.md`；缺 `AGENTS.md`、`README.md` 或 `docs/README.md`；技能目录是复制品而不是符号链接，或链接指向别处、悬空；相对链接指向不存在的文件；`docs/history` 下的文档没标 `historical` |
| 模块边界（`check-boundaries`） | `tests/tooling/boundaries.test.ts` | `app/control` 导入 `app/node`；console、node 与 control 互相导入；protocol 导入任何 app；`app/runner/src` 导入 npm 包或在运行时导入 protocol；本地导入或已声明别名解析失败；非字面量的动态导入；`app/` 下出现没登记边界的新包；`.d.ts` 声明文件跨包导入，runner 的 `.d.ts` 导入 npm 包；经点开头目录里的文件转手 re-export 另一个包；`app/runner/src` 引用 `src/` 以外的文件（`.ts`、`.mjs` 或副作用导入）；包没登记进 `pnpm-workspace.yaml`，或缺 `typecheck`、`build` 脚本 |
| 公开安全（`check-public-safety`） | `tests/tooling/public-safety.test.ts` | 已跟踪或未跟踪（未被忽略）的文件里出现私网、CGNAT、链路本地地址，组网（mesh）主机名，或登记过哈希的被禁 token 与 IPv4（包括被禁词与别的词、数字连写，如 `<词>bot`、`<词>01`、全大写缩写接小写）；文件名、目录名或符号链接目标里含被禁词；放行清单的 `reason`、`path` 含被禁词或私网地址；快照目录（`reference/`、`snapshot/`）里没登记进清单的文件；`notes/` 下的私网地址、组网主机名或被禁 IPv4（`notes/` 只免被禁 token 比对，被禁词在 `notes/` 之外照报）；放行项缺路径、原文或理由；被禁清单格式不对；`--hash` 收到多个 token、汉字或越界 IPv4（必须以非 0 退出，不打印哈希） |
| 密钥（`check-secrets`） | `tests/tooling/secrets.test.ts` | env 模板里 `MODEL_GATEWAY_API_KEY`、`SETUP_KEY`、`JOIN_KEY`、`MASTER_KEY`、`BACKUP_KEY` 有值，或 `*_BACKUP_KEY_FILE` 不是路径；出现 GitHub 令牌、私钥材料或 `sk-` 开头的长串形态（包括 `Dockerfile`、`.npmrc`、没有扩展名的文件里）；未被忽略的私有 env 与数据库文件；`*.pem`、`id_ed25519` 这类私钥文件；`.db.bak`、`.sqlite-wal` 这类附属与备份库文件；仓库的 `.gitignore` 把 `repo.db.ts`、`schema.dbml` 这类源码和文档静默忽略 |
| PR 正文（`pr-contract`） | `tests/tooling/pr-contract.test.ts` | 缺少九段中的任一段或段落为空；`Closes` 的 issue 号与分支号不一致；验收证据没有截图、录屏、附件或无界面变化的理由；审查结论不是三种之一；结论行或 `Closes` 只写在注释、代码块里；另一段的代码块里写了 `### 审查结论` 和结论行；验收证据只写在代码块或行内代码里；`issue-lifecycle.yml` 的 sparse-checkout 漏了 `pr-contract.mjs` 递归导入的仓库内文件，或它导入了 Node 内置模块以外的包 |
| 任务 worktree（`task.mjs`） | `tests/tooling/task-worktree.test.ts` | PR 未合并、issue 未放弃或工作区不干净时清理 worktree；按路径前缀把 `task-3` 误当成 `task-35`；`start`、`finish` 收到非数字的 issue 号（必须打印用法并以 2 退出）；开工记录里的基线提交不是完整 40 位 SHA；`start` 缺执行记录身份时没在查 issue 之前以 1 退出；gh 因网络或 TLS 失败时被当成「issue 查不到」、提示先开 issue（必须报「查 issue 状态失败」并附上 gh 的错误） |
| 执行记录（`note.mjs`） | `tests/tooling/notes.test.ts` | 缺身份、阶段不认识、issue 不是数字、必填为空时写入；目录不是 `<日期>/<用户名>/<链路>.md`、日期无效、标题或负责人与目录不一致、执行者格式不对、记录标题不是北京时间、缺必填项、时间倒退、task 链路第一条不是「开工」、收尾之后还有记录、`INDEX.md` 过期、`notes/` 下有杂项文件或符号链接；task PR 缺引用本 issue 的「开工」「提交」「PR」「审查」、只引用别的 issue、没新增记录、改写或删除已进 base 的记录、比较基线解析不了时当作通过；刚开工的 worktree 把记录暂存走、合并后的记录写进 worktree；暂存并入时吞掉别的 worktree 还在用的链路，或并入接不上「开工」的 task 链路；不认识的子命令或参数以 0 退出 |
| 分支与 tag（`check-branch-invariants`、`release-tags`） | `tests/tooling/branch-invariants.test.ts`、`tests/tooling/branch-regex-parity.test.ts`、`tests/tooling/release-tags.test.ts` | 见下文「分支、环境与发布门禁回归」；`task.mjs`、`pr-contract.mjs` 的 `TASK_BRANCH_RE` 去掉捕获组后与 `check-branch-invariants.mjs` 不一致 |
| 规范独立（不引用别的项目） | `tests/tooling/standalone-refs.test.ts` | 入库或未忽略的文件（上游 Tuffex 快照 `reference/`、`snapshot/` 除外）的路径、内容或符号链接目标里出现旧项目名、旧仓库名或旧规范的来源提交号（测试里这些标识在运行时拼出，不留明文） |
| 组件文档快照（`tuffex-docs`） | `tests/tooling/tuffex-docs.test.ts` | 快照文件被改动；`reference/`、`snapshot/` 下有清单没登记的文件；路径穿越、绝对路径或符号链接目标；生成文件里写死项目名 |
| 标签声明（`scripts/labels.mjs`） | `tests/tooling/labels.test.ts` | `labels.yml` 颜色或说明不合规；issue 模板引用了没声明的标签；「端」下拉不是八个端；不认识的参数以 0 退出 |
| control 镜像（`ci.yml` 的 `docker` job，#3） | `tests/tooling/ci-docker.test.ts` | 断言脚本在 `Config.User` 为空、`root`、`0`、`0:0`，容器 uid 为 0，没有 HEALTHCHECK 或是 `NONE` 时以 0 退出（脚本从 `ci.yml` 取出、按 GitHub 的 bash 参数执行，`docker` 换成桩）；job 出现 `docker push`、`docker login`；`verify` 的 `needs` 或汇总条件漏了 `docker` |
| PR 目标分支（`issue-lifecycle.yml` 的 `pr-base`） | `tests/tooling/labels.test.ts` | PR 指向 `stage` 以外的分支（`main`、`dev/alice`、`task/12/review_queue`、`stage2`、空）时不以 1 退出；`pr-base` 不随 edited 触发；`pr-contract`、`close-on-merge` 没限定只处理指向 `stage` 的 PR |

`app/node`、`app/runner`、`packages/protocol` 现在只有最小源码，各有一份最小测试：`tests/node/config.test.ts`（节点配置校验）、`tests/runner/omp-args.test.ts`（omp 参数）、`tests/protocol/protocol.test.ts`（协议常量与通道映射）；另由各包的 `typecheck` 与 `build` 证明各包能编译、能类型导入 `@geek-bot/protocol`。这些测试只证明工作区与工具链可用，不证明任何业务功能。

control（#3）：`tests/control/` 在系统临时目录里起真实的库和 control（不监听或监听随机端口），不读 `.env`、不联网，密钥每次随机生成，时间用假时钟。`config.test.ts`：产品默认值与部署配置（实例角色必填、S-20 的监听与 origin、密钥变量直接写值被拒且不回显、`*_KEY_FILE` 误填密钥原文或不是路径写法时被拒且不回显、两个密钥文件不能相同）；`logging.test.ts`：S-16 列出的每种密钥形态、已知密钥原值、敏感键名在日志与打码里都被替换，另有一条「不打码就会带出令牌」的反例；`database.test.ts`：连接参数与独占锁（第二个连接打不开）、迁移器（空库迁到最新、上一版本的库迁到最新、兼容版本高于代码拒绝、回滚情形、迁移中途失败回滚、迁移文件被改、不是本产品的库、`schema_migrations` 编号不连续；`shrink=false` 的迁移删表、删列、改名、删索引、重写触发器、重建表丢列或改类型或加 `NOT NULL` 都被拒绝，大小写与注释混写也一样，按官方步骤重建表放宽 `CHECK` 通过）、审计只追加、告警去重；`backup.test.ts`：备份→恢复→`integrity_check` 往返、密文里没有明文、改字节或改头部或换密钥或登记不符都判失败并写告警、保留策略、启动时补登记、每日任务的到点与 weekly 判定；`server.test.ts`：`/healthz`、`/readyz`（含 503 的检查项）、错误格式与多余字段 400、415、413、400，拒绝启动的各种原因（删掉 master key 后、把密钥原文误填进 `*_KEY_FILE` 时，报错与日志都不含任何密钥内容），迁移前备份，上一版代码打开新库能启动能读写，第二个 control 拒绝启动，SIGTERM 后 WAL 已 checkpoint（只拷库文件本身就能读到停机前的行）；`cli.test.ts`：`backup`、`verify-backup` 经本地通道与离线执行、离线拿不到锁时失败、`restore --dry-run` 不改任何东西、用法错误以 2 退出、误填密钥原文时 stderr 不回显。镜像的非 root 与 HEALTHCHECK 由 CI 的 `docker` job 断言，本机 `docker run` 的实测结果写在 PR 里，不由 `pnpm test` 覆盖。

console（#4）：`tests/console/` 覆盖 `lib/` 与样板数据（时长格式化；API 客户端的错误格式、网络错误、非 JSON 响应、取消、路径白名单与各种写法的点段；页面状态映射；SSE 的连接、断线轮询、CLOSED 后退避重建、`reset`、`session_expired`；样板数据的各场景与「不调用真实 fetch」；浏览器回归所用被禁符号正则的逐类自测）。`tests/e2e/` 是浏览器回归：每个页面在 1280px 与 390px 下断言没有原生 select 与 checkbox、emoji 与被禁符号扫描为 0、图标都有图形、没有页面级横向溢出；外壳与主内容区没有被 overflow 截掉的内容；另有侧栏与抽屉导航、键盘（跳过链接、Tab 与 Enter、纯键盘打开抽屉、焦点进入并圈在抽屉里、Esc 与焦点归还、关闭的抽屉键盘进不去）、断网提示、样板数据标识、各数据状态；每个用例结束时断言没有请求离开浏览器（上下文级的外部请求、WebSocket 与 `/api/` 请求都为 0）。

## 回归矩阵（计划中，随对应 issue 加入）

下表是每个包必须具备的回归。对应 issue 合并时这些用例必须同时进入 `tests/<包>/`；没进的写「未验证」，不写成已覆盖。

| 包 | 必须覆盖 | 随哪个 issue 加入 |
|---|---|---|
| control | 迁移前生成备份；库的兼容版本高于代码认识的版本时拒绝启动，上一版代码打开只扩不缩的新库仍能启动、能读写（ADR-0008）；备份→恢复→`integrity_check` 往返一致；日志打码覆盖 `ghp_`、`gho_`、`github_pat_`、`sk-`、`gbn_`、`gbt_`、`Bearer`；SIGTERM 后 WAL 已 checkpoint（已加入：`tests/control/`，见上文「control（#3）」） | #3 |
| control | device flow 的 `authorization_pending`、`slow_down`、`expired_token`；没有认领码不能成为 owner；`X-OAuth-Scopes` 超出 `repo`、`read:org` 的令牌被拒（旧拒绝名里的 5 个 scope 作为样例）；没有会话访问后台接口 401，operator、viewer 调用 owner 专属操作 403，超过 10 分钟未重新认证的 owner 做 SECURITY S-09 清单里的操作被拒；缺 Origin 的写请求 403；被邀请管理员的登录令牌被吊销；响应和日志里没有令牌；库里令牌列是密文 | #5 |
| control | 权限到能力映射的每一行；需要组织批准的识别；仓库消失记为 lost；已归档仓库禁用写入开关 | #6 |
| control | ETag 条件请求与 304；受理规则每一条；静默窗口不被机器人自身写入重置、判断回复时排除 `[bot]` 账号；新 head 让旧审查变为 superseded；两通道优先级 | #8 |
| control | 写入白名单每一个编号的允许与拒绝，至少 30 个越权样例（APPROVE、REQUEST_CHANGES、空 event，推 tag、推默认分支或 `stage`/`main`、非快进推送，改 `.github/workflows`，跨仓库或跨条目写入，合并、删分支、关闭 PR）；崩溃注入后不产生第二条评论；模型输出中的注释标记、结论行、`Closes #n`、@ 他人被中和 | #9 |
| control | 规则来源的优先级；仓库文件不能放宽后台的禁改路径；PR head 改了 `AGENTS.md` 或 `.github/geek-bot.yml` 时画像不变 | #10 |
| control | 池外模型 403、过期令牌 401、超预算 429；没有 efforts 的模型只能选 off | #13 |
| control | 用假时钟走完第 5 天提醒、第 7 天关闭、2 轮上限；人重开后不再关闭；issue 正文里的注入指令不引起其它条目上的写入 | #16 |
| control | 修复通道拒绝推 tag、推默认分支和 base 分支、非快进推送、合并、从 fork 开 PR、推别人的分支 | #18 |
| console | `vue-tsc` 通过；页面上原生 `select` 与 `input[type=checkbox]` 数量为 0；emoji 扫描为 0；390px 下没有页面级横向溢出；窄屏抽屉可用；键盘可达；样板数据模式下外部请求数为 0（已加入：`tests/console/`、`tests/e2e/`） | #4 |
| console | 「认领→登录→设为机器人」界面流程；模型池拖拽与窄屏上移、下移排序 | #5、#13 |
| node | 两端 schema 一致；epoch 过期的结果返回 409；失联 10 分钟后两侧对称判定并重排；control 重启后的宽限；重置令牌后旧令牌 401；协议版本在 N、N-1 范围内的节点正常派任务，范围外的节点只收心跳、不被派任务；主机健康越线自动 cordon | #11 |
| node | VM 执行器：取消后 qemu 退出、没有残留 overlay；资源不足时 VM 槽位为 0；真实 KVM 冒烟手动跑 | #12、#17 |
| node | 多节点：按信任等级与标签分配；掉线后在另一台节点重跑且 GitHub 上只有一次写入；排空 | #19 |
| runner | 降级分类器夹具（成功、429、5xx、超时、缺少结束事件；上下文溢出与取消不降级）；剔除 `.omp`、`.claude`、`mcp.json`、`.env*`；恶意夹具的标记文件不存在 | #14 |
| protocol | 节点消息、TaskSpec、结果、catalog 的 JSON Schema 与 TypeScript 类型一致 | #11、#13 |

工程检查要覆盖真实导入解析（静态、动态、type、re-export、`require`）、Vue 单文件组件只解析 `<script>`、tsconfig 路径别名、反向依赖（任何 app 互相导入、protocol 导入 app、`app/runner/src` 导入 npm 包），以及文档同步。

## 分支、环境与发布门禁回归

`tests/tooling/deployment-environment.test.ts`（随 #7 加入）在临时目录合成夹具，验证 `.env.production` / `.env.preview` 的字段契约（只许占位符与通用默认值、契约外字段拒绝、密钥项必须留空或是 `*_FILE` 路径、两环境的 compose 项目与端口必须不同）与 `deploy/environments.json` 的一致性；它不读取真实密钥、不连接服务器。在它加入之前，`check-secrets` 已经覆盖 `deploy/env/.env.*` 与根 `.env.example` 里密钥项不得有值这一条。

分支不变量由 `scripts/check-branch-invariants.mjs` 检查（`tests/tooling/branch-invariants.test.ts` 用临时 Git 仓库覆盖不变量、命名规则与 pre-push 的发布 tag 规则：格式错误、rc 不在 stage、正式 tag 不在 main、同提交缺 rc 只告警、版本号不符、删除或移动发布 tag、附注 tag、非发布 tag 只告警）：`--require-remote-refs` 在 CI 上核对真实远端 refs，`--push` 供本地 pre-push 使用；本地也可以用同一命令自查（见 [BRANCHING](BRANCHING.md)）。这类检查只读 Git 证据，不 fetch、不改 refs。

`tests/tooling/release-tags.test.ts` 覆盖 tag 语法：tag 正则与 [RELEASES](RELEASES.md) 逐字一致；`vX.Y.Z-rc.N` → preview、`vX.Y.Z` → production；拒绝分支名、`latest`、短 SHA 与格式错误的 tag。

发布规划器的测试（随 #7 加入）在临时 Git 仓库里覆盖：拒绝不在 `stage` 上的 rc、不在 `main` 上的正式 tag、同一提交没有同版本 rc 的正式 tag、版本与该提交 `package.json` 不符、已正式发布的版本再打 rc、本地 tag 指向别的提交；镜像引用是 ghcr，正式版复用 rc 的 digest；以及「规划只读」（不写文件、不改 refs、不动工作区）。部署脚本的测试（`tests/tooling/deploy-scripts.test.ts`，随 #7 加入）覆盖 digest 核对、串行锁、健康门失败自动回滚。展示值的测试（随 #7 加入）覆盖：预发布只接受 `X.Y.Z-rc.N@<sha12>`，正式只接受 `X.Y.Z`。任何规划输出都**不授予**部署批准（`deploymentAuthorized: false`），自动测试也不替代人工试用。

## 报告

报告分别记录：工具测试、各包测试、类型检查、构建、浏览器场景、VM 冒烟、实例验收，以及未执行的项目和原因。验收中修改源码后重跑相关验证。

证据类型不能互相替代：类型检查通过不代表行为正确，构建成功不代表能运行，mock 或样板数据界面不代表真实后端，本机运行不代表预发布实例，预发布实例不代表正式实例；自动化 PASS 只是机器验证，不能代替人工验收（见 [RELEASES](RELEASES.md)）。登录、publisher、VM 或上线还没实现时必须明确写「未实现」或「未验证」，禁止写「已完成」。
