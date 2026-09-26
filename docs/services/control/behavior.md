# control 默认行为与配置项

> 机器人的每条默认行为规则（B-01…）：规则内容、配置项名、默认值、作用范围，以及哪几条同时是写入白名单的拒绝规则。

状态：`proposed` · 更新：2026-09-26 · 适用：`app/control` 的仓库开关、轮询入队、PR 审查、issue 受理与跟进、修复与返工、调度和模型池（由 #6、#8、#9、#10、#13、#15、#16、#17、#18 实现）

本文的规则都还没有实现，只是实现目标和审查基线。已经有代码的只有 `app/control/src/config.ts` 里的 7 个数值默认（轮询间隔、静默窗口、提醒与关闭天数、追问轮数、VM 规格）和 `@geek-bot/protocol` 的 `PR_CHANNEL_PRIORITY`；其余配置项名是本文定的，实现时照这里的名字写。改默认行为时同时改本文和 [control 服务契约](README.md)「计划中的默认行为」一节的摘要。

## 来源

- 所有者 2026-09-24、09-25 各轮定下的行为规则：PR 必审只评论；issue 两条通道；等回复第 5 天提醒、第 7 天关闭、最多追问 2 轮；改写后重开；PR 通道优先级；模型池降级；每任务一台临时 VM；写入白名单。所有者要求它们都是**可配置的默认值**，产品代码里不写死。
- #22「待所有者决定」里与行为有关的几项，所有者没有提出修改，按推荐做法写进本文：第 5 项 → B-24；第 12 项 → B-01、B-02；第 14 项 → B-21；第 15 项 → B-10、B-12；第 16 项 → B-16、B-17。
- 架构草案里的调度、失败处理和写入节奏默认值（[ARCHITECTURE](../../architecture/ARCHITECTURE.md)）。
- 追踪记录头见 [ADR-0010](../../decisions/0010-tracking-record-prefix.md)；规则来源与配置优先级见 [ADR-0005](../../decisions/0005-rules-from-base-branch.md)。

## 怎么读规则表

- **配置项**：写环境变量名（`GEEK_BOT_*`，全局）或仓库键（如 `review.own_prs`，可按仓库覆盖）。写「固定」的规则不开放配置。
- **默认值**：产品出厂值。部署者改了以后，以「配置的来源与优先级」一节的合并结果为准。
- **范围**：`全局` 只能在环境变量或后台「设置」里改；`按仓库` 还可以在仓库文件和后台对单个仓库的覆盖里改；`取更严` 表示各层合并时不按先后覆盖，而是取最严的值；能力开关和写入模式「以后台为基准，只能往下调」。合并规则见下一节。
- **白名单**：填了编号的规则同时由 publisher 在写入时强制，编号指 [写入白名单](write-whitelist.md) 里的允许项（W-xx）、拒绝项（D-xx）和共同前置核对（C-xx）。这几条不能靠改配置放宽；要放宽就是放宽白名单，按 [SECURITY](../../architecture/SECURITY.md) 的 S-06、S-07 取得所有者批准，并补对应的拒绝测试。写「—」的规则不由白名单强制。

## 配置的来源与优先级

机器可执行的配置只来自结构化来源，按 [ADR-0005](../../decisions/0005-rules-from-base-branch.md) 合并：

1. 仓库的 `.github/geek-bot.yml`，从默认分支（或该仓库配置的 base 分支）按 blob sha 读取，从不从 PR head 读取；
2. 后台对这个仓库的覆盖；
3. 仓库所在组织的 `.github` 仓库里的同名文件 `.github/geek-bot.yml`；
4. 内置默认。

上面四层里，数字小的优先。第 4 层「内置默认」本身再分三级，后面的优先：代码里的出厂值 → 环境变量 `GEEK_BOT_*` → 后台「设置」页保存的全局值。后台「恢复默认」删掉保存的值，回到环境变量或出厂值。配置项一览里标「只读」的项只认环境变量，后台改不了；标「只能收紧」的项后台只能改得比环境变量更严。

例外：

- **能力开关和写入模式以后台为基准，只能往下调。** 能力开关（`switches.*`）和写入模式（`write_mode`）的基准是后台对这个仓库的设置（新仓库的初始值见 B-01、B-02）。仓库的 `.github/geek-bot.yml` 和组织 `.github` 仓库这两层只能调低：关掉开关、把写入模式从 `on` 降到 `dry_run` 或 `off`，不能打开或调高；没有设置这一项的层不参与。写入模式按 `off` < `dry_run` < `on` 取最小，且不超过环境变量 `GEEK_BOT_WRITE_MODE`。
- **其它安全限制各层取更严。** 禁改路径（`fix.forbidden_paths`）取并集，内置项不能删；改动规模上限、写入限速取最小；私有仓库的节点信任等级取更高；出网白名单在仓库层只能缩小，全局白名单只能由 owner 重新认证后扩大（重新认证的清单见 [SECURITY](../../architecture/SECURITY.md) S-09）。仓库文件不能放宽后台，后台也不能放宽环境变量给的上限。
- **非安全设置按上面的四层优先级取值。** 天数、窗口、轮数、标签名、模板这类项，仓库文件优先于后台覆盖，后台覆盖优先于组织 `.github` 仓库，再往下是内置默认（ADR-0005）。
- **只有全局范围的项不读仓库层。** 轮询间隔、VM 规格、优先级、模型池、写入限速这类项影响整个实例，写在仓库文件里会被忽略，并在后台该仓库下显示提示。
- **非法值。** 环境变量非法时 control 拒绝启动，一次列出全部问题（与 `createControlConfig` 一致）；后台保存非法值时拒绝保存；仓库文件里的非法键被忽略、回落到下一层，并在后台该仓库下告警；安全限制键非法时按最严处理，该仓库的修复通道关闭。
- **生效时间。** 配置改动在下一轮轮询生效。已经发出的追问按发出时算好的到期时间计时（落在 `threads` 表），改天数只影响之后的追问。

仓库文件的键名和结构由 #10 写成 `@geek-bot/protocol` 里的 RepoProfile schema；本文先定键名。

## 规则

### 仓库与规则来源

