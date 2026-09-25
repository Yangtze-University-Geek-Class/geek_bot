# control 服务契约（`app/control`）

> 控制面：唯一的 SQLite 写入者和唯一的 GitHub 写入者，负责登录、令牌、仓库发现、轮询、调度和模型中继，并同源托管 console。

状态：`proposed` · 更新：2026-09-25 · 适用：`app/control`（`@geek-bot/control`）、`tests/control`

## 职责

control 是一个 Fastify 5 + better-sqlite3 的单进程服务（两者都是计划中的依赖，#1 没有引入）：

- 唯一的 SQLite 写入者：调度、租约、outbox 都在同一个进程里完成；
- 唯一的 GitHub 写入者：一切写入只经 publisher（写入白名单 + outbox）；
- 负责首次认领、登录、机器人令牌的加密存放和校验、仓库发现与权限映射、条件请求轮询、工作项推导、调度与租约、规则画像、模型中继、确定性动作（提醒、到期关闭）、审计、备份与恢复校验；
- 同源托管 console 的静态产物。

control 从不运行 omp，也不执行目标仓库里的任何代码。

## 现在有什么

#1 只建最小源码：没有 HTTP 服务、没有数据库、没有生产依赖，只有一份可以单测的配置模块。

| 路径 | 内容 |
|---|---|
| `app/control/package.json` | 包名 `@geek-bot/control`，依赖 `@geek-bot/protocol: workspace:*`；脚本 `typecheck`（`tsc --noEmit`）、`build` |
| `app/control/tsconfig.json` | 继承根 `tsconfig.base.json`，`src/` 编译到 `dist/` |
| `app/control/src/config.ts` | 产品默认值 `CONTROL_DEFAULTS`（轮询 60 秒、静默窗口 300 秒、第 5 天提醒、第 7 天关闭、最多追问 2 轮、每台 VM 1 vCPU / 2048 MiB），每项对应的环境变量名表 `CONTROL_ENV`（都以 `GEEK_BOT_` 开头），以及 `createControlConfig(env)`：按默认值加环境变量覆盖生成配置。它是纯函数，不读 `process.env`、不读文件；有不合法的值时抛 `ControlConfigError`，一次列出全部问题，并要求关闭天数大于提醒天数 |
| `app/control/src/index.ts` | 包入口，只导出上面的配置 |
| `tests/control/config.test.ts` | 默认值、环境变量覆盖、非法值拒绝、关闭天数必须大于提醒天数 |

新增或删除文件时同步更新本表。

## 计划中的模块与对应 issue

| 模块（计划路径） | 内容 | issue |
|---|---|---|
| `src/{index,app,services,config,cli}.ts` | 进程入口、Fastify 装配、配置解析（在现有 `config.ts` 上扩展；密钥只从 `*_FILE` 读）、CLI（bootstrap-code、backup、restore --dry-run、verify-backup、rotate-master-key） | #3、#5 |
| `src/db/`、`src/db/migrations/NNNN_*.sql` | SQLite 版本化迁移，只扩不缩；库版本比代码新时拒绝启动 | #3 |
| `src/ops/` | `/healthz`、`/readyz`、备份、每日恢复校验、保留策略、告警 | #3、#20 |
| `src/routes/auth`、`admins`、`bot-account` | 认领码、device flow 登录、管理员邀请、会话、机器人账号绑定与令牌校验 | #5 |
| `src/secrets/` | 机器人令牌 AES-256-GCM 加密、master key 轮换 | #5 |
| `src/github/{client,etag,budget,discovery}.ts`、`src/routes/repos` | 仓库发现、权限到能力的映射、可分配性、逐仓库开关 | #6 |
| `src/github/poller.ts`、`src/intake/`、`src/scheduler/`、`src/routes/items`、`tasks` | 条件请求轮询、受理规则、静默窗口、两通道优先级队列 | #8 |
| `src/publisher/{whitelist,neutralize,outbox,rate}.ts`、`src/github/markers.ts` | 写入白名单、输出中和、隐藏标记、outbox 幂等、写入限速 | #9 |
| `src/github/rules.ts`、`defaults/` | 每仓库规则画像（只读 base 分支）、内置默认规范 | #10 |
| `src/routes/nodes`、`node-api`、`src/bundle/`、`src/mirror/` | 节点令牌、节点 API、租约与 epoch、任务包、镜像克隆 | #11、#14 |
| `src/models/`、`src/routes/model-relay`、`models` | catalog 读取、模型池、每任务模型令牌、模型中继 | #13 |
| `src/routes/stream` | SSE 实时推送 | #14 |
| PR 审查、issue 受理与跟进、修复与返工的业务逻辑 | 按下文默认行为执行 | #15、#16、#18 |
| `Dockerfile` | 多阶段构建，打进 console 产物；非 root，带 HEALTHCHECK | #3、#7 |

