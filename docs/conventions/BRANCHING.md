# 分支模型规范

> 只有 `main`（正式）与 `stage`（预发布）两条长期分支；task 分支合并后必须立即删除，任何操作前先确认当前分支。

状态：`current` · 更新：2026-09-26 · 适用：本仓库的所有分支、推送与合并。依据：所有者 2026-09-25 的指令（#22）。

## 第负一步：先确认分支

**任何提交、推送、切分支、改文件之前，先跑 `git branch --show-current` 确认自己在哪条分支上。** Agent 进入仓库的第一件事就是确认分支并阅读规范（见 [AGENT-START](AGENT-START.md)）。不在预期分支上时停止操作并说明，不能靠 `git checkout .`、`reset --hard` 或清理工作区来自行纠正。

## 长期分支

| 分支 | 角色 | 生命周期 | 在这条分支的提交上打的发布 tag |
|---|---|---|---|
| `main` | 正式稳定版，只能由 `stage` 合入（发版时快进到被验收的 rc 提交） | 长期 | `vX.Y.Z` → 正式实例（production 栈） |
| `stage` | 动态更新版，集成分支 | 长期 | `vX.Y.Z-rc.N` → 预发布实例（preview 栈） |

**推送分支不部署。** 推送 `stage` / `main` 只跑 CI；部署只由发布 tag 启动，规则见 [RELEASES](RELEASES.md)：tag 触发 `release.yml` 只构建一次镜像并推到 ghcr，正式 tag 给同一 digest 加别名；维护者获授权后在目标机运行部署脚本拉取。`release.yml` 与部署脚本计划中，见 #7。

除这两条以外，**不允许存在第三条长期分支**。不得把 `next`、`develop`、`release` 等当作集成分支；`documentation`、`feature` 等命名同样无效。

## 短生命周期分支

| 分支 | 来源与去向 | 规则 |
|---|---|---|
| `task/<issue>/<slug>` | 从 `stage` 拉出 → PR 回 `stage`，正文写 `Closes #<issue>` | **极短**：PR 合并后必须立即删除，禁止残留死分支。`branch-hygiene.yml` 会在 PR 合并后自动删除，也可以手工 `git push origin --delete` |
| `dev/<github-username>` | 个人自由开发区，内容随意 | 个人自行维护；**不得作为任何提交进入 `stage` 的凭据**，也不部署 |

- 一次任务一条 task 分支；一个 task 分支只对应一个 issue，并且**在自己的 git worktree 里开发**（见下文「task worktree」）。合并方式默认 squash 或普通 merge，由维护者决定，但分支本身必须在合并后删除。
- `dev/<github-username>` 是个人实验区：可以自由提交，可以 force-push 自己的分支；但把内容送上 `stage` 的唯一合法路径是「从 `stage` 拉一条干净的 `task/<issue>/<slug>`，重新提交或 cherry-pick 经过审查的改动」。`dev/**` 的提交历史、分支名和 CI 绿标都不是审查凭据。
- 禁止把 `dev/**`、`task/**` 直接合并进 `main`。
- 机器人账号开的修复 PR 同样用 `task/<issue>/<slug>`，同样从 `stage` 拉出、PR 回 `stage`，见 [PULL-REQUESTS](PULL-REQUESTS.md)「机器人开的 PR」。

## 命名规则：只用 `/` 分层，不用 `-`

**分支名里一律不出现 `-`。** 层级像文件夹一样用 `/` 分隔，每一段只含小写字母与数字；一段里有多个词时用 `_` 连接。规范来源是 `scripts/check-branch-invariants.mjs` 的 `TASK_BRANCH_RE` / `DEV_BRANCH_RE`，其它文档只引用这里：

| 类型 | 形状 | 正则（与脚本逐字一致） | 例子 |
|---|---|---|---|
| 任务分支 | `task/<issue>/<slug>` | `^task\/[0-9]+\/[a-z0-9]+(?:_[a-z0-9]+)*$` | `task/12/review_queue`、`task/9/publisher` |
| 个人分支 | `dev/<github-username>` | `^dev\/[a-z0-9]+(?:_[a-z0-9]+)*$` | `dev/alice` |