| 编号 | 规则 | 配置项 | 默认值 | 范围 | 白名单 |
|---|---|---|---|---|---|
| B-01 | 新发现的仓库默认开「监控」：只读、走条件请求、按活跃度降频。仓库本身是 fork 的，默认只在后台列出、不监控 | `GEEK_BOT_MONITOR_NEW_REPOS`、`GEEK_BOT_MONITOR_NEW_FORK_REPOS`；仓库键 `switches.monitor` | `true`、`false` | 全局默认，可按仓库，取更严 | — |
| B-02 | 「审查 PR」「受理 issue」「自动修复」「返工」四个开关默认全关，要在后台逐个仓库开启。打开任一写入类开关、调高写入模式（包括关掉 `dry_run`）只归 owner，要求重新认证，并写审计（清单见 [SECURITY](../../architecture/SECURITY.md) S-09；#22 第 12 项）；operator 只能关掉开关、开关「监控」 | `switches.review`、`switches.triage`、`switches.fix`、`switches.rework` | 全为 `false` | 按仓库，取更严 | — |
| B-03 | 写入模式分 `off`、`dry_run`、`on`。`dry_run` 只生成待发布内容，后台标「未发布」，不写 GitHub。实际生效的是仓库设置与全局上限中更严的一个 | `write_mode`；`GEEK_BOT_WRITE_MODE`（全局上限） | 仓库 `off`；全局上限 `dry_run` | 按仓库，取更严 | D-55 |
| B-04 | 能做什么以机器人在该仓库的实际权限为准：pull 只能审查和评论；triage 才能增删受管标签、关闭 issue；push 才能推分支、开 PR；maintain、admin 按 push 对待，后台标红「权限大于需要」。权限不够的开关置灰并写明原因 | 固定 | — | — | 各 W 条的权限条件（C-05） |
| B-05 | 已归档的仓库只监控、不做任何动作。失去访问权的仓库标为 `lost`，取消它排队中的任务，历史保留 | 固定 | — | — | — |
| B-06 | 待接受的协作邀请只在后台列出，owner 重新认证后点击才由 publisher 接受 | 固定 | — | — | W-13、D-44 |
| B-07 | 仓库规则只从 base 分支读取；base 分支上没有 CONTRIBUTING、issue 模板、PR 模板时，回退到组织**公开的** `.github` 仓库里的同名文件（GitHub 的默认社区文件机制，只认公开的 `.github` 仓库，见 ADR-0005，所有者要求没有规范的仓库用组织默认规范）。AGENTS.md 这类散文规范只作模型上下文；从中提取的、影响写入的字段要 owner 在后台确认后才生效，确认之前该仓库的修复通道保持关闭 | 固定 | — | — | — |

### 轮询与入队

| 编号 | 规则 | 配置项 | 默认值 | 范围 | 白名单 |
|---|---|---|---|---|---|
| B-08 | 轮询已监控的仓库，每个仓库每轮只发两个带 ETag 的条件请求（issue 列表和开着的 PR 列表）；24 小时没有变化的仓库降到 5 分钟一次；不用 events API 和 search API | `GEEK_BOT_POLL_INTERVAL_SECONDS`、`GEEK_BOT_IDLE_POLL_INTERVAL_SECONDS`、`GEEK_BOT_IDLE_AFTER_HOURS` | `60`、`300`、`24` | 全局 | — |
| B-09 | 仓库发现和权限刷新每 10 分钟一次，都带 ETag | `GEEK_BOT_DISCOVERY_INTERVAL_SECONDS` | `600` | 全局 | — |
| B-10 | 静默窗口：条目最后一次非机器人变动之后，等满窗口才入队；可以按仓库、按条目类型分别设置（#22 第 15 项） | `GEEK_BOT_QUIET_WINDOW_SECONDS`；仓库键 `quiet_window_seconds.issue`、`quiet_window_seconds.pr` | `300` | 全局默认，可按仓库 | — |
| B-11 | 机器人账号自己的写入不重新计时（按 `bot_writes` 表识别）；计时细则见下文「静默窗口的起点」 | 固定 | — | — | — |
| B-12 | 「机器人被请求审查时立即入队」：打开后，PR 请求机器人审查时跳过静默窗口；默认关闭，由部署者在具体仓库上决定（#22 第 15 项） | `review.enqueue_on_review_request` | `false` | 按仓库 | — |
| B-13 | 同一条目同时最多一个活跃任务；同一仓库同时最多一个写入类任务（`fix`、`rework`） | 条目级固定；`GEEK_BOT_MAX_WRITE_TASKS_PER_REPO` | `1` | 全局 | — |

### PR 审查

| 编号 | 规则 | 配置项 | 默认值 | 范围 | 白名单 |
|---|---|---|---|---|---|
| B-14 | 开启「审查 PR」的仓库里，别人开的 PR 每个都审，不按内容挑选 | `switches.review` | `false`（见 B-02） | 按仓库 | — |
| B-15 | 审查只以 review 的 `COMMENT` 类型发出；机器人不批准、不请求修改、不合并。批准与合并只由人做 | 固定 | — | — | D-01 至 D-07 |
| B-16 | 不审机器人自己开的 PR，避免自我审查（#22 第 16 项） | `review.own_prs` | `false` | 全局默认，可按仓库 | — |
| B-17 | 来自 fork 的 PR 照常审查，只发评论（#22 第 16 项） | `review.fork_prs` | `true` | 全局默认，可按仓库 | — |
| B-18 | 审查前就已合并的 PR 也补审，审合并前的最后一个 head。补审只针对该仓库开启「审查 PR」之后、且在最近 72 小时内合并的 PR；control 停机恢复后同样只补这个窗口内的 | `review.merged_before_review`；`GEEK_BOT_CATCHUP_WINDOW_HOURS` | `true`；`72` | 按仓库；窗口全局 | — |
| B-19 | 同一个 PR 只审最新提交：出现新 head 时，排队中的旧审查标为 `superseded`，运行中的旧审查取消，新 head 按静默窗口重新入队 | 固定 | — | — | — |
| B-20 | 同一个 PR 的两次审查至少间隔 5 分钟 | `GEEK_BOT_REVIEW_MIN_INTERVAL_SECONDS` | `300` | 全局 | — |
| B-21 | 审查只读仓库画像里和审查有关的规范（审查、PR 规范）和改动涉及的服务文档，通过追加的系统提示限定，不强制执行目标仓库「先读完全部规范」的入口要求（#22 第 14 项）；仓库可以关掉这项精简，改为按入口要求读全部规范 | `review.focused_rules` | `true` | 按仓库 | — |
| B-22 | 审查评论按仓库自己的格式写；仓库没有格式时用内置模板：通用 Markdown，写明被审查的提交和依据的规范，条目按 `阻塞`、`应修`、`建议` 分严重度。机器审查不写 `**结论：…**` 行 | `review.comment_template` | 内置模板 | 全局默认，可按仓库 | 输出中和（C-09） |
| B-23 | 一次审查走完整个模型池仍失败时，可以在 PR 上发一条「自动审查未完成」的 COMMENT；默认不发，只在后台标失败 | `review.post_failure_notice` | `false` | 按仓库 | — |
| B-24 | PR 审查在 VM 就绪前可以临时在只读 sandbox 里运行：只读工具，不执行代码。#17 完成后切回 VM（#22 第 5 项）。修复和返工始终用 VM | `GEEK_BOT_REVIEW_EXECUTOR` | `vm` | 全局 | — |