子文档（behavior、write-whitelist、data-model）由 #2 写入；scheduler、github、models 的说明随 #8、#6、#13 写入。

## 接口与数据归属（计划中）

- 后台 API：`/api/v1/*`，加 SSE `/api/v1/stream`；服务端按角色鉴权，入参用 JSON Schema 声明并拒绝未知字段。契约文档 API.md 由 #2、#3 写入。
- 节点 API：`/api/node/v1/*`（heartbeat、lease、bundle、events、result、model），节点用 bearer 节点令牌认证。消息表由 #2 写入，schema 由 #11 放进 protocol。
- 数据：SQLite 文件只有 control 写，preview 与 production 各一个库。表清单由 #2 写入 data-model。
- GitHub：读取层与 publisher 是仅有的两处能解密机器人令牌的代码；GitHub 写入只经 publisher。
- 密钥：master key、OAuth client secret、模型网关密钥都以 `*_FILE` 文件挂载，只给 control。

## 计划中的默认行为

下面是所有者定下的机器人行为规则。它们每一条都是产品的**默认值，可配置**：部署者可以按仓库或全局修改，产品代码里不写死。其中几条同时是 publisher 写入白名单里的拒绝规则（括号里注明），改这几条等于放宽白名单，要按 [SECURITY](../../architecture/SECURITY.md) 的 S-06、S-07 取得所有者批准，并补上对应的拒绝测试。配置项的名字和取值范围由 #2 在 behavior 子文档定稿，实现分别在 #8、#9、#13、#15、#16、#17、#18。

已经有代码的只有几个数值默认：轮询间隔、静默窗口、提醒与关闭天数、追问轮数、VM 规格写在 `app/control/src/config.ts`，目前可以用 `GEEK_BOT_*` 环境变量覆盖；PR 通道优先级的默认顺序写在 `@geek-bot/protocol` 的 `PR_CHANNEL_PRIORITY`。其余规则还没有实现。

### PR

- 已开启「审查 PR」的仓库里，别人开的 PR 都审，机器人自己开的 PR 不审（避免自我审查）；来自 fork 的 PR 照常审，只发评论；审查前已经合并的也补审，control 停机恢复后只补审 72 小时以内的；同一个 PR 只审最新的提交。新发现的仓库默认只监控，「审查 PR」要逐个仓库开启。（默认值，可配置）
- 审查只以 review 的 `COMMENT` 类型发出；机器人不批准、不请求修改、不合并。批准与合并始终由人来做。（默认值，可配置：可以按仓库关掉审查、改评论格式；review 类型只许 `COMMENT` 同时是白名单规则，见 S-06）
- 机器人开的 PR，结论段固定写「阻塞」，等人审查。（默认值，可配置：结论段的写法跟随仓库画像）

### issue：谁来做

- 分给了人：不接、不追问、不关、不改写；关联的 PR 照样审。（默认值，可配置）
- 分给了机器人账号：优先接，排在 issue 通道的最前。（默认值，可配置）
- 打了 `bot:manual`：不接。（默认值，可配置：标签名可改）
- 已经有开着的关联 PR（分支名按仓库画像能对应到这个 issue、正文写了 `Closes`/`Fixes`/`Resolves`/`Refs` 这个号，或时间线引用了它）：不重复做，转去审那个 PR。（默认值，可配置）
- 开工前、发出评论或 PR 前，各复核一次上面的条件；条件变了就放弃，并在 issue 留一条说明，不关 issue。（默认值，可配置）

### issue：追问、提醒与关闭

