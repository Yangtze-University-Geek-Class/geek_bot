# publisher 写入白名单

> 机器人对 GitHub 的每一种写入：允许清单 W-01…W-14、拒绝清单 D-01…D-64，以及输出中和、outbox 状态机与 `dedupe_key`、限速与熔断。

状态：`proposed` · 更新：2026-09-26 · 适用：`app/control` 的 publisher（计划路径 `src/publisher/`）、它的允许与拒绝用例，以及调用它的登录、仓库、审查、issue、修复模块（由 #9 实现；W-13 由 #6、W-14 由 #5 接入，W-10–W-12 由 #18 接入）

## 这份清单的地位

- **publisher 是 control 里唯一写 GitHub 的出口**（[SECURITY](../../architecture/SECURITY.md) S-06）。control 的其它模块、后台会话、节点、sandbox、VM 都不能直接写 GitHub；它们只能向 publisher 提交某个 W 编号的写入意图。
- **这份白名单是唯一的服务端防线**（S-07）。免费计划的私有仓库没有分支保护、rulesets 和 Environments，OAuth `repo` scope 也不能按仓库收窄；机器人令牌在 GitHub 那边能推主干、打 tag、合并，GitHub 不会拦。
- **默认拒绝。** 只放行下面列出的 W-01…W-14，每一条的参数和前置核对都要满足；不在允许清单里的写入一律拒绝并写审计。拒绝清单 D-01…D-64 列的是必须有专门拒绝用例的越权写入，不是穷举：没列在 D 里的写入同样拒绝。
- **权威位置。** outbox 的状态机和 `dedupe_key` 的组成以本文「幂等与 outbox」一节为准，[数据模型](data-model.md) 照抄；禁改路径、GitHub 域名清单和重新认证清单以 [SECURITY](../../architecture/SECURITY.md) 的 S-19、S-03、S-09 为准，本文只引用。
- **任何放宽按阻塞级审查。** 新增 W 条目、放宽参数约束、新增 review event、新增 ref 形状、扩大目标仓库或条目范围、删掉 D 条目或它的测试，都按 [CODE-REVIEW](../../conventions/CODE-REVIEW.md) 第 11 项走：要有关联 issue、所有者批准和对应的拒绝用例，否则不能合并。收紧不需要所有者批准，但要同步改测试。
- 本文是 #9 的实现目标和审查基线，状态 `proposed`，不证明功能已经实现。实现以后，机器人能对 GitHub 做什么，以 publisher 的实现和它的允许、拒绝用例为准（[DOCUMENTATION](../../conventions/DOCUMENTATION.md)「事实来源」）；改白名单时同一次改动里改本文和用例。
- 端点写法取自 GitHub 官方 REST 文档，2026-09-26 核对，来源列在文末。行为规则与配置项名见 [默认行为](behavior.md)（B 编号）；隐藏标记、outbox 等表结构见 [数据模型](data-model.md)。

## 术语

- **写入意图**：publisher 的输入是一个 W 编号加它的参数，例如「W-03，仓库 id、PR 号、head、review 正文」。publisher 按本表拼出 HTTP 请求或 git 命令；它不提供「发任意方法和路径」的接口。
- **受管标签**：画像里的 `labels.blocked`（默认 `bot:blocked`），机器人只加、去、建这一个标签（W-05–W-07）。`labels.manual`（默认 `bot:manual`）是人给出的「别接」信号，机器人只读，不加也不去（D-23）；其它标签一律不动。
- **机器人分支**：机器人用 W-10 新建、登记在 `bot_branches` 表里的分支。
- **集成分支**：目标仓库规范规定 PR 要合入的分支，取画像的 `branch.base`；没有配置时是仓库的默认分支。
- **长期分支**：仓库的默认分支、`branch.base`，以及固定名单 `main`、`master`、`stage`、`develop`、`dev`、`trunk`、`gh-pages`、`release/*`、`hotfix/*`。机器人从不推这些分支（D-28、D-29）。
- **禁改路径**：完整清单以 [SECURITY](../../architecture/SECURITY.md) S-19 为准：`fix.forbidden_paths` 的内置默认加各层配置的并集，外加 publisher 固定拒绝的几项（D-36、D-37）。

## 共同前置核对

每条 W 的「前置核对」一列引用下面的编号。核对在 publisher 发送前执行，不信任派发时的结果（B-41）。任何一项不满足，这次写入按对应的 D 编号拒绝。

| 编号 | 核对内容 |
|---|---|
| C-01 | **写入模式**：实际模式取仓库的 `write_mode` 与全局上限 `GEEK_BOT_WRITE_MODE` 中更严的一个（B-03）。`on` 才发送；`dry_run` 只把渲染好的请求记进 outbox（状态 `dry_run`），后台标「未发布」；`off` 拒绝（D-55） |
| C-02 | **没有暂停**：不在「暂停全部写入」状态（B-55：机器人令牌 401、scope 变化、二级限额连续命中 `GEEK_BOT_WRITE_PAUSE_AFTER_SECONDARY_LIMITS` 次，或 owner、operator 手动暂停）（D-59）。operator 可以暂停写入，恢复只归 owner（[SECURITY](../../architecture/SECURITY.md) S-09） |
| C-03 | **实例隔离**：实例角色由 `GEEK_BOT_INSTANCE_ROLE`（`preview` 或 `production`）显式给出，没配就拒绝启动。preview 只写 `GEEK_BOT_PUBLISHER_REPO_ALLOWLIST` 里的沙盒仓库，清单为空时不写任何仓库；production 不写 `GEEK_BOT_PUBLISHER_REPO_DENYLIST` 里的仓库；某个清单在另一个角色下被设置时拒绝启动（B-64）。越界的写入一律拒绝并写审计，不按 `dry_run` 处理。清单在启动和每次仓库发现后解析成 GitHub 数字 id，按 id 比较，仓库改名不影响（D-56） |
| C-04 | **仓库状态**：目标仓库按 GitHub 数字 id 与任务记录一致；已监控，不是 `lost` 或 archived；这次写入需要的开关开着（`switches.review`、`switches.triage`、`switches.fix`、`switches.rework`）（D-55） |
| C-05 | **权限复核**：发送前重新请求一次仓库的 `permissions`，不用缓存；低于这条 W 要求的权限就拒绝（B-04） |
| C-06 | **目标一致**：owner、仓库、条目号、评论 id、分支名都取自任务记录，与请求一致；不跨仓库、不跨条目；条目类型（issue 或 PR）与这条 W 要求的一致（D-57） |
| C-07 | **「谁来做」复核**（issue 相关写入）：issue 仍开着、没有被锁定；没有分给人；没有 `labels.manual`；没有新的开着的关联 PR（B-41）。条件变了就放弃这次写入；`recheck.post_progress_note` 打开时只发一条 `kind=progress` 说明（W-01） |
| C-08 | **状态没变**：PR 类写入时 PR 的 head 仍等于任务的 head（审查已合并的 PR 时核对合并前的 head）；推送时远端分支的 sha 仍等于机器人上次推送的值；关闭时 issue 没有被人重开过（D-60） |
| C-09 | **正文格式**（只适用于评论、review、issue 正文和 PR 正文，即 W-01–W-04、W-09、W-11）：经过下文「输出中和」；第一行是追踪记录头，最后一行是隐藏标记（[ADR-0005](../../decisions/0005-rules-from-base-branch.md)）；长度在 GitHub 上限以内。issue 与 PR 的标题、提交信息同样要中和（W-09、W-10–W-12 各自写明），但不带记录头和标记 |
| C-10 | **幂等与限速**：插入意图时，outbox 里同一 `dedupe_key` 没有状态为 `pending`、`sending`、`sent`、`confirmed`、`dry_run`、`unknown` 的行；状态为 `failed`、`rejected` 的旧行不算，可以重新插入（见「幂等与 outbox」）。发送时令牌桶有余额，同一仓库的写入串行 |
| C-11 | **审计**：允许、拒绝、`dry_run` 都写 `audit_logs`；拒绝时记下命中的 D 编号，没有对应 D 编号时记「不在白名单」；审计里不写任何令牌值 |