### issue：接不接

判定顺序见下文「接不接的判定顺序」。

| 编号 | 规则 | 配置项 | 默认值 | 范围 | 白名单 |
|---|---|---|---|---|---|
| B-25 | 打了 `bot:manual` 的 issue 不接：不受理、不追问、不关、不改写。这个标签只由人打和去掉，机器人不加也不去；机器人只增删 `labels.blocked` | `labels.manual` | `bot:manual` | 全局默认，可按仓库 | — |
| B-26 | 分给了人（负责人里有机器人账号以外的人）：不接、不追问、不关、不改写；关联的 PR 照样审 | `issue.respect_human_assignee` | `true` | 全局默认，可按仓库 | — |
| B-27 | 已有开着的关联 PR：不重复做，转去审那个 PR（按那个 PR 所在仓库的审查开关）。怎么算关联见下文「关联 PR」 | `issue.linked_pr_keywords` | `Closes`、`Fixes`、`Resolves`、`Refs` | 全局默认，可按仓库 | — |
| B-28 | 分给了机器人账号：优先接，排 issue 通道优先级 10；决定修复时排 PR 通道优先级 30。机器人在该仓库不能被分配时，后台写明这条不会发生 | `issue.prefer_assigned_to_bot` | `true` | 全局默认，可按仓库 | — |
| B-29 | 没分配的 issue：受理（issue 通道优先级 30），由机器人自己决定修不修；只修符合「小改动」的，而且该仓库要开了「自动修复」、机器人有 push 权限 | `switches.triage`、`switches.fix` | `false`、`false`（见 B-02） | 按仓库，取更严 | — |

### issue：追问、提醒与关闭

| 编号 | 规则 | 配置项 | 默认值 | 范围 | 白名单 |
|---|---|---|---|---|---|
| B-30 | 描述不清或复现不了：发一条追问记录写明缺什么，打 `bot:blocked`，进入「等回复」 | `labels.blocked` | `bot:blocked` | 全局默认，可按仓库 | — |
| B-31 | 追问之后，出现一条非机器人账号的评论，或 issue 作者修改了正文，就算有人回复；机器人账号本身和一切 `[bot]` 账号（包括 `github-actions[bot]`）都不算。有回复后去掉 `bot:blocked`、停止计时，排一个跟进任务（issue 通道优先级 20）。公开仓库可以把回复人收窄为作者和仓库成员。细则见下文「什么算回复」 | `followup.reply_from`、`followup.extra_ignored_logins`（另外不算回复的账号） | `any_human`、空 | 全局默认，可按仓库 | — |
| B-32 | 没人回复：第 5 天发一次提醒 | `GEEK_BOT_REMIND_AFTER_DAYS`；仓库键 `followup.remind_after_days` | `5` | 全局默认，可按仓库 | — |
| B-33 | 没人回复：第 7 天发关闭记录后关闭 issue。关闭天数必须大于提醒天数 | `GEEK_BOT_CLOSE_AFTER_DAYS`；仓库键 `followup.close_after_days` | `7` | 全局默认，可按仓库 | W-08、D-13 |
| B-34 | 同一个 issue 最多追问 2 轮；最后一轮之后仍不清楚，发关闭记录写明缺什么，然后关闭，不再追问 | `GEEK_BOT_MAX_FOLLOWUP_ROUNDS`；仓库键 `followup.max_rounds` | `2` | 全局默认，可按仓库 | W-08、D-13 |
| B-35 | 价值不高（重复、已解决、不属于本仓库、没法执行）：先发关闭记录写明原因，再关闭；重复的引用原 issue | `issue.close_low_value` | `true` | 全局默认，可按仓库 | W-08、D-13 |
| B-36 | 回复后说清楚了、但正文不合该仓库的 issue 规范：按仓库模板新开一个合规 issue，正文引用原 issue 并 @ 原作者；新 issue 创建成功后，在原 issue 发关闭记录写明被新 issue 取代，再关闭原 issue。新 issue 由机器人按本表继续跟进。新 issue 没建成就不关原 issue | `issue.rewrite_noncompliant` | `true` | 全局默认，可按仓库 | W-09、D-26 |
| B-37 | 人重开过的 issue，机器人不再关，只评论 | 固定 | — | — | D-12 |
| B-38 | 机器人只关 issue，不关 PR | 固定 | — | — | D-10 |
| B-39 | 每次关闭前先发关闭记录写明原因。机器人没有 triage 权限时只发记录、不关闭，后台列出这条 issue | 固定 | — | — | W-08、D-13 |
| B-40 | 提醒、到期关闭、标签维护、改写后关闭原 issue 这些确定性动作由 control 直接执行，不占节点、不调模型 | 固定 | — | — | — |

### 复核

| 编号 | 规则 | 配置项 | 默认值 | 范围 | 白名单 |
|---|---|---|---|---|---|
| B-41 | 开工前（派发时）和发出前（publisher 发送前）各复核一次，条件见下文「复核的条件」。条件变了就放弃任务：issue 类任务在 issue 上发一条进展记录写明哪条变了，不关 issue；PR 出现新 head 时只作废旧任务，不发记录 | `recheck.post_progress_note`（是否发进展记录；复核本身固定） | `true` | 全局默认，可按仓库 | C-07、C-08、D-60 |

### 修复与返工

