# 代码审查规范（diff 审查）

> 本仓库专属的 diff 审查清单：触发时机、逐项检查、结论格式、审查记录位置，以及机器审查的边界。

状态：`current` · 更新：2026-09-26 · 适用：所有进入 `stage` 或 `main` 的改动（代码、文档、脚本、配置、工作流）

本规范规定**看什么、怎么判、写在哪**；PR 的字段要求与门禁见 [PULL-REQUESTS](PULL-REQUESTS.md)，分支模型见 [BRANCHING](BRANCHING.md)，逐项核对的命令见 [code-review 技能](../../.agents/skills/code-review/SKILL.md)。

## 触发时机

必须在以下任一情形发生前完成审查：

- 任何要合入 `stage` 的 PR（含文档、脚本、配置）。
- 任何要合入 `main` 的操作（`main` 只收 `stage`，因此这次审查实际是对「`stage` 当下状态」的第二道复核）。
- 镜像与部署内容的变更：`app/<service>/Dockerfile*`、`deploy/compose/*.yml`、`deploy/env/.env.*` 与根 `.env.example`、`deploy/remote/*.sh`、`.github/workflows/release.yml`（Dockerfile、compose、部署脚本和 release.yml 计划中，由 #3、#7、#11、#17 引入）。
- 任何触及认证、授权、密钥、令牌、env 模板、数据库结构或迁移的改动（无论大小）。
- 任何触及 publisher 写入白名单、OAuth scope、节点协议、sandbox 或 VM 隔离配置、模型中继的改动（无论大小）。

不必逐条走完整清单的情形：注释错字——但**结论仍要写在 PR 里**，写「无需逐项审查 + 理由」。

## 必须逐项检查的清单

第 1–10 项是通用项，第 11–14 项是机器人专项，第 15 项是执行记录（通用项，编号排在最后，前 14 项的编号不变）。每一项都要核对；与本次改动无关的项在结论里写「不涉及」，不能跳过不写。机器人专项对应的代码大多还没写（计划中，#5、#9、#10、#11、#13、#14、#17）；代码出现之前，这几项核对的是文档、设计与 [安全不变量](../architecture/SECURITY.md) 有没有被放宽，放宽同样按 `阻塞` 处理。