## 允许清单

| 编号 | 端点 | 参数约束 | 前置核对 | 理由 | 测试 |
|---|---|---|---|---|---|
| W-01 | 发 issue 评论：`POST /repos/{owner}/{repo}/issues/{issue_number}/comments` | 请求体只有 `body`；目标是 issue（对象里没有 `pull_request` 字段）；正文按记录类型由模板生成（受理、追问 `kind=blocked`、提醒、关闭记录 `kind=closed`、改写说明、放弃说明 `kind=progress`），模型只能填字段内容；追问和提醒的模板可以 @ 这个 issue 的作者，其它 @ 一律转义 | C-01–C-06、C-08–C-11；C-07：受理、追问、提醒、关闭记录要求「谁来做」条件仍成立；条件变了时只允许发一条 `kind=progress` 放弃说明，每个任务最多一条 | 受理、追问、提醒和关闭前的原因说明都要在 issue 上留记录（B-30–B-39、B-41） | #9 允许用例 |
| W-02 | 发 PR 评论：`POST /repos/{owner}/{repo}/issues/{issue_number}/comments`（`issue_number` 是 PR 号） | 请求体只有 `body`；目标是 PR；只用于两类：机器人自己开的 PR 上的返工记录 `kind=rework`，以及仓库开启 `review.post_failure_notice` 时的「自动审查未完成」说明 | C-01–C-06、C-08–C-11；返工记录要求 PR 作者是机器人账号、PR 仍开着 | 返工要说明改了什么、回应了哪几条意见（B-46）；审查失败时告知作者（B-23） | #9 允许用例 |
| W-03 | 发 PR review：`POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews` | `event` 必须是字面量 `COMMENT`（区分大小写，不去空格）；`body` 非空；`commit_id` 必填且等于任务的 head；`comments[]` 每项只许 `path`、`line`、`side`、`start_line`、`start_side`、`body`，`side`、`start_side` 只能是 `RIGHT`，落点必须在这个 head 的 diff 里，落不到的并进正文；不许 `position` | C-01–C-06、C-08–C-11；机器人对这个 PR 的上一次 review 已过 `GEEK_BOT_REVIEW_MIN_INTERVAL_SECONDS`；同一个 head 只发一次 | PR 必审，只发评论（B-15）；机器审查不写结论行（B-22） | #9 允许用例；#15 沙盒仓库真实演练，GraphQL 查到 `reviewDecision` 仍为 null |
| W-04 | 改自己的评论：`PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}` | 请求体只有 `body`；评论作者是机器人账号（按数字 id 核对）；原正文带本实例 `env` 的隐藏标记，新正文保留同一个标记，`kind`、`task` 不变 | C-01–C-06、C-09–C-11 | 更正机器人自己发的记录（例如补打码、修正失效的引用）；评论不删（D-16）（B-47） | #9 允许用例 |
| W-05 | 加等待标签：`POST /repos/{owner}/{repo}/issues/{issue_number}/labels` | 请求体 `{"labels":["<labels.blocked>"]}`，只有这一个名字；目标是 issue；标签在仓库里还不存在时先走 W-07，没有 push 权限就不打标签、只评论 | C-01–C-08、C-10、C-11；权限至少 triage | 追问时打 `labels.blocked`，表示在等回复（B-30） | #9 允许用例 |
| W-06 | 去掉等待标签：`DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}` | `name` 只能是 `labels.blocked` | C-01–C-06、C-08、C-10、C-11；权限至少 triage | 有人回复后由机器人去掉等待标签（B-31） | #9 允许用例 |
| W-07 | 建等待标签：`POST /repos/{owner}/{repo}/labels` | `name` 是 `labels.blocked`，而且仓库里还没有；`color`、`description` 取内置值，`description` 不超过 100 个字符 | C-01–C-06、C-10、C-11；权限至少 push | 标签不存在时 W-05 无法执行；建标签需要 push 权限（B-04） | #9 允许用例 |
| W-08 | 关闭 issue：`PATCH /repos/{owner}/{repo}/issues/{issue_number}` | 请求体只许 `state: "closed"`、`state_reason` 和 `duplicate_issue_id`，其它字段一律拒绝（D-14）。关闭原因 `close_reason` 只能取下面 5 个值之一，与 `threads.close_reason` 逐字一致，并按对应关系填 `state_reason`：`no_reply`（到期无人回复）→ `not_planned`；`unclear_after_followup`（追问轮数用完仍不清楚）→ `not_planned`；`low_value`（价值不高：已解决、不属于本仓库、没法执行）→ `not_planned`；`duplicate`（与同仓库另一个 issue 重复）→ `duplicate`，带 `duplicate_issue_id` 指向那个 issue；`superseded_by_rewrite`（被改写重开的新 issue 取代）→ `not_planned` | C-01–C-06、C-10、C-11；权限至少 triage。发送前重新读 issue 和时间线：没有 `pull_request` 字段（是 issue 不是 PR）；仍开着；时间线里没有非机器人账号的 `reopened` 事件；没分给人；没有 `labels.manual`；`close_reason` 来自状态机，不是模型的自由文本；`superseded_by_rewrite` 要求 W-09 的新 issue 已 `confirmed`；这次关闭对应的关闭记录（W-01 `kind=closed`）已经是 `confirmed` | 机器人判定的关闭：B-33–B-39 | #9 允许用例；#16 集成测试（可注入时钟） |
| W-09 | 新开 issue（改写重开）：`POST /repos/{owner}/{repo}/issues` | 只许 `title`、`body`，以及有 push 权限时的 `labels`（只能是 `labels.blocked`）；不许 `assignees`、`milestone`、`type`、`parent_issue_id`、`issue_field_values`；标题和正文经中和；正文按仓库的 issue 模板，必须引用原 issue（同一仓库的 `#n`）；模板里 @ 原 issue 的作者，这是这条写入唯一的 @ 提及，模型文本里的 @ 一律转义；每个原 issue 最多改写一次（见 `dedupe_key`） | C-01–C-06、C-08–C-11；C-07 对原 issue 核对；原 issue 仍开着，没被人重开过 | 回复后说清楚了、但不合仓库 issue 规范时，按模板改写（B-36） | #9 允许用例；#16 沙盒演练 |
| W-10 | 推新的机器人分支：git 推送（智能 HTTP，`POST /{owner}/{repo}.git/git-receive-pack`） | 命令形如 `git push --porcelain --no-follow-tags --force-with-lease=refs/heads/<分支>: <显式 URL> <sha>:refs/heads/<分支>`：refspec 只能是 `<sha>:refs/heads/<分支>`，一次一个 ref；`--force-with-lease` 只许这一种写法，期望值为空，表示这个 ref 必须还不存在，保证「新建」是原子的；不带 `+`、`--force`、`--delete`、`--mirror`、`--all`、`--tags`、`--follow-tags`。`--porcelain` 的输出必须恰好更新这一个 ref。分支名由画像的 `branch.template` 生成，能反解出本任务的 issue 号（产品内置默认 `geek-bot/<issue>-<slug>`，见 B-44；本仓库这类按 `task/<issue>/<slug>` 命名的仓库在自己的 `.github/geek-bot.yml` 里配置），不是长期分支。新提交的祖先是任务包所用的 base 提交；作者与提交者是机器人账号；提交信息按模板生成并经中和。diff 不触及禁改路径（S-19），没有 gitlink、符号链接和 LFS 指针，文件数与行数不超过 `fix.max_changed_files`、`fix.max_changed_lines` | C-01–C-06、C-08、C-10、C-11；C-07 对修复的 issue 核对；权限至少 push；`switches.fix` 开着；画像里写入类字段已由 owner 确认（B-07）；同一仓库没有别的写入类任务在推送（B-13） | 修复补丁由 control 提交和推送，执行环境不持有 GitHub 令牌（S-03、B-44） | #9 允许用例；#18 单测 |
| W-11 | 开 PR：`POST /repos/{owner}/{repo}/pulls` | 只许 `title`、`head`、`base`、`body`、`draft`；`head` 是本任务经 W-10 推送并 `confirmed` 的分支名，不带别的 owner 前缀，不许 `head_repo`；`base` 等于集成分支；不许 `issue` 参数；正文按仓库的 PR 模板（B-45），「审查结论」段固定为阻塞（`pr.verdict_block`），`Closes #<本任务的 issue>` 由模板生成；同一个 head 还没有开着的 PR | C-01–C-11；权限至少 push；`switches.fix` 开着 | 修小改动后开 PR 交给人审查和合并（B-45） | #9 允许用例；#18 沙盒演练 |
| W-12 | 返工：追加推送到自己的 PR 分支：git 推送（`POST /{owner}/{repo}.git/git-receive-pack`） | 命令形如 `git push --porcelain --no-follow-tags <显式 URL> <sha>:refs/heads/<分支>`，不带任何 force 选项，由服务端拒绝非快进；`--porcelain` 的输出必须恰好更新这一个 ref。diff 与提交信息的约束同 W-10；分支登记在 `bot_branches`；对应 PR 的作者是机器人账号，而且仍开着；推送前 `ls-remote` 核对远端当前 sha 等于机器人上次推送的 sha（中间没有别人推过）；新提交以它为祖先，只追加提交；不改 PR 标题和正文（D-15） | C-01–C-06、C-08、C-10、C-11；权限至少 push；`switches.rework` 开着 | 收到审查意见、CI 失败或与目标分支冲突时返工（B-46） | #9 允许用例；#18 单测与沙盒演练 |
| W-13 | 接受协作邀请：`PATCH /user/repository_invitations/{invitation_id}` | 无请求体；`invitation_id` 必须出现在 `GET /user/repository_invitations` 的当前结果里 | 只由 owner 在后台点击触发，并在 10 分钟内重新认证过（[SECURITY](../../architecture/SECURITY.md) S-09 第 8 项）；不由自动流程或模型输出触发（B-06）；C-02、C-10、C-11；preview 只能接受沙盒清单里仓库的邀请（C-03）；不受仓库写入模式影响 | 协作者仓库要先接受邀请才能访问；接受会扩大机器人的访问范围，必须由人决定（B-06） | #9 允许用例；#6 路由测试 |
| W-14 | 吊销单枚 OAuth 令牌：`DELETE /applications/{client_id}/token` | 用本环境 OAuth App 的 `client_id` 和 client secret 做 Basic 认证；请求体只有 `access_token`，只能是下面几种之一：owner、operator、viewer 登录后台时取得的令牌（申请空 scope，取完数字 id 就吊销，包括机器人账号本人登录）；重新认证取得的令牌；不在管理员名单里的账号登录时取得的令牌；重新绑定成功后机器人的旧令牌；owner 解绑时机器人的当前令牌 | 解绑由 owner 在后台操作并重新认证（S-09 第 1 项）；C-10、C-11（审计不写令牌值）；不受写入模式和写入暂停影响：吊销是收回权限 | 登录令牌取完身份即吊销，避免同一 App 下的令牌累积、挤掉机器人令牌（S-11）；从不删除整个 grant（D-54） | #9 允许用例；#5 路由测试 |