| 编号 | 规则 | 配置项 | 默认值 | 范围 | 白名单 |
|---|---|---|---|---|---|
| B-42 | 机器人自己决定修的只限小改动：只改一个服务；没有界面变化；带一条修复前失败、修复后通过的回归测试。超出范围的只发一条说明，不开 PR。细则见下文「小改动」 | `fix.single_service`、`fix.allow_ui_changes`、`fix.require_regression_test` | `true`、`false`、`true` | 全局默认，可按仓库 | — |
| B-43 | 所有修复（包括分给机器人的）都不碰认证、授权、密钥、`.env`、数据库结构、部署与 CI 配置：禁改路径由 publisher 硬拒，模型的语义判断只能再收紧；改动的文件数和行数有上限 | `fix.forbidden_paths`、`fix.max_changed_files`、`fix.max_changed_lines` | 见下文「小改动」；`10`；`300` | 按仓库，取更严 | D-36、D-37 |
| B-44 | 修复分支按仓库画像的分支模板命名，base 取画像；产品内置默认分支 `geek-bot/<issue>-<slug>`、base 为目标仓库的默认分支（本仓库自己的设置见「本仓库的配置」）。只推机器人分支，只快进，不带 tag，不推默认分支和 base 分支 | `branch.template`、`branch.base` | `geek-bot/<issue>-<slug>`、仓库默认分支 | 全局默认，可按仓库 | W-10、D-28 至 D-30、D-33、D-35 |
| B-45 | 机器人开的 PR，正文按仓库的 PR 模板写，「审查结论」段固定写 `**结论：阻塞**`（等待人工审查）；段落写法可以跟随仓库画像，结论不能改。机器人从不写通过类结论 | `pr.verdict_block`（只改段落写法） | [PULL-REQUESTS](../../conventions/PULL-REQUESTS.md)「机器人开的 PR」里的阻塞段 | 全局默认，可按仓库 | W-11、D-25 |
| B-46 | 返工只针对机器人自己开的 PR：收到审查意见、CI 失败或与目标分支冲突时返工；只往同一分支追加提交，发返工记录说明改了什么；PR 开出后不再改正文。审查意见默认只认 `author_association` 为 `OWNER`、`MEMBER`、`COLLABORATOR` 的账号，防止公开仓库里任何人驱动机器人改代码 | `switches.rework`、`rework.feedback_from` | `false`（见 B-02）、`members` | 按仓库，取更严 | W-12、D-15、D-35 |
| B-47 | 不改别人 PR 的正文；评论只改机器人自己发的、带隐藏标记的那几条 | 固定 | — | — | D-15、D-17 |

### 执行与调度

| 编号 | 规则 | 配置项 | 默认值 | 范围 | 白名单 |
|---|---|---|---|---|---|
| B-48 | issue 通道不开 VM：在无网、根只读、不挂令牌的 sandbox 容器里只读代码，omp 只给 read、grep、glob，不执行代码 | 固定 | — | — | — |
| B-49 | PR 通道（审查、修复、返工）每个任务一台新的临时 VM，任务结束即删除 VM 和它的磁盘。「每任务一台、用完即删」固定，规格可改。每个节点同时能跑几台由节点的 VM 槽位决定（`GEEK_BOT_NODE_VM_SLOTS`，见 [node 服务契约](../node/README.md)） | `GEEK_BOT_VM_VCPUS`、`GEEK_BOT_VM_MEMORY_MIB` | `1`、`2048` | 全局 | — |
| B-50 | PR 通道优先级（数字小的先派发）：审查别人的 PR 10 > 自己 PR 返工 20 > 修分给机器人的 issue 30 > 修机器人自己决定修的 40 | `priority.pr` | `@geek-bot/protocol` 的 `PR_CHANNEL_PRIORITY` | 全局 | — |
| B-51 | issue 通道优先级：分给机器人的 10 > 追问后收到回复的 20 > 未分配的受理 30 > 规则画像提取 40 | `priority.issue` | `10`、`20`、`30`、`40` | 全局 | — |
| B-52 | 同一优先级内先在仓库之间轮转，再按可入队时间先到先得；老化提升默认关闭；后台可以把单个任务「提到最前」，写审计 | `GEEK_BOT_PRIORITY_AGING` | `false` | 全局 | — |
| B-53 | 基础设施失败（节点失联、VM 起不来、任务包校验失败、runner 崩溃、租约未确认）换一个节点重排，最多 2 次。节点超过失联期限没有联络，control 收回它的租约、epoch 加一；节点同样超过这个期限联系不上 control，就自行终止任务、销毁 VM，两侧用同一个值（[节点协议](../node/protocol.md)、[ADR-0003](../../decisions/0003-single-writer-control.md)） | `GEEK_BOT_INFRA_RETRY_MAX`、`GEEK_BOT_LEASE_LOST_AFTER_SECONDS` | `2`、`600` | 全局 | — |
| B-54 | 私有仓库的任务只派给信任等级为 `high` 的节点；把节点调到 `high` 只归 owner，要求重新认证（S-09） | `GEEK_BOT_PRIVATE_REPO_MIN_TRUST` | `high` | 全局，取更严 | — |
| B-55 | 暂停分全局、通道、仓库、节点四个范围，只影响派发，已经在跑的任务不中途冻结。「暂停全部写入」是单独的开关：机器人令牌返回 401、scope 变化、GitHub 二级限额连续命中 3 次时自动打开（权限不足的 403 不计入），owner 或 operator 也可以手动打开；只有 owner 重新认证后能解除，401 和 scope 变化引起的要先重新绑定机器人 | `GEEK_BOT_WRITE_PAUSE_AFTER_SECONDARY_LIMITS` | `3` | 全局 | C-02、D-59 |

### 模型

| 编号 | 规则 | 配置项 | 默认值 | 范围 | 白名单 |
|---|---|---|---|---|---|
| B-56 | 模型按任务类型分池：审查、分诊、跟进、修复、返工、规则画像。池里每项是 catalog 里的模型 id 加思考档位；模型只能来自部署者挂载的只读 catalog 文件，没有 efforts 的模型只有 `off` 档位，产品不内置具体模型。池为空的任务类型不派发，后台告警 | 后台模型池（`model_pools` 表）；`GEEK_BOT_MODEL_CATALOG_FILE` | 池为空；catalog 路径为空 | 全局 | — |
| B-57 | 池内按顺序降级：报错、超时、限流、中断时换下一个模型从头重跑；上下文溢出和主动取消不降级；结果不合 schema 时先用同一个模型带修复提示重跑一次，仍不合格再降级；因超时降级时，整个任务的墙钟不超过单次上限的 2 倍；池走完判失败，不自动重试，由人点「重新排队」 | `GEEK_BOT_MODEL_WALLCLOCK_FACTOR` | `2` | 全局 | — |
| B-58 | 所有者实例的审查池初始值：`gemini-3.8-flash` → `deepseek-v4.1-flash` → `qcn-qwen3.8-flash`。网关是 OpenAI 兼容接口，地址由部署配置 `GEEK_BOT_MODEL_GATEWAY_URL` 固定（文档里写 `https://gateway.example.com/v1`）；catalog 只提供模型列表，它的 `provider.baseUrl` 与配置不一致时拒绝加载并告警。这些是实例数据，不写进产品代码 | 后台模型池的审查池；`GEEK_BOT_MODEL_GATEWAY_URL` | 见左；空 | 实例；全局 | — |
| B-59 | 网关密钥只挂给 control；节点、sandbox、VM 只拿到每任务模型令牌（[SECURITY](../../architecture/SECURITY.md) S-02） | `GEEK_BOT_MODEL_GATEWAY_KEY_FILE` | 空 | 全局 | — |