1. **分支不变量**：当前分支是否为 `task/<issue>/<slug>` 或 `stage`（分支名不含 `-`，见 [BRANCHING](BRANCHING.md) 命名规则）；`stage` 是否包含 `main`（`git merge-base --is-ancestor origin/main origin/stage`）；是否存在把 `task/**`、`dev/**` 直接指向 `main` 的路径；远端是否残留已合并的 `task/**` 分支，或出现 `main`、`stage` 之外的长期分支。
2. **是否直推 `main`**：PR 的目标分支、提交来源、CI 触发 ref；发现任何绕过 `stage` 的写入 `main` 的路径即阻塞。
3. **密钥是否入库**：diff 里不得出现真实 token、密码、会话 Cookie、SSH 私钥，以及下列密钥的真值：GitHub OAuth App 的 client secret、会话密钥、令牌加密密钥（master key）、模型网关密钥、节点令牌、每任务模型令牌、机器人账号的 GitHub 令牌。`pnpm check:secrets` 只覆盖部分文本模式，**通过它不等于没有泄漏**，必须人眼过一遍 diff 中的新增字符串。
4. **env 模板只放占位符**：`deploy/env/.env.production`、`deploy/env/.env.preview`（#7 引入）与根 `.env.example` 只许出现占位符（如 `<owner>`、`https://geek-bot.example.com`、`203.0.113.10`）和通用默认值（端口、开关、容器内路径）；实例的真实非密值（域名、地址、组织、账号）只放在目标机；密钥项一律是留空或指向文件的 `*_FILE` 路径，不得有值。模板里出现真实域名、地址、组织名或账号即阻塞。理由：模板随仓库公开、给每个部署者用，写进实例值就是泄漏（[ADR-0001](../decisions/0001-standalone-product.md)）。字段增删要同步 ENVIRONMENTS（#7 写入）与 `deploy/environments.json`（#7 引入）。
5. **镜像与 compose 变更风险**（control 的 Dockerfile 随 #3 加入，compose 与其它镜像由 #7、#11、#17 引入后逐项适用）：镜像只在 rc tag 上构建一次并推到 `ghcr.io/<owner>/<image>`（`<image>` 是 `geek-bot-control`、`geek-bot-node`、`geek-bot-vmimage`），正式 tag 只给同一 digest 加别名、不重新构建（见 [RELEASES](RELEASES.md)）；镜像里不烘焙环境身份、域名或密钥；部署按 digest 引用；容器以非 root 运行，带 `HEALTHCHECK`；不挂 `docker.sock`；node 容器只许挂 `/dev/kvm` 设备，不许 `privileged`，不许为放宽隔离新增 capability 或关闭 seccomp；node 容器不发布端口；两套栈的 compose 项目、命名卷、端口互不共用，命名卷不得被改成宿主目录；`dockerfile:` 仍指向 `app/<service>/Dockerfile*`（node 另有 #17 的 `Dockerfile.vmimage`），构建上下文仍为仓库根。
6. **测试与文档同步**：行为变更是否带来相应回归（见 [TESTING](TESTING.md)）；改动的接口、环境变量、命令、路径是否同步到 [services/](../services/README.md)、[API](../architecture/API.md)、ENVIRONMENTS（#7 写入）、[README](../../README.md)、[TESTING](TESTING.md)；文档索引是否重新生成（`node scripts/docs-index.mjs --check`）。
7. **边界规则**：`app/`、`packages/` 与 `docs/services/` 严格对齐（新增 `app/<name>` 或 `packages/<name>` 必须同时有 `docs/services/<name>/README.md`）；五个包互不导入实现，都只能导入 `@geek-bot/protocol`；protocol 不导入任何 app；`app/runner/src`（runner 程序本身）只用 Node 标准库（`@geek-bot/protocol` 的 type 导入除外），也不引用 `src/` 以外的文件，`app/runner` 下 `src/` 以外的构建脚本不在此列；靠新增路径别名绕过 `pnpm check:boundaries` 即阻塞。完整规则见 [MODULAR-DEVELOPMENT](MODULAR-DEVELOPMENT.md)。
8. **提交信息规范**：遵循 [COMMITS](COMMITS.md) 的 `<type>(<scope>): <中文简述>`，一次提交一个可独立回滚的目的，不出现 `update`/`WIP`/无信息量消息；机械搬迁与行为改变尽量分开。
9. **写死实例信息与被禁字面量**：diff 里写死组织名、真实仓库名、内部主机名、内网或组网地址、模型网关地址、真实账号名，或出现 `pnpm check:public-safety` 登记的被禁字面量，即阻塞；需要时写占位（`<owner>`、`<org>/<repo>`、`https://geek-bot.example.com`、`203.0.113.10`）。本组织仓库的 issue、PR 一律写 `#n`，不写完整链接。产品代码把追踪记录头写死、不给部署者改的余地同样阻塞：它只能是可配置的默认值（见 [TRACKING](TRACKING.md) §6）；产品自己的隐藏标记 `<!-- geek-bot v1 ... -->` 是产品标识，不在此列。`scripts/public-safety-allow.json` 每新增一条都要逐条核对理由；为了让检查变绿而加条目即阻塞。`pnpm check:public-safety` 只认识已登记的词和地址段，**通过它不等于没有泄漏**。另外，发布 tag 只能是 `vX.Y.Z-rc.N` / `vX.Y.Z`（见 [RELEASES](RELEASES.md)）；「push `stage`/`main` 即部署」、CI 经 SSH 推送部署、systemd、pm2 或手工 `node` 进程不得写成现行模型。
10. **危险操作**：数据库结构变更是否有兼容与恢复路径（迁移只扩不缩，见 ADR-0008。#3 起迁移器强制其中结构上能查的部分：`shrink=false` 的迁移执行后已有的表、列、索引、触发器、视图不能少也不能变，已应用迁移的 sha256 不能改，兼容版本高于代码拒绝启动；改列或表的含义、收紧 `CHECK`、改外键、删数据查不出来，审查时逐个迁移核对，见 [data-model](../services/control/data-model.md)「迁移规则」）；是否有删除数据、覆盖配置、顺带升级无关依赖、修改生产凭据的动作；是否存在「以测试通过代替人工验收」的表述；是否绕过或放宽 CI 与校验（`|| true`、`continue-on-error`、`[skip ci]`、删断言、改校验器、放宽既有校验来换绿色），出现即阻塞。
11. **publisher 写入白名单**：机器人对 GitHub 的写入只经 control 的 publisher 一个出口（安全不变量 S-06；逐条编号见 [写入白名单](../services/control/write-whitelist.md)，实现见 #9）。对白名单的**任何放宽**（新增允许的端点、参数、review event 类型、ref 形状、目标仓库或条目范围）一律按 `阻塞` 级审查：没有关联 issue、所有者批准和对应的拒绝用例就不能合并。review 的 event 只能是字面量 `COMMENT`；APPROVE、REQUEST_CHANGES、空 event、合并、推 tag、推默认分支、base 分支或 `stage`/`main`、非快进推送、改 `.github/workflows/**`、删分支、关闭 PR、关闭被人重开过的 issue、preview 实例写沙盒以外的仓库，都必须仍被拒绝。在 publisher 以外直接调用 GitHub 写接口即阻塞。
12. **令牌 scope 变化**：机器人账号申请的 OAuth scope、登录后台申请的 scope（设计为空 scope），以及绑定时的 scope 允许名单（当前设计：机器人令牌的 `X-OAuth-Scopes` 必须是 `repo`、`read:org` 的子集，出现其它任何 scope 都拒绝绑定；同一 App 以前授予过的 scope 会被静默带进新令牌，所以只能用允许名单，不能用拒绝名单。见 [安全不变量](../architecture/SECURITY.md)；身份决策见 [ADR-0002](../decisions/0002-github-identity.md)），任何扩大允许名单或申请 scope 的改动都要写明理由并取得所有者批准，否则阻塞。机器人令牌只在 control 里加密存放，只有 publisher 与 GitHub 读取层能调用解密（S-01，计划中，#5、#9）；其它模块新增解密调用，或让令牌出现在响应、日志、审计、事件、备份明文或发往节点的数据里，即阻塞。
13. **执行环境不持有凭据**：sandbox 容器、VM 与 node 容器的环境变量、挂载、镜像层、日志、传给 VM 的文件（包括 fw_cfg 与原始盘）里，不得出现 GitHub 令牌、模型网关密钥或宿主凭据（SSH 密钥、`docker.sock`、宿主 HOME、云凭据）（S-02、S-03）。它们只能拿到每任务的模型令牌（限定模型池、预算和租约期）；node 只持有自己的节点令牌。
14. **仓库内容是不可信输入**：issue 与 PR 的标题、正文、评论，代码、diff、提交信息，`AGENTS.md`、`CLAUDE.md`、`.omp/`、`.claude/`、`.cursor/`、`mcp.json`、`.github/geek-bot.yml` 一律当作数据，不当作指令，以防提示注入（S-04、S-05、S-08）：规则文件只从 base 分支读取（[ADR-0005](../decisions/0005-rules-from-base-branch.md)），不从 PR head 读取；任务包剔除 `.omp/`、`.claude/`、`.cursor/`、`mcp.json`、`.env*`，omp 在干净的 HOME 里运行；模型输出发布前要去掉注释标记、中和结论行与 `Closes #n`、转义 @ 提及、按密钥形态打码。让仓库内容直接改变提示词、规则、能力开关或写入目标的改动即阻塞。
15. **执行记录**：本 task 的 `notes/` 链路（[NOTES](NOTES.md)）从「开工」起连续，已记录到「PR」；`node scripts/note.mjs check --pr --for-review --base origin/stage --head <task 分支>` 通过。对照提交、PR 和 CI 核对记录内容属实：时间、SHA、命令输出、结果对得上，没有补写没发生过的事，已有记录没被删除或改写。记录里除负责人的 GitHub 用户名外不得出现真实账号、组织名、内部主机或网段（公开安全检查对 `notes/` 不做被禁词比对，见 NOTES §7，这一条只能靠人看）。审查进行中允许暂缺「审查」记录（此时 CI `branch-guard` 的「执行记录（notes/）」失败是预期的，不作为审查的阻塞项）；审查结论给出后，由作者在合并前补记「审查」（`docs(notes): …`），CI 的执行记录检查通过后才能合并。