W-10 与 W-12 的推送共同要求（D-30、D-40）：

- 在从镜像克隆检出的**非镜像工作克隆**里执行，按显式 URL 推送，不用 remote 名；镜像克隆本身只用于 fetch。
- 隔离 git 配置：`GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=/dev/null`；工作克隆的仓库配置里不许有 `push.followTags`、`remote.*.push`、`remote.*.mirror`，推送前检查，有就拒绝。`core.hooksPath=/dev/null`，不递归 submodule，不启用 LFS。
- 令牌只经 `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_*` / `GIT_CONFIG_VALUE_*` 环境变量注入 `http.extraHeader`，不进 URL、argv 和 `.git/config`。
- 推送前后各 `ls-remote` 一次：目标分支的远端 sha 等于刚推的提交，`refs/tags/*` 前后完全一致，才记 `confirmed` 并写入 `bot_branches`；tag 有变化按 D-30 处理。
- git 没有 `git push --no-tags` 这个选项，挡住 tag 靠 `--no-follow-tags`、隔离配置和推送后的核对三道。#18 另加一条反例：工作克隆设了 `push.followTags=true` 时推送，远端不出现新 tag（推送前检查会拒绝这份配置；即使绕过检查，`--no-follow-tags` 仍然覆盖它）。

## 拒绝清单

每一条都要在 #9 有一个拒绝用例：构造对应的请求或意图，断言 publisher 没有发出任何网络请求，并在审计里记下这个 D 编号。推送类的几条另在 #18 的单测里覆盖。

### 审查与合并

| 编号 | 端点或操作 | 为什么拒绝 | 测试 |
|---|---|---|---|
| D-01 | `POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews`，`event` 为 `APPROVE` | 批准只由人做；没有分支保护时，批准可能满足别处设定的合并条件（B-15） | #9 拒绝用例 |
| D-02 | 同上，`event` 为 `REQUEST_CHANGES` | 机器人不替人下阻塞结论；这种 review 会一直挡在 `reviewDecision` 里，要人去驳回 | #9 拒绝用例 |
| D-03 | 同上，`event` 缺失、为空串或 null，或不是字面量 `COMMENT`（如 `comment`、带空格的 `COMMENT `） | 留空会生成 PENDING review，之后提交时的 event 不受控；大小写和空格变体用来绕过比较 | #9 拒绝用例 |
| D-04 | 提交、改写、删除或驳回 review：`POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/events`、`PUT /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}`、`DELETE /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}`、`PUT /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/dismissals` | 机器人从不创建 pending review；自己的 review 发出后不改（新 head 发新 review）；驳回别人的 review 会改变合并条件 | #9 拒绝用例 |
| D-05 | 合并 PR：`PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge` | 合并只由人做 | #9 拒绝用例；#18 单测 |
| D-06 | 绕过 PR 的合并：`POST /repos/{owner}/{repo}/merges`、`POST /repos/{owner}/{repo}/merge-upstream` | 直接把一个分支合进另一个分支，等于合并 | #9 拒绝用例 |
| D-07 | 启用自动合并或进合并队列：GraphQL `enablePullRequestAutoMerge`、`mergePullRequest`、`enqueuePullRequest` | 检查通过后由 GitHub 替人合并；REST 没有对应端点，只能在 GraphQL 层拦 | #9 拒绝用例 |
| D-08 | 更新 PR 分支：`PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch` | 在 PR 的 head 分支上生成合并提交；对别人的 PR 就是改别人的分支，对自己的 PR 应走 W-12 | #9 拒绝用例 |
| D-09 | 指派或取消审查人：`POST`、`DELETE /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers` | 会通知别人并改变仓库的审查流程；没有默认规则需要 | #9 拒绝用例 |

### issue 与 PR 条目