### 记录格式

| 编号 | 规则 | 配置项 | 默认值 | 范围 | 白名单 |
|---|---|---|---|---|---|
| B-60 | 机器人在 GitHub 上的记录按目标仓库自己的追踪或评论规范写；仓库没有自己的格式时，记录头默认 `<!-- track v1 kind=<类型> stage=<阶段> -->`，字段格式同 [TRACKING](../../conventions/TRACKING.md) §3，部署者可以在后台改（ADR-0010） | `record.header_template` | `<!-- track v1 kind=<类型> stage=<阶段> -->` | 全局默认，可按仓库 | — |
| B-61 | 机器人写的记录头在 `stage=` 之后加 `actor=bot model=<id> effort=<档位> commit=<40 位 SHA>` | `record.bot_attributes` | `true` | 全局默认，可按仓库 | — |
| B-62 | 每条写入（评论、review、新开的 issue、PR 正文）在正文最后一行另带隐藏标记 `<!-- geek-bot v1 env=<环境> kind=<写入类型> task=<任务 id> sha=<head 前 12 位> round=<轮次> -->`，第一行留给追踪记录头；用于幂等、认出自己的写入和从 GitHub 重建状态（[ADR-0005](../../decisions/0005-rules-from-base-branch.md)、[数据模型](data-model.md)「从 GitHub 重建状态」）。它是产品标识，不是追踪格式，不能关 | 固定 | — | — | W-04、D-17 |

### 写入节奏与环境隔离

| 编号 | 规则 | 配置项 | 默认值 | 范围 | 白名单 |
|---|---|---|---|---|---|
| B-63 | 写入限速：每分钟 60 次、每小时 400 次，配置值不能超过 GitHub 的二级限额（每分钟 80 次、每小时 500 次）；同一仓库的写入串行 | `GEEK_BOT_WRITE_RATE_PER_MINUTE`、`GEEK_BOT_WRITE_RATE_PER_HOUR` | `60`、`400` | 全局，取更严 | — |
| B-64 | 实例角色必须显式配置，没配就拒绝启动。preview 实例只写沙盒清单里的仓库，写其它仓库一律拒绝并写审计；production 不写排除清单里的仓库，防止同一个账号在两个环境对同一个仓库重复写。两份清单各用一个变量，只在对应角色下生效，在另一个角色下设置了就拒绝启动 | `GEEK_BOT_INSTANCE_ROLE`、`GEEK_BOT_PUBLISHER_REPO_ALLOWLIST`（preview 的沙盒清单）、`GEEK_BOT_PUBLISHER_REPO_DENYLIST`（production 的排除清单） | 无默认值；空；空（preview 清单为空时不写任何仓库） | 全局，取更严 | C-03、D-56 |

## 判定细则

### 接不接的判定顺序

issue 在 `switches.triage` 打开的仓库里按下面的顺序判定，命中一条就停：

1. issue 已关闭，或讨论被锁定：不接。
2. 打了 `labels.manual`（B-25）：不接。
3. 负责人里有机器人账号以外的人（B-26）：不接。机器人和人同时是负责人时，也按「分给了人」处理。
4. 有开着的关联 PR（B-27）：不接，转去审那个 PR。
5. 负责人只有机器人账号（B-28）：接，issue 通道优先级 10。
6. 没有负责人（B-29）：受理，issue 通道优先级 30。

不接的 issue 出现在后台「未接的 issue」里，写明命中哪一条和下次检查的时间。

### 关联 PR

issue #n 满足下面任一条，就算有开着的关联 PR：

1. 同一仓库里有一个开着的 PR（包括草稿），正文里 `issue.linked_pr_keywords` 的某个词（不分大小写，包括 `close`、`closed`、`fix`、`fixed`、`resolve`、`resolved` 这类变形）后面跟着 `#n` 或同仓库的 `<owner>/<repo>#n`；
2. 同一仓库里有一个开着的 PR，head 分支名按仓库画像的分支模板能解析出 n（例如内置默认 `geek-bot/<issue>-<slug>`）；
3. issue 的时间线里有来自同一仓库一个开着的 PR 的交叉引用事件，或 GitHub 把这个 PR 列为关闭该 issue 的 PR。

关联 PR 是机器人自己开的，由返工流程接管（B-46）。关联 PR 关闭且没有合并后，issue 在下一轮轮询重新判定。只看同一仓库的 PR，别的仓库引用它不算。

### 静默窗口的起点

- 起点是条目最后一次非机器人变动：新建、改标题或正文、新评论、新提交（PR head 变化）、改负责人或标签、重开。
- 机器人账号自己的写入不重新计时（所有者原话）。其它 `[bot]` 账号的评论也不重新计时，这是架构草案「非机器人变动」的口径，#8 实现时核对。
- PR 出现新 head 总是重新计时。
- `eligible_at = 起点 + 静默窗口`；`review.enqueue_on_review_request` 打开时，请求机器人审查的那一刻直接入队。

### 什么算回复

追问评论在 GitHub 上的创建时间之后，出现下面任一情况，就算有人回复：

1. 一条新评论，作者不是机器人账号本身，不是 `[bot]` 账号（login 以 `[bot]` 结尾，或 GitHub 返回的账号类型是 Bot，例如 `github-actions[bot]`），也不在 `followup.extra_ignored_logins` 里；
2. issue 作者修改了正文：正文内容的哈希和追问时记下的不同，而且最后编辑者是作者本人。

`followup.reply_from` 决定第 1 条认哪些评论人：默认 `any_human`，任何满足上面条件的人都算，这是所有者定的原规则；改成 `author_and_members` 后，只认 issue 作者和 `author_association` 为 `OWNER`、`MEMBER`、`COLLABORATOR` 的账号，适合公开仓库，防止路人替作者「回复」。第 2 条不受影响。