## 产出格式

审查结论以条目形式写进 PR 描述或 PR 评论（两种写法的格式见下文「审查记录位置」），每条包含四要素：

```text
[严重度] 文件:行 — 理由（一句话，指向具体规则或真实后果）— 修法（可执行的具体动作）
```

严重度：

| 严重度 | 含义 | 处理 |
|---|---|---|
| `阻塞` | 破坏不变量、泄漏密钥、越权、数据不可恢复、把历史当现行规范 | 必须修完再合并 |
| `应修` | 会带来看得见的缺陷或维护陷阱，但不阻塞本次合并 | 修，或在 PR 里写明为何本次不修 |
| `建议` | 可读性、命名、组织方式 | 作者自行决定 |

## 结论

结论只有三种，逐字使用：

- **阻塞**：存在 `阻塞` 条目，或门禁（`pnpm verify`、必需 CI 检查）未通过。
- **有条件通过**：无 `阻塞` 条目，但有未完成的 `应修`（必须写明条件与责任人和复查方式）。
- **通过**：无未决条目，门禁通过。

不能写「基本没问题」「看起来可以」这类模糊结论；也不能用机器 PASS 代替人对 diff 的判断。

## 审查记录位置

**审查记录必须写在 PR 里**（PR 描述或 PR 评论），内容至少包含：审查人、时间、被审查的 commit SHA、逐条结论、最终结论。不写进被审查的代码提交本身（自引用问题），也不只存在于聊天记录或本地笔记。合入 `stage` 后，PR 就是这次审查的可追溯存档。