| 编号 | 端点或操作 | 为什么拒绝 | 测试 |
|---|---|---|---|
| D-10 | 关闭 PR：`PATCH /repos/{owner}/{repo}/pulls/{pull_number}` 带 `state: "closed"`，或 `PATCH /repos/{owner}/{repo}/issues/{issue_number}` 而目标是 PR（对象带 `pull_request` 字段） | 只关 issue，不关 PR（B-38）；issues 端点对 PR 同样生效，必须按条目类型拦 | #9 拒绝用例；#16 集成测试 |
| D-11 | 重开 issue：`PATCH /repos/{owner}/{repo}/issues/{issue_number}` 带 `state: "open"` 或 `state_reason: "reopened"`，包括重开别人关的 issue 和机器人自己关过的 issue | 默认行为里没有重开；重开别人关的 issue 等于推翻人的决定 | #9 拒绝用例 |
| D-12 | 关闭被人重开过的 issue：时间线里有非机器人账号的 `reopened` 事件 | 人重开过的 issue 机器人不再关，只评论（B-37） | #9 拒绝用例；#16 集成测试 |
| D-13 | 不满足 W-08 其它条件的关闭：分给了人、有 `labels.manual`、关闭原因不是状态机枚举值、关闭记录还没 `confirmed`、权限低于 triage、issue 已经关闭 | 关闭只能来自机器人自己的状态机判定，并且先留记录（B-39） | #9 拒绝用例 |
| D-14 | `PATCH /repos/{owner}/{repo}/issues/{issue_number}` 带 `title`、`body`、`labels`、`assignees`、`milestone`、`type`、`issue_field_values` 任一字段，包括机器人自己开的 issue | 不改别人的 issue；自己开的 issue 开出后也不改，免得覆盖人补充的内容 | #9 拒绝用例 |
| D-15 | `PATCH /repos/{owner}/{repo}/pulls/{pull_number}` 带 `title`、`body`、`base`、`maintainer_can_modify` 任一字段，包括机器人自己开的 PR | 不改别人 PR 的正文（B-47）；自己的 PR 开出后不改正文（B-46）；改 `base` 能把 PR 指向长期分支 | #9 拒绝用例 |
| D-16 | 删评论：`DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}`、`DELETE /repos/{owner}/{repo}/pulls/comments/{comment_id}`，包括机器人自己的评论 | 删除抹掉审计线索；自己的评论只许按 W-04 修改 | #9 拒绝用例 |
| D-17 | 改别人的评论：`PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}` 而作者不是机器人账号，或正文没有本实例标记，或新正文改动了标记；`PATCH /repos/{owner}/{repo}/pulls/comments/{comment_id}` | 改别人的评论等于冒充；改标记会破坏幂等和状态重建 | #9 拒绝用例 |
| D-18 | 单独的行内评论和回复：`POST /repos/{owner}/{repo}/pulls/{pull_number}/comments`、`POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies` | 行内意见只随 W-03 的 review 一起发，保证 event 受控、一次审查一次写入 | #9 拒绝用例 |
| D-19 | 分配负责人：`POST`、`DELETE /repos/{owner}/{repo}/issues/{issue_number}/assignees`，或创建、更新条目时带 `assignees` | 改变「谁来做」的判定并通知对方；分配是维护者的决定 | #9 拒绝用例 |
| D-20 | 里程碑：`POST /repos/{owner}/{repo}/milestones`、`PATCH`、`DELETE /repos/{owner}/{repo}/milestones/{milestone_number}`，或条目带 `milestone` | 里程碑是维护者的计划工具，没有默认规则需要 | #9 拒绝用例 |
| D-21 | 锁定与解锁：`PUT`、`DELETE /repos/{owner}/{repo}/issues/{issue_number}/lock` | 锁定会让人没法回复追问；解锁推翻维护者的决定 | #9 拒绝用例 |
| D-22 | 转移、置顶、转讨论、子 issue：GraphQL `transferIssue`、`pinIssue`、`unpinIssue`，把 issue 转成 discussion，`POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues`（REST 没有转移 issue 的端点） | 把条目移出仓库或改变它的组织方式，超出机器人的职责 | #9 拒绝用例 |
| D-23 | 标签越界：`POST /repos/{owner}/{repo}/issues/{issue_number}/labels` 含 `labels.blocked` 以外的名字（包括 `labels.manual`）或为空数组；`PUT /repos/{owner}/{repo}/issues/{issue_number}/labels`（整体替换，空数组即清空）；`DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels`（全部删除）；`DELETE …/labels/{name}` 且名字不是 `labels.blocked`（包括去掉 `labels.manual`） | 机器人只动等待标签；加或去 `labels.manual` 都是替人改「别接」的决定，没有默认规则需要 | #9 拒绝用例 |
| D-24 | 仓库标签管理：`DELETE /repos/{owner}/{repo}/labels/{name}`、`PATCH /repos/{owner}/{repo}/labels/{name}`，或 `POST /repos/{owner}/{repo}/labels` 的名字不是 `labels.blocked` | 删标签会从所有条目上去掉它；改名会破坏别的流程 | #9 拒绝用例 |
| D-25 | 越界的开 PR：`POST /repos/{owner}/{repo}/pulls` 带 `issue` 参数；`head` 带别的 owner 前缀或带 `head_repo`（来自 fork 或其它仓库）；`base` 不是集成分支；`head` 不是本任务登记的机器人分支；同一个 head 已有开着的 PR | `issue` 参数会把一个现有 issue 整个变成 PR；从 fork 开 PR 不在范围内（#18 不做）；base 不对就可能合进长期分支 | #9 拒绝用例；#18 单测 |
| D-26 | 越界的新开 issue：`POST /repos/{owner}/{repo}/issues` 不对应任何改写任务、正文没有引用原 issue、同一原 issue 已经改写过，或带 `assignees`、`milestone`、`type`、`parent_issue_id`、`issue_field_values` | 新开 issue 只用于改写重开（B-36），防止被诱导刷 issue | #9 拒绝用例 |
| D-27 | 其它内容写入：表情回应（`POST /repos/{owner}/{repo}/issues/{issue_number}/reactions` 等）、提交评论（`POST /repos/{owner}/{repo}/commits/{commit_sha}/comments`）、订阅与加星（`PUT /repos/{owner}/{repo}/subscription`、`PUT /user/starred/{owner}/{repo}`）、讨论（GraphQL）、wiki（推送 `{repo}.wiki.git`）、Projects（GraphQL） | 没有默认规则需要；有些机器人把表情回应当作指令 | #9 拒绝用例 |
| D-62 | 重开 PR：`PATCH /repos/{owner}/{repo}/pulls/{pull_number}` 带 `state: "open"`，或 `PATCH /repos/{owner}/{repo}/issues/{issue_number}` 带 `state: "open"` 而目标是 PR，包括机器人自己开的 PR | PR 关闭是人的决定；重开会让已放弃的改动重新进入审查和合并流程 | #9 拒绝用例 |
| D-63 | issue 依赖：`POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by`、`DELETE /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by/{issue_id}` | 依赖关系是维护者的计划工具，没有默认规则需要；模型可能被诱导把条目互相挂起 | #9 拒绝用例 |

### 分支、ref 与提交