只改标题、增删标签、改负责人、加表情回应都不算回复；改负责人或加 `bot:manual` 会在复核时让机器人放弃（B-41）。

### 等回复的计时

- 起点是追问评论在 GitHub 上确认发出的时间。天数按 24 小时计，不按日历日。
- 起点 + `remind_after_days` 天仍没有回复：发一次提醒。每一轮只提醒一次。提醒用追踪记录，默认格式下是 `kind=blocked`。
- 起点 + `close_after_days` 天仍没有回复：发关闭记录写明缺什么，然后关闭（B-33、B-39）。
- 收到回复后，跟进任务判断是否已经说清楚：清楚就进入受理或改写（B-36）；仍不清楚且轮数没到 `max_rounds`，发下一轮追问并重新计时；到了上限就关闭（B-34）。
- 人重开过的 issue 到期也不关，只评论（B-37）。

### 复核的条件

开工前和发出前都核对：

- issue 类：issue 仍开着，没有被锁定；没有分给人；没有 `labels.manual`；没有新的开着的关联 PR；仓库开关仍开着；机器人在该仓库的权限仍够这次写入；写入模式没有关掉。要关闭 issue 时，还要核对它没有被人重开过。
- PR 类：PR 的 head 仍等于任务的 head（审查已合并的 PR 时核对合并前的 head）；机器人对这个 PR 的上一次审查已过 `GEEK_BOT_REVIEW_MIN_INTERVAL_SECONDS`；机器人的推送分支 head 仍是上次推送的提交（只快进）。

发送前的复核由 publisher 执行，和白名单的条件一起检查（[写入白名单](write-whitelist.md)）。

### 小改动

机器人自己决定修的 issue，要同时满足 B-42 和 B-43；分给机器人的 issue，只受 B-43 约束。

- **只改一个服务**：改动的文件都在仓库画像列出的同一个服务目录下；画像没有列服务时，按仓库根下的第一级目录判断，根目录下的文件单独算一个范围。
- **没有界面变化**：由分诊任务的结构化结果声明；画像列了界面目录时，碰到这些目录就不算小改动。
- **能写回归测试**：补丁里包含测试文件的改动，并且 VM 里的两次运行结果显示这条测试在修复前失败、修复后通过。
- **禁改路径**：`fix.forbidden_paths` 的内置默认是 `.github/**`、`**/.env*`、`**/secrets/**`、`**/*.pem`、`**/*.key`、`**/migrations/**`、`deploy/**`、`**/Dockerfile*`、`**/*compose*.yml`、`**/*compose*.yaml`；画像和后台只能再增加，不能删减内置项。禁改路径的规则以 [SECURITY](../../architecture/SECURITY.md) S-19 为准：此外 publisher 不论配置如何都拒绝 `.github/workflows/**`、`.github/actions/**`，以及根目录、`.github/`、`docs/` 下的 `CODEOWNERS`、`.gitmodules`、gitlink、符号链接和 LFS 指针（D-36、D-37）。认证、授权代码没法按路径通用地识别，靠画像补充路径和分诊任务的判断，二者都只能收紧。
- **规模上限**：改动文件数不超过 `fix.max_changed_files`，增删行数合计不超过 `fix.max_changed_lines`。

### 本仓库的配置

本仓库也由 geek_bot 管理，它自己的 `.github/geek-bot.yml`（#10 写入）按本仓库的规范覆盖产品默认值：

| 键 | 本仓库的值 | 产品默认 | 依据 |
|---|---|---|---|
| `branch.template` | `task/<issue>/<slug>` | `geek-bot/<issue>-<slug>` | [BRANCHING](../../conventions/BRANCHING.md) |
| `branch.base` | `stage` | 仓库默认分支 | [BRANCHING](../../conventions/BRANCHING.md) |
| `fix.forbidden_paths` | 在内置默认之上再加 `app/control/src/publisher/**`、`app/control/src/secrets/**`、`deploy/**`、`.github/**`、`scripts/check-*.mjs` | 见上文「禁改路径」 | S-19 的本仓库条目，防止机器人修改保护它自身的代码 |
| `record.header_template` | 与产品默认相同 | `<!-- track v1 kind=<类型> stage=<阶段> -->` | [TRACKING](../../conventions/TRACKING.md)、ADR-0010 |

机器人开的 PR 在本仓库照 [PULL-REQUESTS](../../conventions/PULL-REQUESTS.md)「机器人开的 PR」写。

## 配置项一览

### 环境变量（全局）

「后台可改」一列：`是` 表示可以在后台「设置」里改，保存的值优先于环境变量；`只读` 表示只认环境变量，后台修改返回 `setting_locked`（多是部署事实和安全上限）；`只能收紧` 表示后台只能改得比环境变量更严。「状态」一列：`已有` 表示 `app/control/src/config.ts` 已经在读；`新增` 表示名字由本文定，随对应 issue 实现。所有环境变量只写进 `deploy/env/.env.production` 与 `deploy/env/.env.preview`（#7 引入），密钥只以 `*_FILE` 路径出现。