- `<issue>` 是纯数字的 issue 编号；`<slug>` 与用户名段都是 `[a-z0-9]+(?:_[a-z0-9]+)*`：不允许大写、`-`、首尾 `_` 或连续 `__`，也不允许再多一层 `/`。
- GitHub 用户名里带 `-` 的，个人分支里写成 `_`（例：`joe-smith` 写成 `dev/joe_smith`）；大写一律转小写。
- `task/<issue>-<slug>`、`dev-<username>`、`task-…` 这类带 `-` 的写法**不合规**：`check-branch-invariants.mjs` 把它们归为 `task-malformed` / `personal-malformed` 并告警，pre-push 拒绝以它们为来源推 `stage`。`ci.yml` 的触发范围见 [CICD](../ops/CICD.md)。
- Git 不允许 `dev` 与 `dev/…` 同时存在；不要建名为 `dev` 或 `task` 的分支。
- `scripts/task.mjs` 与 `scripts/pr-contract.mjs` 各有一份 `TASK_BRANCH_RE`，是上表任务分支正则加一个取 issue 号的捕获组的等价副本：`pr-contract` 在 CI 里只稀疏检出自己和 `scripts/lib/`，不能导入其它脚本。改任务分支正则时三份一起改；`issue-lifecycle.yml` 合并后关闭 issue 的步骤用 `sed` 按 `task/<数字>/` 取 issue 号，改分支形状时它也要跟着改。`tests/tooling/branch-regex-parity.test.ts` 核对三份正则去掉捕获组后逐字一致，并核对那条 `sed` 还在按 `task/<数字>/` 取号。

## 不变量

以下两条必须同时成立，由脚本、CI 与本地 hook 强制：

1. **`stage` 必须包含 `main`**：`git merge-base --is-ancestor origin/main origin/stage` 为真，即 stage ≥ main。
2. **`main` 不得领先 `stage`**：任何写入 `main` 的提交都必须已经存在于 `stage`；只允许把 `stage` 合入 `main`。

本地自查：

```bash
node scripts/check-branch-invariants.mjs                     # 只读：核对两条不变量 + 分支命名卫生
node scripts/check-branch-invariants.mjs --json              # 机器可读输出
node scripts/check-branch-invariants.mjs --strict-long-lived # 把「main/stage 之外的长期分支」升级为失败
node scripts/check-branch-invariants.mjs --require-remote-refs # 只用 origin 远端跟踪分支作证据，不回落到本地分支（CI 用这个）
```

根脚本 `pnpm check:branch-invariants` 运行同一个检查。`pnpm hooks:enable` 把 `.githooks/` 设为本仓库的 hook 目录，之后每次推送都会经过 `.githooks/pre-push`。

`--push` 模式读 git 的 pre-push 四段输入，额外断言：

- 推 `main` 的提交必须已在 `stage`；
- 推 `stage` 只能来自 `stage` 自身或合规的 `task/<issue>/<slug>`，并且必须已包含 `origin/main`；
- 不得删除远端 `main` / `stage`。

首次推送新分支（远端 SHA 全 0）同样照常判定命名与不变量。同一模式还核对发布 tag：格式不对的 `v` 开头 tag、提交不在 `stage` 上的 `vX.Y.Z-rc.N`、提交不在 `main` 上的 `vX.Y.Z`、版本号与该提交 `package.json` 不一致、删除或强制移动发布 tag，都会被拒绝；正式 tag 的同一提交本地没有 rc tag 只告警（以 `release.yml` 对同一提交已有 rc 镜像的核对为准，计划中，见 #7）；其它 tag 只告警。规则详见 [RELEASES](RELEASES.md)。

脚本只读 Git 证据：不 fetch、不改 refs、不删分支、不建提交或 tag、不连远端。

违反任一条即视为分支模型被破坏，必须先修复再继续开发；不要用 force-push 掩盖差异。

## 禁止事项

- 禁止直接向 `main` 提交或推送（包括 agent、脚本、GitHub 网页编辑、CI 与机器人账号）。
- 禁止 `task/**`、`dev/**` 分支直接进 `main`；禁止把 `stage` 之外的来源合入 `main`。
- 禁止在新分支名里使用 `-`（见上文「命名规则」）。
- 禁止在没有 issue 的情况下开 task 分支：开发前先在仓库开 issue，见 [ISSUES](ISSUES.md)。
- 禁止向 `stage` 提交未审查的内容：进入 `stage` 前必须走 [CODE-REVIEW](CODE-REVIEW.md)，PR 描述里带审查结论。
- 禁止长期保留已合并的 task 分支；禁止用分支名当版本号或发布凭据，发布凭据只有所有者授权后打的发布 tag。
- 禁止 force-push `main` / `stage`，禁止整分支 reset 覆盖他人提交。