| 编号 | 端点或操作 | 为什么拒绝 | 测试 |
|---|---|---|---|
| D-28 | 推默认分支：refspec 目标是仓库的默认分支（包括写成 `HEAD`、大小写变体） | 默认分支只由人通过合并改变；推上去可能直接触发部署 | #9 拒绝用例；#18 单测（推送前后默认分支 sha 不变） |
| D-29 | 推任何长期分支：`branch.base`、`main`、`master`、`stage`、`develop`、`dev`、`trunk`、`gh-pages`、`release/*`、`hotfix/*`，包括新建这些名字的分支 | 这些分支承载发布和部署；新建 `release/*` 这类分支也可能触发目标仓库的部署工作流 | #9 拒绝用例；#18 单测 |
| D-30 | 推 tag：refspec 指向 `refs/tags/*`；带 `--tags` 或 `--follow-tags`，或缺少 `--no-follow-tags`；工作克隆的配置里有 `push.followTags`；`POST /repos/{owner}/{repo}/git/refs` 的 `ref` 是 `refs/tags/*`；`POST /repos/{owner}/{repo}/git/tags`。推送后 `ls-remote` 发现 `refs/tags/*` 有变化时按事故处理：进入「暂停全部写入」并告警 | `vX.Y.Z` 这类 tag 可能触发目标仓库的发布和部署；发版只由人做 | #9 拒绝用例；#18 单测（含 `push.followTags=true` 的反例） |
| D-31 | 创建、修改或删除 release：`POST /repos/{owner}/{repo}/releases`、`PATCH`、`DELETE /repos/{owner}/{repo}/releases/{release_id}` | 创建 release 会同时创建 tag 并对外发布 | #9 拒绝用例 |
| D-32 | 上传 release asset：`POST https://uploads.github.com/repos/{owner}/{repo}/releases/{release_id}/assets` | 能替换发布给用户下载的文件 | #9 拒绝用例 |
| D-33 | 强推与非快进：refspec 带 `+`，`--force`、`--mirror`、`--all`；`--force-with-lease` 的任何其它写法（唯一例外是 W-10 新建分支时期望值为空的 `--force-with-lease=refs/heads/<分支>:`）；新提交不以远端当前 sha 为祖先；`PATCH /repos/{owner}/{repo}/git/refs/{ref}` 带 `force: true` | 改写历史会抹掉别人的提交；返工只追加提交（B-46） | #9 拒绝用例；#18 单测 |
| D-34 | 删分支或改名：推送 `:refs/heads/<分支>`、`--delete`、`--prune`；`DELETE /repos/{owner}/{repo}/git/refs/{ref}`；`POST /repos/{owner}/{repo}/branches/{branch}/rename`，包括机器人自己的分支 | 删除和改名由人或仓库的「合并后自动删除分支」设置处理；机器人删分支会丢掉待审的工作 | #9 拒绝用例；#18 单测 |
| D-35 | 推别人的分支：远端已存在但不在 `bot_branches` 里的分支；在 `bot_branches` 里但远端 sha 不等于机器人上次推送的值（有人推过）；对应 PR 已关闭或已合并；分支名不符合 `branch.template` 或反解出的 issue 号不是本任务的 | 只推机器人自己建、自己维护的分支（S-06） | #9 拒绝用例；#18 单测 |
| D-36 | 创建或修改 `.github/workflows/**`、`.github/actions/**`（新增、修改、删除、重命名进出这两个目录都算），不论配置如何 | 同路径同内容的文件已在其它分支存在时，GitHub 不要求 `workflow` scope（R-02）；改工作流等于改 CI 的权限和行为 | #9 拒绝用例；#18 单测 |
| D-37 | 触及其它禁改内容：根目录、`.github/`、`docs/` 下的 `CODEOWNERS`；`.gitmodules`；gitlink（模式 160000）；符号链接（模式 120000）；LFS 指针；`fix.forbidden_paths` 里的路径；超过 `fix.max_changed_files`、`fix.max_changed_lines` | CODEOWNERS 决定谁有审查权；子模块和符号链接能把补丁指向仓库以外的内容；修复只限小改动（B-43） | #9 拒绝用例；#18 单测 |
| D-38 | 绕过镜像克隆写内容：`PUT`、`DELETE /repos/{owner}/{repo}/contents/{path}`；`POST /repos/{owner}/{repo}/git/blobs`、`/git/trees`、`/git/commits`、`/git/refs`；GraphQL `createCommitOnBranch`、`updateRef`、`deleteRef` | 提交只经 W-10、W-12 在镜像克隆里生成，保证禁改路径和快进检查只有一处实现 | #9 拒绝用例 |
| D-39 | 提交状态与检查：`POST /repos/{owner}/{repo}/statuses/{sha}`、`POST /repos/{owner}/{repo}/check-runs`、`PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}`、`POST /repos/{owner}/{repo}/check-suites` | 能伪造「CI 通过」，让人或自动合并误以为检查已过 | #9 拒绝用例 |
| D-40 | git 传输越界：经 SSH 推送；按 remote 名而不是显式 URL 推送；在镜像克隆里推送；remote URL 里带令牌、令牌出现在 argv；没有设置 `GIT_CONFIG_NOSYSTEM=1` 和 `GIT_CONFIG_GLOBAL=/dev/null`；仓库配置里有 `push.followTags`、`remote.*.push`、`remote.*.mirror`；`--porcelain` 的输出显示更新了不止一个 ref；启用仓库 hooks、递归 submodule、启用 LFS | 令牌会落进进程列表、日志或 `.git/config`；系统或全局配置、`remote.*.push` 和 `remote.*.mirror` 会让一次推送带出别的 ref；hooks 和 submodule 会在 control 里执行仓库内容（S-05） | #9 拒绝用例 |

### 仓库设置与成员

| 编号 | 端点或操作 | 为什么拒绝 | 测试 |
|---|---|---|---|
| D-41 | 仓库设置：`PATCH /repos/{owner}/{repo}`（默认分支、可见性、合并选项等）、`DELETE /repos/{owner}/{repo}`、`POST /repos/{owner}/{repo}/transfer`、`PUT /repos/{owner}/{repo}/topics`、`PUT /repos/{owner}/{repo}/environments/{environment_name}`、`PUT /repos/{owner}/{repo}/actions/permissions` | 仓库设置决定谁能做什么；机器人账号本不该有 admin 权限（S-07），有也不用 | #9 拒绝用例 |
| D-42 | 分支保护与 rulesets：`PUT`、`DELETE /repos/{owner}/{repo}/branches/{branch}/protection` 及其子资源；`POST /repos/{owner}/{repo}/rulesets`、`PUT`、`DELETE /repos/{owner}/{repo}/rulesets/{ruleset_id}` | 去掉保护就能推主干；加保护会卡住人的工作 | #9 拒绝用例 |
| D-43 | 协作者与成员：`PUT`、`DELETE /repos/{owner}/{repo}/collaborators/{username}`；`PATCH`、`DELETE /repos/{owner}/{repo}/invitations/{invitation_id}`；`PUT`、`DELETE /orgs/{org}/memberships/{username}`；团队的仓库权限 | 增删协作者直接改变谁能访问私有代码 | #9 拒绝用例 |
| D-44 | 不是 owner 在后台点击触发的邀请处理：自动或按模型输出调用 `PATCH /user/repository_invitations/{invitation_id}`；owner 超过 10 分钟没有重新认证；拒绝邀请 `DELETE /user/repository_invitations/{invitation_id}`；接受组织成员邀请 `PATCH /user/memberships/orgs/{org}` | 接受邀请会扩大机器人的访问范围，只能由 owner 决定（B-06、S-09）；加入组织超出 W-13 的范围 | #9 拒绝用例 |
| D-45 | webhook：`POST /repos/{owner}/{repo}/hooks`、`PATCH`、`DELETE /repos/{owner}/{repo}/hooks/{hook_id}`、`POST /repos/{owner}/{repo}/hooks/{hook_id}/tests`；组织 webhook `POST /orgs/{org}/hooks` | webhook 能把仓库事件（包括私有代码的 diff）持续发到任意地址；绑定时也拒绝 `admin:repo_hook` scope | #9 拒绝用例 |
| D-46 | 长期凭据：`POST /repos/{owner}/{repo}/keys`（deploy key）、`POST /user/keys`、`POST /user/gpg_keys`、`POST /user/ssh_signing_keys` | 会留下不经 OAuth、吊销令牌也收不回的访问途径 | #9 拒绝用例 |
| D-47 | 驳回安全告警：`PATCH /repos/{owner}/{repo}/code-scanning/alerts/{alert_number}`、`PATCH /repos/{owner}/{repo}/dependabot/alerts/{alert_number}`、`PATCH /repos/{owner}/{repo}/secret-scanning/alerts/{alert_number}` | 驳回会把真实的漏洞或泄露藏起来 | #9 拒绝用例 |
| D-48 | fork：`POST /repos/{owner}/{repo}/forks` | 会在机器人账号下留一份私有代码副本；从 fork 开 PR 不在范围内 | #9 拒绝用例 |
| D-64 | 建仓库：`POST /user/repos`、`POST /orgs/{org}/repos`、`POST /repos/{template_owner}/{template_repo}/generate` | 新仓库可以用来存放外传的代码，或在组织里留下不受管的仓库；机器人只在已有仓库里工作 | #9 拒绝用例 |