| 配置项 | 取值 | 默认值 | 可按仓库覆盖的键 | 后台可改 | 规则 | 状态 |
|---|---|---|---|---|---|---|
| `GEEK_BOT_POLL_INTERVAL_SECONDS` | 整数，≥ 1 | `60` | — | 是 | B-08 | 已有 |
| `GEEK_BOT_QUIET_WINDOW_SECONDS` | 整数，≥ 0 | `300` | `quiet_window_seconds.issue`、`quiet_window_seconds.pr` | 是 | B-10 | 已有 |
| `GEEK_BOT_REMIND_AFTER_DAYS` | 整数，≥ 1 | `5` | `followup.remind_after_days` | 是 | B-32 | 已有 |
| `GEEK_BOT_CLOSE_AFTER_DAYS` | 整数，≥ 1，且大于提醒天数 | `7` | `followup.close_after_days` | 是 | B-33 | 已有 |
| `GEEK_BOT_MAX_FOLLOWUP_ROUNDS` | 整数，≥ 0 | `2` | `followup.max_rounds` | 是 | B-34 | 已有 |
| `GEEK_BOT_VM_VCPUS` | 整数，≥ 1 | `1` | — | 只读 | B-49 | 已有 |
| `GEEK_BOT_VM_MEMORY_MIB` | 整数，≥ 512 | `2048` | — | 只读 | B-49 | 已有 |
| `GEEK_BOT_IDLE_POLL_INTERVAL_SECONDS` | 整数，≥ 轮询间隔 | `300` | — | 是 | B-08 | 新增（#8） |
| `GEEK_BOT_IDLE_AFTER_HOURS` | 整数，≥ 1 | `24` | — | 是 | B-08 | 新增（#8） |
| `GEEK_BOT_DISCOVERY_INTERVAL_SECONDS` | 整数，≥ 60 | `600` | — | 是 | B-09 | 新增（#6） |
| `GEEK_BOT_MONITOR_NEW_REPOS` | `true`、`false` | `true` | `switches.monitor` | 是 | B-01 | 新增（#6） |
| `GEEK_BOT_MONITOR_NEW_FORK_REPOS` | `true`、`false` | `false` | `switches.monitor` | 是 | B-01 | 新增（#6） |
| `GEEK_BOT_WRITE_MODE` | `off`、`dry_run`、`on` | `dry_run` | `write_mode`（取更严） | 只读 | B-03 | 新增（#9） |
| `GEEK_BOT_INSTANCE_ROLE` | `preview`、`production` | 无，必须配置，没配拒绝启动 | — | 只读 | B-64 | 新增（#3、#9） |
| `GEEK_BOT_PUBLISHER_REPO_ALLOWLIST` | 逗号分隔的 `<owner>/<repo>`；只在 preview 下生效 | 空（不写任何仓库） | — | 只读 | B-64 | 新增（#9） |
| `GEEK_BOT_PUBLISHER_REPO_DENYLIST` | 逗号分隔的 `<owner>/<repo>`；只在 production 下生效 | 空 | — | 只读 | B-64 | 新增（#9） |
| `GEEK_BOT_CATCHUP_WINDOW_HOURS` | 整数，≥ 1 | `72` | — | 是 | B-18 | 新增（#8） |
| `GEEK_BOT_REVIEW_MIN_INTERVAL_SECONDS` | 整数，≥ 0 | `300` | — | 只能收紧（只能调大） | B-20 | 新增（#9） |
| `GEEK_BOT_REVIEW_EXECUTOR` | `vm`、`sandbox` | `vm` | — | 只读 | B-24 | 新增（#15） |
| `GEEK_BOT_MAX_WRITE_TASKS_PER_REPO` | 整数，≥ 1 | `1` | — | 只能收紧（只能调小） | B-13 | 新增（#8） |
| `GEEK_BOT_PRIORITY_AGING` | `true`、`false` | `false` | — | 是 | B-52 | 新增（#8） |
| `GEEK_BOT_INFRA_RETRY_MAX` | 整数，≥ 0 | `2` | — | 是 | B-53 | 新增（#11） |
| `GEEK_BOT_LEASE_LOST_AFTER_SECONDS` | 整数秒，≥ 60 | `600` | — | 是 | B-53；[节点协议](../node/protocol.md) | 新增（#11） |
| `GEEK_BOT_PRIVATE_REPO_MIN_TRUST` | `high`、`standard` | `high` | — | 只能收紧 | B-54 | 新增（#19） |
| `GEEK_BOT_WRITE_PAUSE_AFTER_SECONDARY_LIMITS` | 整数，≥ 1 | `3` | — | 只能收紧（只能调小） | B-55 | 新增（#9） |
| `GEEK_BOT_MODEL_CATALOG_FILE` | 容器内文件路径 | 空 | — | 只读 | B-56 | 新增（#13） |
| `GEEK_BOT_MODEL_GATEWAY_URL` | OpenAI 兼容网关的地址，如 `https://gateway.example.com/v1` | 空 | — | 只读 | B-58 | 新增（#13） |
| `GEEK_BOT_MODEL_GATEWAY_KEY_FILE` | 容器内密钥文件路径 | 空 | — | 只读 | B-59 | 新增（#13） |
| `GEEK_BOT_MODEL_WALLCLOCK_FACTOR` | 整数，≥ 1 | `2` | — | 是 | B-57 | 新增（#14） |
| `GEEK_BOT_WRITE_RATE_PER_MINUTE` | 整数，1–80 | `60` | — | 只能收紧（只能调小） | B-63 | 新增（#9） |
| `GEEK_BOT_WRITE_RATE_PER_HOUR` | 整数，1–500 | `400` | — | 只能收紧（只能调小） | B-63 | 新增（#9） |
| `GEEK_BOT_TASK_DATA_RETENTION_DAYS` | 整数，≥ 1 | `30` | — | 是 | [数据模型](data-model.md) | 新增（#14） |
| `GEEK_BOT_HEALTH_SAMPLE_RETENTION_DAYS` | 整数，≥ 1 | `7` | — | 是 | [数据模型](data-model.md) | 新增（#11） |
| `GEEK_BOT_BACKUP_KEEP_DAILY` | 整数，≥ 1 | `7` | — | 是 | [数据模型](data-model.md) | 新增（#3） |
| `GEEK_BOT_BACKUP_KEEP_WEEKLY` | 整数，≥ 0 | `4` | — | 是 | [数据模型](data-model.md) | 新增（#3） |
| `GEEK_BOT_PUBLIC_ORIGIN` | 实例的 origin，如 `https://geek-bot.example.com` | 空 | — | 只读 | 不是行为规则，见 [API](../../architecture/API.md)「会话与 CSRF」 | 新增（#5） |
| `GEEK_BOT_ALLOW_PLAINTEXT_MESH` | `true`、`false` | `false` | — | 只读 | 不是行为规则，见 [SECURITY](../../architecture/SECURITY.md) | 新增（#5、#7） |

架构草案里的 `PUBLISHER_REPO_ALLOWLIST` 按统一前缀改名为 `GEEK_BOT_PUBLISHER_REPO_ALLOWLIST`，只作 preview 的沙盒清单；production 的排除清单另用 `GEEK_BOT_PUBLISHER_REPO_DENYLIST`。节点侧的配置项（`GEEK_BOT_NODE_*`，包括节点令牌文件 `GEEK_BOT_NODE_TOKEN_FILE`）见 [node 服务契约](../node/README.md)，不在本表。

### 设置键（后台全局设置，或按仓库覆盖）

这些项没有环境变量。全局默认存在后台「设置」（`settings` 表），能按仓库覆盖的再从仓库文件和后台仓库覆盖（`repo_overrides` 表）读取。