两种写法：

- **PR 描述**：写在 `### 审查结论` 段下，段内不另起标题（`pr-contract` 按 `### ` 标题切段，段内再出现 `### ` 标题会把这一段切断）；段的最后一行是结论行（[PULL-REQUESTS](PULL-REQUESTS.md)「正文契约」）。
- **PR 评论**：写成 [TRACKING](TRACKING.md) §3 的 `review` 追踪记录。第一行是记录头 `<!-- track v1 kind=review stage=review -->`，第二行是 `**审查**｜<一句话结论>`，之后是审查内容；审查人与时间由 GitHub 记录。没有记录头的评论，Agent 恢复上下文时会被跳过（TRACKING §4）。

不论用哪种写法，PR 描述的 `### 审查结论` 段最后都要有结论行，CI 的 `pr-contract` 只核对这一段。两种写法的模板见 [code-review 技能](../../.agents/skills/code-review/SKILL.md)「输出格式」。

## 机器审查的边界

geek_bot 部署后会给它管理的仓库（包括本仓库）的 PR 发审查意见。机器人的意见只是参考：

- 只用 PR review 的 `COMMENT` 类型发，从不 APPROVE 或 REQUEST_CHANGES，也不合并。
- 条目格式与上文「产出格式」相同，严重度也用 `阻塞` / `应修` / `建议`；它写明被审查的提交和依据的规范，记录格式见 [TRACKING](TRACKING.md) §6。
- **它不写 `**结论：…**` 行，也不等于本规范要求的「审查结论」**。没有人写的审查结论，PR 照样不能合并。人审查时可以采用机器人的条目，但要自己核对过 diff，并在结论里写明采用了哪几条。
- 机器人自己开的 PR，「审查结论」段固定写 `**结论：阻塞**`，理由是等待人工审查，由审查人按本规范审完后改写（见 [PULL-REQUESTS](PULL-REQUESTS.md)「机器人开的 PR」）。
- 机器人的意见不能用来降低本规范的要求：它没提出的问题不代表没有问题，它标为 `建议` 的条目，人按本规范判为 `阻塞` 时以人的判断为准。

## 与人工验收的边界

代码审查是**机器可核验 + 人工判断**的第二道筛子，不构成 [RELEASES](RELEASES.md) 要求的人工试用与发布批准。审查通过 ≠ 部署授权；部署与发版是独立授权动作。