### Actions、密钥、包与账号

| 编号 | 端点或操作 | 为什么拒绝 | 测试 |
|---|---|---|---|
| D-49 | Actions 运行控制：`POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun`、`/rerun-failed-jobs`、`/approve`、`/cancel`、`/force-cancel`、`/pending_deployments`；`POST /repos/{owner}/{repo}/actions/jobs/{job_id}/rerun`；`DELETE /repos/{owner}/{repo}/actions/runs/{run_id}`；`POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches`；`POST /repos/{owner}/{repo}/dispatches` | 批准 fork PR 的运行会让不可信代码在 CI 里执行；dispatch 能触发部署类工作流；批准待部署的环境等于放行部署 | #9 拒绝用例 |
| D-50 | secrets 与 variables：`PUT`、`DELETE /repos/{owner}/{repo}/actions/secrets/{secret_name}`；`POST /repos/{owner}/{repo}/actions/variables`、`PATCH`、`DELETE /repos/{owner}/{repo}/actions/variables/{name}`；环境、dependabot、codespaces 和组织级的同类端点 | 改 secrets 或 variables 能改变 CI 和部署的行为 | #9 拒绝用例 |
| D-51 | packages 写入：向 ghcr 推镜像；`DELETE /user/packages/{package_type}/{package_name}`、`DELETE /orgs/{org}/packages/{package_type}/{package_name}` 及其恢复端点 | 能替换或删除别人部署用的镜像；绑定时也拒绝 `write:packages` scope | #9 拒绝用例 |
| D-52 | gists：`POST /gists`、`PATCH`、`DELETE /gists/{gist_id}`、`POST /gists/{gist_id}/comments`、`PUT /gists/{gist_id}/star` | gist 能把私有代码贴到仓库以外（secret gist 知道链接就能看） | #9 拒绝用例 |
| D-53 | 部署、Pages、Codespaces：`POST /repos/{owner}/{repo}/deployments` 及其状态端点、`POST /repos/{owner}/{repo}/pages`、`POST /repos/{owner}/{repo}/codespaces` | 触发部署或发布站点，或在云端运行仓库代码 | #9 拒绝用例 |
| D-54 | OAuth 授权与账号设置：`DELETE /applications/{client_id}/grant`；`PATCH /applications/{client_id}/token`（重置令牌）；W-14 三种情形以外的 `DELETE /applications/{client_id}/token`；`PATCH /user`、`PUT /user/following/{username}`、`POST /user/emails` | 删 grant 会连同一 App 下的机器人令牌一起吊销；重置令牌会让现有令牌失效；账号资料不归机器人管 | #9 拒绝用例；#5 路由测试 |

### 范围与实例

| 编号 | 端点或操作 | 为什么拒绝 | 测试 |
|---|---|---|---|
| D-55 | 写未开启写入的仓库：实际写入模式是 `off`（`dry_run` 只记录不发送）；需要的开关没开；仓库是 `lost`、archived 或未监控；组织还没批准 OAuth App | 写入逐个仓库开启（B-02、B-03）；没开启的仓库对机器人来说是只读的 | #9 拒绝用例 |
| D-56 | 实例越界：`GEEK_BOT_INSTANCE_ROLE` 没配或取值不对（拒绝启动）；preview 写 `GEEK_BOT_PUBLISHER_REPO_ALLOWLIST` 以外的仓库，或清单为空时写任何仓库；production 写 `GEEK_BOT_PUBLISHER_REPO_DENYLIST` 里的仓库 | 两个实例共用一个机器人账号，只能靠清单互斥，防止在真实仓库重复写入（B-64、R-09）；越界一律拒绝并写审计，不当作 `dry_run` | #9 拒绝用例（preview 配置下被拒并写审计；缺少实例角色时启动失败） |
| D-57 | 跨仓库、跨条目：请求的仓库、条目号、评论 id 或分支不是任务记录里的，包括模型输出里提出的目标（「去 #n 评论」「关闭 #n」） | 写入目标只来自任务记录，不来自模型输出（S-05）；防止提示注入把写入引到别处 | #9 拒绝用例；#16 集成测试（注入指令的 issue 没有引起其它条目上的写入） |
| D-58 | GraphQL mutation：`POST /graphql` 的文档里有任何 `mutation` 操作（按 GraphQL 语法解析判定，不按字符串匹配；解析不了也拒绝） | v1 的允许清单全部映射到 REST 和 git，没有一条走 GraphQL；读取层用同一个解析器，只放行只含 query 的文档（D-61） | #9 拒绝用例 |
| D-59 | 暂停期间的写入：处于「暂停全部写入」时的任何 W（W-14 除外） | 令牌失效、scope 变化或反复触发限额时，继续写只会扩大问题（B-55） | #9 拒绝用例 |
| D-60 | 过期的写入：review 的 `commit_id` 不等于 PR 当前的 head；推送时远端分支已被别人更新；关闭时 issue 已被人重开或已关闭；任何发送前复核不通过的意图 | 基于旧状态做的决定不能发出（B-41） | #9 拒绝用例；#15 集成测试（审查中推新提交，最新 sha 只收到 1 条 review） |
| D-61 | publisher 以外的写请求。publisher 以外只许下面几种请求，其余一律拒绝：GitHub 读取层只发 `GET`，以及只含 query 的 `POST /graphql`（用 D-58 的同一个解析器判定）；git 只走 upload-pack（fetch、clone），不走 receive-pack；登录模块只发 `POST https://github.com/login/device/code` 和 `POST https://github.com/login/oauth/access_token`。其它模块发 `POST`、`PUT`、`PATCH`、`DELETE` 或执行 `git push` 都算违规 | 出口只有一个，白名单才有意义（S-06）；由 `check-boundaries` 的规则和 [CODE-REVIEW](../../conventions/CODE-REVIEW.md) 第 11 项的检查命令拦截，运行时由 GitHub 客户端按调用方再拦一次 | #9 边界检查用例（在 publisher 以外放一个写请求，检查失败）；#9 拒绝用例（读取层发 mutation 被拒） |

## 输出中和

中和作用在机器人写到 GitHub 的每一段文字上：评论、review 正文和行内评论、issue 与 PR 的标题和正文、提交信息。它由 publisher 在发送前执行，渲染后的结果就是 `dry_run` 预览里看到的内容。记录头和隐藏标记只加在正文上（C-09），标题和提交信息只做中和。