| 配置项 | 取值 | 默认值 | 范围 | 规则 |
|---|---|---|---|---|
| `switches.monitor` | 布尔 | 见 `GEEK_BOT_MONITOR_NEW_REPOS` | 按仓库，以后台为基准，只能往下调 | B-01 |
| `switches.review`、`switches.triage`、`switches.fix`、`switches.rework` | 布尔 | `false` | 按仓库，以后台为基准，只能往下调；打开只归 owner | B-02、B-14、B-29、B-46 |
| `write_mode` | `off`、`dry_run`、`on` | `off` | 按仓库，以后台为基准，只能往下调；调高只归 owner | B-03 |
| `review.enqueue_on_review_request` | 布尔 | `false` | 按仓库 | B-12 |
| `review.own_prs` | 布尔 | `false` | 全局默认，可按仓库 | B-16 |
| `review.fork_prs` | 布尔 | `true` | 全局默认，可按仓库 | B-17 |
| `review.merged_before_review` | 布尔 | `true` | 全局默认，可按仓库 | B-18 |
| `review.focused_rules` | 布尔 | `true` | 全局默认，可按仓库 | B-21 |
| `review.comment_template` | Markdown 模板 | 内置模板 | 全局默认，可按仓库 | B-22 |
| `review.post_failure_notice` | 布尔 | `false` | 全局默认，可按仓库 | B-23 |
| `labels.manual` | 标签名 | `bot:manual` | 全局默认，可按仓库 | B-25 |
| `labels.blocked` | 标签名 | `bot:blocked` | 全局默认，可按仓库 | B-30 |
| `issue.respect_human_assignee` | 布尔 | `true` | 全局默认，可按仓库 | B-26 |
| `issue.linked_pr_keywords` | 字符串列表 | `Closes`、`Fixes`、`Resolves`、`Refs` | 全局默认，可按仓库 | B-27 |
| `issue.prefer_assigned_to_bot` | 布尔 | `true` | 全局默认，可按仓库 | B-28 |
| `issue.close_low_value` | 布尔 | `true` | 全局默认，可按仓库 | B-35 |
| `issue.rewrite_noncompliant` | 布尔 | `true` | 全局默认，可按仓库 | B-36 |
| `followup.reply_from` | `any_human`、`author_and_members` | `any_human` | 全局默认，可按仓库 | B-31 |
| `followup.extra_ignored_logins` | login 列表 | 空 | 全局默认，可按仓库 | B-31 |
| `recheck.post_progress_note` | 布尔 | `true` | 全局默认，可按仓库 | B-41 |
| `fix.single_service` | 布尔 | `true` | 全局默认，可按仓库 | B-42 |
| `fix.allow_ui_changes` | 布尔 | `false` | 全局默认，可按仓库 | B-42 |
| `fix.require_regression_test` | 布尔 | `true` | 全局默认，可按仓库 | B-42 |
| `fix.forbidden_paths` | glob 列表 | 见「小改动」 | 按仓库，取并集 | B-43 |
| `fix.max_changed_files` | 整数，≥ 1 | `10` | 按仓库，取最小 | B-43 |
| `fix.max_changed_lines` | 整数，≥ 1 | `300` | 按仓库，取最小 | B-43 |
| `rework.feedback_from` | `members`（`OWNER`、`MEMBER`、`COLLABORATOR`）、`any_human` | `members` | 全局默认，可按仓库，取更严 | B-46 |
| `branch.template` | 含 `<issue>`、`<slug>` 的模板 | `geek-bot/<issue>-<slug>` | 全局默认，可按仓库 | B-44 |
| `branch.base` | 分支名 | 仓库默认分支 | 按仓库 | B-44 |
| `pr.verdict_block` | Markdown 段落，必须含 `**结论：阻塞**` | PULL-REQUESTS 的阻塞段 | 全局默认，可按仓库 | B-45 |
| `priority.pr` | 来由到数字的映射 | `PR_CHANNEL_PRIORITY` | 全局 | B-50 |
| `priority.issue` | 来由到数字的映射 | `10`、`20`、`30`、`40` | 全局 | B-51 |
| `record.header_template` | 单行模板 | `<!-- track v1 kind=<类型> stage=<阶段> -->` | 全局默认，可按仓库 | B-60 |
| `record.bot_attributes` | 布尔 | `true` | 全局默认，可按仓库 | B-61 |

模型池不在本表：它存在 `model_pools` 表，按任务类型保存 catalog id 和档位（B-56、B-58，见 [数据模型](data-model.md)）。

## 待定与未验证

- `fix.max_changed_files = 10`、`fix.max_changed_lines = 300`、`fix.forbidden_paths` 的默认列表、`GEEK_BOT_WRITE_MODE` 默认 `dry_run`，是本文按草案「有上限」「先 dry-run 影子运行」给的推荐值，所有者没有单独确认；#9、#18 实现前在 PR 上确认，数值与 [写入白名单](write-whitelist.md) 对应条目不一致时以白名单为准并回改本文。
- 机器人和人同时是负责人时按「分给了人」处理、分给机器人的 issue 不受 B-42 约束但受 B-43 约束、补审只针对开启审查之后合并的 PR，这三条是对所有者规则的细化，#15、#16、#18 实现前在 PR 上确认。
- 草稿 PR 是否审查，所有者规则没有提到；本文不加规则，#15 实现前提出。
- 人手工去掉 `bot:blocked` 算不算回复（[ISSUES](../../conventions/ISSUES.md) §5 说人也可以直接去掉），本文没有定；#16 实现前提出。
- 其它 `[bot]` 账号的评论不重新计时静默窗口（B-11 的细则）按架构草案口径写，未验证，由 #8 核对。
- 「作者修改了正文」要拿到最后编辑者：REST 接口不返回编辑者，需要 GraphQL；未验证，由 #8 实测。
- 在已合并的 PR 上发 COMMENT 类型的 review 是否被 GitHub 接受，未验证，由 #15 实测。
- `rework.feedback_from` 这个名字由本文按 #2 审查裁决新起；其它文件提到返工只认仓库成员时，引用这个名字。
- 所有规则都没有实现；实现前不能把本文当作机器人已经具备的能力引用。

## 验证（计划中）

每条规则在实现它的 issue 里至少有一个测试证明默认值和改配置后的行为：入队、静默窗口、补审窗口、优先级（#8）；白名单相关的每一条都有拒绝用例（#9）；配置合并和「取更严」（#10）；模型池与降级（#13、#14）；PR 审查（#15）；issue 受理、追问、提醒、关闭、改写（#16）；VM 每任务一台（#17）；小改动与返工（#18）。每条测试在用例名里写规则编号，方便从本文反查。