## task worktree：一个 issue 一个工作目录

**一个 issue = 一个 `task/<issue>/<slug>` 分支 = 一个 git worktree = 一个 PR，四者生命周期相同，都跟着 issue 走**（[TRACKING](TRACKING.md) §1）：

- **开工**：`node scripts/task.mjs start <issue> <slug>`。它先确认 issue 开着，再从最新 `origin/stage` 建分支，同时在主工作区的 `.claude/worktrees/task-<issue>` 建一个独立 worktree，在 issue 上留一条开工记录，并在 worktree 的 `notes/` 里写执行链路的第一条「开工」（要带身份，见 [NOTES](NOTES.md)）。之后这件事的所有编辑、安装、构建、测试、提交都在这个 worktree 里做，每一步都记进 `notes/`。
- **不碰主工作区**：主工作区（以及别的 task 的 worktree）上可能有别人的未提交改动或正在运行的本机实例；在自己的 worktree 里做，互不影响，也不用切分支、stash。
- **一个 issue 只有一个 worktree**：`start` 发现已有同号 worktree 会拒绝，直接进去继续做。不要在同一个 worktree 里做第二件事。
- **结束**：PR 合并进 `stage` 后，`branch-hygiene` 删远端分支，`issue-lifecycle` 关 issue；本机运行 `node scripts/task.mjs finish <issue>` 删 worktree 与本地分支，并暂存链路的最后一条「收尾」（在主工作区运行，不要在要删的 worktree 里运行）。`node scripts/task.mjs list` 列出每个 worktree 的 issue / PR 状态；`node scripts/task.mjs prune` 一次清掉所有可清理的。
- **什么时候不删**：worktree 有未提交改动、PR 还开着、或 issue 还开着且 PR 没合并时，脚本只报告原因，不删除；放弃的 issue 先按 TRACKING 留「关闭」记录再关，之后就能清理。
- **核对结果，不只看退出码**：`task.mjs` 按真实路径判断自己是否被直接运行（`scripts/lib/cli.mjs` 的 `isDirectRun`），经符号链接路径（例如 macOS 上经 `/tmp` 进入的目录）启动也会正常执行，参数不对时打印用法并以非 0 退出，不会静默成功。开工后仍用 `git worktree list` 核对 worktree 确实建好。
- `.claude/worktrees/` 已被 `.gitignore` 忽略；每个 worktree 需要自己运行 `pnpm install --frozen-lockfile`（pnpm 的全局仓库会复用已下载的包）。

## 日常流程

```bash
git branch --show-current                      # 1. 确认当前在哪
# 2. 按 ISSUES.md 开 issue，记下编号
node scripts/task.mjs start <issue> <slug>     # 3. 从最新 origin/stage 建 task/<issue>/<slug> 与 .claude/worktrees/task-<issue>，notes/ 里写「开工」（先设 GEEK_NOTES_USER / GEEK_NOTES_BY）
cd .claude/worktrees/task-<issue> && pnpm install --frozen-lockfile
# 4. 在 worktree 里开发、验证、提交（见 CONTRIBUTING.md），每个阶段在 issue 上留追踪记录（TRACKING.md §3），每一步记进 notes/（NOTES.md）
# 5. 开 PR → stage，正文按 PULL-REQUESTS.md 的契约写（Closes #<issue>、解决链路、验收证据、人工验收步骤）
# 6. 合并后：远端分支与 issue 由 branch-hygiene / issue-lifecycle 自动处理；
cd <主工作区> && node scripts/task.mjs finish <issue>   #    本机删 worktree 与本地分支
```

发布相关（打 rc tag、验收、把 `main` 快进到被验收的提交、打正式 tag、回滚）见 [RELEASES](RELEASES.md)；CI 与发布工作流见 [CICD](../ops/CICD.md)。发布 tag 语法的唯一实现是 `scripts/release-tags.mjs`（`check-branch-invariants.mjs --push` 调用它）；发布 tag 与部署目标的绑定（`deploy/environments.json`、`release.yml`）计划中，见 #7。