1. **模板生成的部分不交给模型。** 追踪记录头、隐藏标记、「审查结论」段、`Closes #<本任务的 issue>` 都由 publisher 按模板生成；模型只能填字段内容。
2. **去掉 HTML 注释。** 删除模型文本里所有 `<!-- … -->`，没闭合的 `<!--` 一直删到文本末尾。模型伪造的追踪记录头和 `geek-bot v1` 标记因此进不了正文。
3. **中和结论行和指令。** 模型文本里形如「结论：通过」的行（不论全角半角冒号，带不带加粗、引用、列表前缀），以及 `/approve`、`/lgtm`、`/merge` 这类指令行，放进行内代码并加说明前缀，使 `pr-contract`、追踪记录解析器和其它机器人都识别不了。
4. **中和关闭关键字。** 模型文本里的 GitHub 关闭关键字（close、closes、closed、fix、fixes、fixed、resolve、resolves、resolved，不分大小写）后面跟着 `#n`、`<owner>/<repo>#n` 或 issue 链接的，同样放进行内代码。提交信息也要处理：分支被人合进默认分支时，提交信息里的关键字同样会关闭 issue。唯一的例外是第 1 条里模板生成的那一个。
5. **转义 @ 提及。** 机器人只会 @ 当前条目的作者，而且只出现在它自己的模板里（追问、提醒、改写重开，W-01、W-09）。模型文本里的用户和团队提及（`@name`、`@org/team`）一律改成不触发通知的写法，包括对条目作者的提及。
6. **跨仓库引用改成纯文本。** 指向其它仓库条目的 `<owner>/<repo>#n` 和完整链接放进行内代码，免得在别人的条目时间线上留下引用。
7. **打码。** 按密钥形态（`ghp_`、`gho_`、`ghu_`、`ghs_`、`ghr_`、`github_pat_`、`gbn_`（节点令牌）、`gbt_`（每任务模型令牌）、`sk-`、`Bearer`、私钥块）和已知密钥的原值（机器人令牌、网关密钥、节点令牌、本任务令牌）替换成 `[已打码]`（S-16）。
8. **限制长度。** 超过 GitHub 上限的正文截断并注明「已截断」；行内评论条数和总长度有上限，数值是 #9 的实现常量，改大按 CODE-REVIEW 第 11 项审查。

「放进行内代码后 GitHub 不再触发关闭、通知和交叉引用」是设计假设，未验证，由 #9 在沙盒仓库实测；不成立时换别的写法，但每条规则要达到的效果不变。#9 的中和测试至少覆盖：`<!--`、「结论：通过」、`Closes #3`、@ 他人（#9 验收条件 3）。

## 幂等与 outbox

本节是 outbox 状态机和 `dedupe_key` 的唯一权威定义，[数据模型](data-model.md) 的 `outbox` 表照抄，不另写一份。

### dedupe_key

`dedupe_key` 标识「同一件逻辑写入」：同一件事不论由哪个任务、哪次重试、哪次重启产生，算出来的键都相同。它由三段组成，用 `|` 连接：

```text
<W 编号>|<目标>|<稳定键>
```

- **不含任务 id**：任务被取消、重排、换节点重跑，键不变，已经发出的写入不会再发一次。
- **不含环境**：preview 与 production 各有自己的库，互不相见；标记里的 `env=` 负责在 GitHub 上区分两个环境的写入。
- **目标**按 `outbox.target_kind` 写，仓库和条目都用 GitHub 数字 id，仓库改名、转移后不变：
  - `repo`：`repo:<仓库 id>`；条目加 `#<条目号>`，评论加 `/comment:<评论 id>`，分支加 `@<分支名>`；
  - `user`：`user:invitation:<邀请 id>`（W-13）；
  - `app`：`app:<client_id>`（W-14）。
- **稳定键**按 W 编号取：

| W | 目标 | 稳定键 |
|---|---|---|
| W-01 | issue | 记录类型 `kind` + 追问轮次（`threads.round`）；放弃说明再加上变化的那一条复核条件 |
| W-02 | PR | 返工记录：返工轮次；审查未完成说明：被审的 head sha（40 位） |
| W-03 | PR | 被审的 head sha（40 位） |
| W-04 | 评论 | 新正文的 sha256 |
| W-05、W-06 | issue | 标签名 + 触发它的追问轮次 |
| W-07 | 仓库 | 标签名 |
| W-08 | issue | `close_reason` |
| W-09 | 原 issue | 固定为 `rewrite`：每个原 issue 只改写一次 |
| W-10 | 分支 | 固定为 `create`：每个分支只新建一次 |
| W-11 | 分支（head） | 固定为 `open`：每个 head 分支只开一个 PR |
| W-12 | 分支 | 推送后的新 head sha（40 位） |
| W-13 | 邀请 | 固定为 `accept` |
| W-14 | App | 被吊销令牌的 sha256（不存令牌本身） |

- **唯一约束**：`dedupe_key` 在状态为 `pending`、`sending`、`sent`、`confirmed`、`dry_run`、`unknown` 的行里唯一；`failed`、`rejected` 的行不参与（部分唯一索引）。所以被拒或失败的写入可以在条件满足后重新插入，其余状态下同一件事最多一行（C-10）。
- `dry_run` 的行参与唯一约束：同一件写入在 `dry_run` 期间已经预演过，切到 `on` 以后不补发；新的 head、新一轮追问才会真正发出。

### 状态机

```text
（插入）→ pending ─┬─→ rejected                        终态
                   ├─→ dry_run                         终态
                   └─→ sending ─┬─→ sent ─→ confirmed  终态
                                ├─→ failed             终态
                                ├─→ pending（临时错误，重试）
                                └─→ unknown            重试用完；不再自动发送

unknown ─（owner 或 operator 点「重新核对」）─┬─→ confirmed（找到了）
                                            └─→ failed（确认没有）
```

| 状态 | 含义 | 从哪来、到哪去 |
|---|---|---|
| `pending` | 意图已通过 C-10 插入，还没发送 | 前置核对不通过 → `rejected`；实际写入模式是 `dry_run` → `dry_run`；核对通过且令牌桶有余额 → `sending`（改状态与发请求前的记录在同一个事务里） |
| `sending` | 请求正在发出，或进程在这一步崩溃 | GitHub 返回成功 → `sent`；GitHub 明确拒绝 → `failed`；临时错误 → 先核对（见下），没找到就回到 `pending` 并把重试次数加一，重试用完 → `unknown` |
| `sent` | GitHub 返回成功，已记下返回的对象 id | 对象 id 和标记写进 `bot_writes` 后 → `confirmed`；推送类另外要 `ls-remote` 核对远端分支 sha 与 `refs/tags/*` |
| `confirmed` | 写入已确认存在；之后轮询不把它当作人的变动 | 终态 |
| `failed` | GitHub 明确拒绝：权限不足的 403、404、409、422 等限额以外的 4xx。不自动重试，后台显示原因 | 终态；同一 `dedupe_key` 可以重新插入 |
| `rejected` | 白名单或前置核对拒绝，记下 D 编号 | 终态；同一 `dedupe_key` 可以重新插入 |
| `dry_run` | 写入模式是 `dry_run`，只保存渲染好的请求，后台标「未发布」 | 终态 |
| `unknown` | 临时错误重试用完，仍不能确定写入是否已经发生 | 不再自动发送，后台列出，仍参与唯一约束。owner 或 operator 点「重新核对」：找到 → `confirmed`；确认没有 → `failed`（原因「核对未找到」），之后可以重新插入 |

- **临时错误**：超时、连接中断、5xx，以及进程在 `sending` 时崩溃。结果不确定，所以每次重试前先按隐藏标记到 GitHub 核对：评论和 review 在该条目的列表里找带同一标记、作者是机器人账号的；标签看条目当前的标签；关闭看 issue 状态和时间线；推送看远端分支的 sha；开 PR 按 head 分支查开着的 PR；新开 issue 按作者和创建时间在本仓库里找带同一标记的。找到就走 `sent → confirmed`；确认没有，才回到 `pending`，重新跑 C-01–C-08 后再发。重试上限是 #9 的实现常量（默认 3 次），改大按 CODE-REVIEW 第 11 项审查。
- **二级限额**（403 或 429，见「限速与熔断」）确定没有被 GitHub 处理，按限速规则等待后回到 `pending`，不计入重试次数，也不进 `failed`。
- **重启时**，所有 `sending` 的行按临时错误处理；所有 `sent` 的行补写 `bot_writes` 后进 `confirmed`。#9 的崩溃注入测试在「已发出、未确认」时杀掉进程，重启后不能出现第二条评论（#9 验收条件 2）。
- **隐藏标记**是 `<!-- geek-bot v1 env=<环境> kind=<写入类型> task=<任务 id> sha=<head 前 12 位> round=<轮次> -->`，单独占正文最后一行；第一行留给追踪记录头（[ADR-0005](../../decisions/0005-rules-from-base-branch.md)）。标记里的 `task=` 只用于排查，核对与去重按 `kind`、`sha`、`round` 和目标，不按任务 id。库丢失时按标记从 GitHub 重建追问轮次、已审的 head、机器人分支和关闭状态（[数据模型](data-model.md)）。重建和核对只认机器人账号本人（按数字 id）发的、`env` 与本实例一致的标记；别的账号评论里出现同样的文本不算，因为 HTML 注释谁都能写。