- 描述不清或复现不了：发一条追问记录写明缺什么，打 `bot:blocked`，进入「等回复」。（默认值，可配置）
- 追问之后，出现一条非机器人账号的评论，或者作者修改了正文，就算有人回复；判断时排除一切 `[bot]` 账号。（默认值，可配置）
- 没人回复：第 5 天提醒一次，第 7 天发关闭记录后关闭。（默认值，可配置）
- 同一个 issue 最多追问 2 轮，仍不清楚就关闭，并写明缺什么。（默认值，可配置）
- 价值不高（重复、已解决、不属于本仓库、没法执行）：先发关闭记录写明原因，再关闭；重复的引用原 issue。（默认值，可配置）
- 回复后说清楚了、但正文不合该仓库的规范：按仓库模板新开一个合规的 issue，正文引用原 issue 并 @ 原作者；再在原 issue 发关闭记录写明被新 issue 取代，关闭原 issue。新 issue 由机器人跟进。（默认值，可配置）
- 人重开过的 issue，机器人不再关，只评论。（默认值，可配置；同时是白名单规则，见 S-06）
- 机器人只关 issue，不关 PR。（默认值，可配置；同时是白名单规则，见 S-06）

### 小改动

机器人自己决定修的只限小改动：只改一个服务；不碰认证、授权、密钥、`.env`、数据库结构、部署与 CI 配置；没有界面变化；能写出区分修复前后的回归测试。超出范围的只发一条说明，不开 PR。（默认值，可配置：只能收紧，不能放宽安全相关的几项）

### 执行与调度

- issue 通道不开 VM：在无网、根只读、不挂令牌的 sandbox 容器里只读代码，不执行代码。（默认值，可配置）
- PR 通道每个任务一台新的临时 VM，默认 1 vCPU / 2 GiB，任务结束即删除 VM 和它的磁盘。（默认值，可配置：规格可改，「每任务一台、用完即删」不变）
- 轮询间隔 60 秒；24 小时没有变化的仓库降到 5 分钟一次。（默认值，可配置）
- 条目最后一次非机器人变动后静默 5 分钟才进队列；机器人自己的写入不重新计时。（默认值，可配置，可按仓库、按类型设置）
- PR 通道优先级：审查别人的 PR > 自己 PR 的返工 > 修分给机器人的 issue > 机器人自己决定修的。（默认值，可配置）
- issue 通道优先级：分给机器人的 > 追问后收到回复的 > 未分配的受理 > 规则画像提取。（默认值，可配置）
- 两条通道各自排队；同一条目同时最多一个活跃任务，同一仓库同时最多一个写入类任务。（默认值，可配置）

### 模型

- 模型按任务类型分池（审查、分诊、跟进、修复、返工、规则画像），池内按顺序降级：本轮失败、超时或结果不合格时换下一个模型；上下文溢出和主动取消不降级；池走完判失败，由人重新排队。（默认值，可配置）
- 池里的模型和思考档位都来自部署者提供的只读 catalog 文件；产品不内置具体模型。（默认值，可配置）

### 记录格式

- 机器人在 GitHub 上的记录按仓库画像里的格式写；仓库没有自己的格式时，记录头默认用 `<!-- track v1 kind=<类型> stage=<阶段> -->`，可以在 `stage=` 后加 `actor=bot model=<id> effort=<档位> commit=<40 位 SHA>`。（默认值，可配置）
- 每条写入另带隐藏标记 `<!-- geek-bot v1 ... -->`，用于幂等和从 GitHub 重建状态。这是产品标识，不是追踪规范。（计划中，见 ADR-0005 与 ADR-0008，由 #2 写入；实现在 #9）

## 验证

```bash
pnpm --filter @geek-bot/control typecheck
pnpm exec vitest run tests/control
```

## 已知限制

- #1 没有实现任何业务功能，也没有 HTTP 服务；上文的模块、接口、默认行为都是计划，落地前不能当作现状引用。
- Fastify、better-sqlite3 等生产依赖都没有引入，由 #3 起逐步引入。
- 免费计划的私有仓库没有分支保护和 rulesets，OAuth `repo` scope 也不能按仓库收窄；「不推主干、不打 tag、不合并」完全依赖 publisher 代码，见 [SECURITY](../../architecture/SECURITY.md)。