## 限速与熔断

- **令牌桶**：每分钟 `GEEK_BOT_WRITE_RATE_PER_MINUTE`（默认 60 次）、每小时 `GEEK_BOT_WRITE_RATE_PER_HOUR`（默认 400 次）（B-63）。配置值不能超过 GitHub 的二级限额：一般情况下，写内容的请求每分钟不超过 80 次、每小时不超过 500 次。两次写请求之间至少间隔 1 秒（GitHub 对大量 `POST`、`PATCH`、`PUT`、`DELETE` 的建议）。同一仓库的写入串行；同一个 PR 的两次 review 至少间隔 `GEEK_BOT_REVIEW_MIN_INTERVAL_SECONDS`（默认 300 秒）。被拒绝的意图不消耗令牌。来源见文末。
- **撞上二级限额**（403 或 429，并且带 `retry-after`、或 `x-ratelimit-remaining` 为 0、或响应说明是二级限额）：有 `retry-after` 就等这么多秒；`x-ratelimit-remaining` 为 0 就等到 `x-ratelimit-reset`；两者都没有时至少等 1 分钟。仍然被限就按指数增长的间隔再等。等待期间整个出口暂停，不只暂停一个仓库。连续命中 `GEEK_BOT_WRITE_PAUSE_AFTER_SECONDARY_LIMITS` 次（默认 3 次）后进入「暂停全部写入」（B-55）。
- **权限不足的 403**（没有上面三种限额特征）不是限额：这条意图记 `failed`，不计入熔断次数；同时触发一次仓库权限刷新，权限确实降了就按新权限置灰开关。
- **401**：机器人令牌失效，立即进入「暂停全部写入」，令牌状态记为失效，后台告警；每日校验发现 `X-OAuth-Scopes` 与绑定时不同时同样处理（S-11）。
- **暂停与恢复**：owner 和 operator 都可以手动暂停写入；恢复只归 owner，并要求 10 分钟内重新认证过（[SECURITY](../../architecture/SECURITY.md) S-09 第 9 项，人工暂停和熔断暂停都算）。401 或 scope 变化引起的暂停，要 owner 重新绑定机器人后才能恢复（S-09 第 1 项）。暂停期间新的意图留在 `pending`，不发送；恢复后逐条重新跑前置核对，条件已经变了的按 D-60 记 `rejected`。

## 验证

- #9 的允许与拒绝矩阵覆盖本文每一个编号：W-01…W-14 各至少一个允许用例，D-01…D-64 各至少一个拒绝用例，其中越权样例不少于 30 个（#9 验收条件 1）。用例对注入的假 GitHub 断言：拒绝时没有发出任何网络请求，审计里有对应的 D 编号。
- 崩溃注入、中和、沙盒仓库真实 COMMENT review（`reviewDecision` 仍为 null）、preview 配置下写清单外仓库被拒，分别对应 #9 验收条件 2–5。
- 推送与开 PR 的拒绝路径（推 tag、推默认分支和 base 分支、非快进、合并、从 fork 开 PR、推别人的分支，以及工作克隆设了 `push.followTags=true` 时远端不出现新 tag）另在 #18 的单测里覆盖，并在沙盒仓库核对推送前后默认分支、长期分支和 `refs/tags/*` 都不变。
- D-61 由 `check-boundaries` 的规则强制（#9 加入，见 [MODULAR-DEVELOPMENT](../../conventions/MODULAR-DEVELOPMENT.md)）；规则加入前由审查按 CODE-REVIEW 第 11 项的命令核对。
- 上线后，production 连续 7 天查 publisher 的拒绝日志并抽查，没有越权写入、二级限额零触发（#20）。

## 来源

GitHub 官方文档，2026-09-26 核对：

- [REST API endpoints for pull request reviews](https://docs.github.com/en/rest/pulls/reviews)：创建 review 的 `event` 取值为 `APPROVE`、`REQUEST_CHANGES`、`COMMENT`，留空时 review 处于 PENDING；`comments[]` 的字段；提交、改写、删除、驳回 review 的端点。
- [REST API endpoints for pull requests](https://docs.github.com/en/rest/pulls/pulls)：创建 PR 的 `head`、`head_repo`、`base`、`draft`、`issue`（把现有 issue 转成 PR）参数；更新、合并、更新分支的端点。
- [REST API endpoints for issues](https://docs.github.com/en/rest/issues/issues)：更新 issue 的 `state`、`state_reason`（`completed`、`not_planned`、`duplicate`、`reopened`）、`duplicate_issue_id`；这些端点对 PR 同样生效；锁定端点；REST 没有转移 issue 的端点。
- [REST API endpoints for labels](https://docs.github.com/en/rest/issues/labels)：加、替换、全部删除、删除单个标签；建、改、删仓库标签；替换时传空数组会清空全部标签。
- [Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)：写内容的请求一般每分钟不超过 80 次、每小时不超过 500 次；超限时返回 403 或 429，按 `retry-after` 或 `x-ratelimit-reset` 等待。
- [Best practices for using the REST API](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)：没有 `retry-after` 且 `x-ratelimit-remaining` 不为 0 时至少等 1 分钟，仍被限就指数退避；大量写请求之间至少间隔 1 秒。
- [REST API endpoints for OAuth authorizations](https://docs.github.com/en/rest/apps/oauth-applications)：删除 grant 会删除该用户在这个 App 下的全部令牌；删除单个令牌只吊销那一枚。
- [Authenticating to the REST API](https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api)：`/applications/{client_id}/token` 这类端点要用 Basic 认证，用户名是 App 的 client ID，密码是 client secret。
- [REST API endpoints for repository invitations](https://docs.github.com/en/rest/collaborators/invitations)：接受、拒绝邀请的端点。
- [REST API endpoints for branches](https://docs.github.com/en/rest/branches/branches)：合并分支、同步 fork、改名分支的端点。
- [REST API endpoints for issue dependencies](https://docs.github.com/en/rest/issues/issue-dependencies)：添加、移除 blocked_by 依赖的端点。
- [REST API endpoints for repositories](https://docs.github.com/en/rest/repos/repos)：为用户、组织建仓库，从模板建仓库，转移仓库，替换 topics 的端点。
- [REST API endpoints for workflow runs](https://docs.github.com/en/rest/actions/workflow-runs)：重跑、批准、取消、删除运行和审批待部署环境的端点。
- [GraphQL mutations](https://docs.github.com/en/graphql/reference/mutations)：`enablePullRequestAutoMerge`、`transferIssue` 等 mutation。

git 官方文档，2026-09-26 核对：

- [git-push](https://git-scm.com/docs/git-push)：`git push` 没有 `--no-tags` 选项；`--no-follow-tags` 覆盖 `push.followTags`；`--force-with-lease=<refname>:<expect>` 的期望值为空时，要求这个 ref 还不存在；`--porcelain` 逐个 ref 输出机器可读的结果。
