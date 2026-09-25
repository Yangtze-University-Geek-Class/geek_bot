# CI 与仓库平台设置

> 三条工作流（ci / issue-lifecycle / branch-hygiene）只做机器验证、PR 正文核对和合并后的清理，不部署；发布镜像的 `release.yml` 随 #7 加入。平台能力按 2026-09-25 的只读核对记录。

状态：`current` · 更新：2026-09-26 · 适用：改 `.github/workflows/`、改 GitHub 仓库设置或标签之前

发布规则以 [RELEASES](../conventions/RELEASES.md) 为准，分支模型以 [BRANCHING](../conventions/BRANCHING.md) 为准，PR 正文契约以 [PULL-REQUESTS](../conventions/PULL-REQUESTS.md) 为准，追踪记录以 [TRACKING](../conventions/TRACKING.md) 为准。

## 触发与职责

| 工作流 | 触发 | 行为 |
|---|---|---|
| `ci.yml` | PR → `main`/`stage`；push `main`/`stage`（不含 tag）；`workflow_dispatch` | `branch-guard`（`node scripts/check-branch-invariants.mjs --require-remote-refs`；来源是 `task/**` 的 PR 另跑「执行记录（notes/）」：`node scripts/note.mjs check --pr --base origin/<目标分支> --head <task 分支>`，分支名经环境变量传入；每次运行都跑「执行记录一览（运行摘要）」：`node scripts/note.mjs index --summary` 追加到 Actions 的运行摘要。这个 job 不装依赖，两个脚本只用 Node 标准库）∥ `core`（Node 读 `.nvmrc`，pnpm 读 `packageManager`：`pnpm install --frozen-lockfile` → `pnpm check` → `pnpm test` → `pnpm build`）∥ `lint-workflows`（actionlint 1.7.12，下载后按内联 SHA-256 校验）→ `verify` 汇总 |
| `issue-lifecycle.yml` | 指向 `stage` 或 `main` 的 PR 的 opened / edited / synchronize / reopened / ready_for_review / closed；每周一 03:37 UTC；`workflow_dispatch` | `pr-base`：PR 的目标分支只能是 `stage`，指向别的分支就失败；它随 edited 触发，改了 base 会重新判定（`ci.yml` 不监听 edited，所以不放在那里）；`pr-contract`（只处理指向 `stage` 的 PR）：从目标分支（`base.ref`）只检出 `scripts/pr-contract.mjs` 与 `scripts/lib/`，核对 PR 正文（`Closes #<issue>` 与 task 分支号一致、issue 存在且开着、九个必需段落、验收证据、审查结论），不检出也不执行 PR 的代码；`close-on-merge`（只处理合进 `stage` 的 PR）：合并进 `stage` 后关闭 issue，并在 issue 与 PR 上各留一条 `<!-- track v1 kind=closed stage=merged -->` 记录；`weekly-sweep`：列出「PR 已合并但 issue 还开着」「issue 开着但没有 task 分支也没有 open PR」，只告警 |
| `branch-hygiene.yml` | PR `closed`（合并时才删）；每周一 03:17 UTC；`workflow_dispatch` | 合并后删除本仓库里 head 为 `task/**` 的分支（只有这个 job 有 `contents: write`，**永不**自动删 `dev/**` 或长期分支）；每周巡检远端 `task/**`，对「14 天无提交活动且没有 open PR」的分支只告警、不删除 |

- **push `stage` 或 `main` 不部署任何实例**，只跑 `ci.yml`。
- `ci.yml` 不对 `task/**`、`dev/**` 的 push 触发：task 分支的每次推送已由它的 PR 事件覆盖，再按 push 触发会让同一个提交跑两遍。`dev/**` 需要机器验证时，本地跑 `pnpm verify`，或在该分支上手工运行 `ci.yml`（前提是 `ci.yml` 已经进入默认分支 `main`，见下一条）。
- `schedule` 和 `workflow_dispatch` 只在工作流进入默认分支 `main` 后生效：GitHub 只在工作流文件存在于默认分支时才按这两种事件运行（官方依据见文末）。第一次把 `main` 快进到 `stage` 上被验收的提交（第一个正式版）之前，两个每周巡检都不会运行，也没有手工运行的入口；这段时间 `dev/**` 只能在本地跑 `pnpm verify`，残留分支和未关 issue 由维护者手工核对，没有告警不代表没有残留。`pull_request` 触发的 `pr-contract`、`close-on-merge` 和合并后删分支不受影响。
- issue 表单（`.github/ISSUE_TEMPLATE/*.yml`）、`ISSUE_TEMPLATE/config.yml` 和 PR 模板（`.github/pull_request_template.md`）同样只在进入默认分支 `main` 后生效（官方依据见文末）。第一次 `stage` → `main` 之前，新建 issue 或 PR 时看不到表单和模板，照 [ISSUES](../conventions/ISSUES.md) 与 [PULL-REQUESTS](../conventions/PULL-REQUESTS.md) 手写各段。
- `ci.yml` 顶层权限只有 `contents: read`，不挂任何 secrets，不产出可部署产物。所有 action 按完整提交 SHA 固定。
- `verify` 汇总 `branch-guard`、`core`、`lint-workflows`，任一失败、取消或跳过都算失败；不得用 `continue-on-error` 掩盖失败。免费计划的私有仓库配不了分支保护，`verify` 现在还不能设成 required check，合并前由审查者核对 CI 全绿。
- `ci.yml` 暂时没有 `docker`（镜像构建验证，随 #3 与 #7 加入）和 `env-contract`（`pnpm check:environments`，随 #7 加入）两个 job；加入时要同步写进 `verify` 的 `needs` 和汇总条件。
- 防篡改的边界：`pr-contract` 的脚本从目标分支检出，只改脚本的 PR 影响不到本次检查；但 `pull_request` 事件运行的是 PR 合并提交里的工作流文件，改工作流的 PR 能连步骤一起改掉。所以 `.github/workflows/` 的改动必须在审查里单独核对。
- 关闭 #1 的那个 PR 合并前，`stage` 上还没有这个脚本，`pr-contract` 会打出提示后跳过；之后的 PR 都会执行。
- `close-on-merge` 的记录由 `github-actions[bot]` 发出。
- 仓库名不写死：工作流一律用 `${{ github.repository }}`（`GITHUB_REPOSITORY`），本地脚本用 `gh` 在仓库目录里自动解析。

## 计划中：`release.yml`（#7）

- 由发布 tag 触发：`vX.Y.Z-rc.N` 构建一次镜像并推到 ghcr，生成带 digest 的清单；`vX.Y.Z` 给同一 digest 加别名，不重新构建。只用 `GITHUB_TOKEN`（`packages: write`）。
- 不部署。部署由维护者在所有者授权后到目标机运行部署脚本（#7），按 digest 拉取；AI 不得自行部署（[AGENTS](../../AGENTS.md) §3）。
- 在它加入之前，推送发布 tag 不会触发任何工作流。
- tag 推送运行的是该 tag 所在提交里的 `release.yml`；手工运行 `release.yml` 同样要求它已经进入默认分支 `main`（见「触发与职责」），第一个正式版之前没有这个入口。发布 tag 不可移动、不可删除，所以 #7 要写明这段时间 rc 构建没有触发或失败时怎么处理。

## 标签

- `.github/labels.yml` 声明 issue 模板、[ISSUES](../conventions/ISSUES.md) 和机器人默认规则用到的标签。
- `pnpm labels:plan`（`node scripts/labels.mjs`）只打印 `gh label create … --force` 命令，不执行；由所有者确认后执行。issue 模板引用的标签要事先存在。

## 平台能力（2026-09-25 用 `gh api` 只读核对）

| 项目 | 实测结果 | 影响 |
|---|---|---|
| 所在组织的计划 | `plan.name` 为 `free`；仓库 `private`，默认分支 `main` | 下面几项限制都来自这一条 |
| 分支保护 | `GET /repos/{owner}/{repo}/branches/main/protection` 返回 `403`（`Upgrade to GitHub Pro or make this repository public…`） | 没有 required check、没有必需审查、没有 tag 保护 |
| rulesets | `GET /repos/{owner}/{repo}/rulesets` 返回同样的 `403` | 同上 |
| Environments | `GET /repos/{owner}/{repo}/environments` 的 `total_count` 为 `0` | 没有环境级 secrets 和部署审批 |
| Actions | `enabled=true`、`allowed_actions=all`、`sha_pinning_required=false` | 见下面的建议 |
| 工作流令牌 | `default_workflow_permissions=read`、`can_approve_pull_request_reviews=false` | 保持不动 |
| 合并设置 | `allow_auto_merge=false`、`delete_branch_on_merge=false`；squash、merge commit、rebase 都开着 | 删 task 分支只由 `branch-hygiene` 负责 |
| 私有仓库的 fork PR | `run_workflows_from_fork_pull_requests=false`、`send_write_tokens_to_workflows=false`、`send_secrets_and_variables=false` | fork 来的 PR 不运行工作流；保持不动 |

由此得出的做法：

- 分支不变量由两道机器检查核对：本地 pre-push 钩子（每个克隆运行一次 `pnpm hooks:enable`）和 CI 的 `branch-guard`；合并前再由审查者和 `issue-lifecycle` 的 `pr-base`（PR 只能指向 `stage`）、`pr-contract`（进 `stage` 的 PR 只能来自对应 issue 的 task 分支）把关。没有平台级的分支保护兜底。以后产品自己的 GitHub 写入另由 publisher 的写入白名单约束。
- 官方文档写明免费计划只能给公开仓库配置 Environments。工作流里不写 `environment:`（引用不存在的环境会自动创建一个没有保护规则的环境），也不设计环境级 secrets 和正式环境审批；部署授权靠流程加上目标机上的人工执行。
- 建议所有者在仓库设置里把 `allowed_actions` 改为 `selected`（GitHub 官方 action 加上 `pnpm/action-setup`），并打开 `sha_pinning_required`；现有工作流已经全部按 SHA 固定。这两项是仓库设置，AI 不改。
- `delete_branch_on_merge` 保持关闭。如果以后改成打开，就去掉 `branch-hygiene` 的删除 job，两套机制只留一套。
- CI 不需要任何 secrets 或 variables。不要创建 `DEPLOY_SSH_*` 这类部署 secrets：GitHub 托管的 runner 连不到只在内网的目标机。
- 不要为了解锁这些功能把仓库公开；何时公开由 [ADR-0001](../decisions/0001-standalone-product.md) 的公开前条件决定。

以上是 2026-09-25 的核对结果；改仓库设置或依赖这些能力之前重新核对。

### Actions 分钟数与存储

- 免费计划的组织，私有仓库每月含 2000 分钟 Actions 和 500 MB artifact 存储；公开仓库使用标准 GitHub 托管 runner 免费（官方计费文档，2026-09-25 查阅）。
- 每个 job 用掉的分钟数向上取整到整分钟（官方 runner 计价文档，2026-09-25 查阅），几秒钟的 job 也按 1 分钟计。
- 所以 CI 不重复触发，不上传镜像 tar 这类大 artifact。

## 明确不做的事

- 任何工作流都不自动创建、移动或删除 tag，不自动改 `package.json` 版本号，不写放行状态；发布 tag 由维护者在所有者授权后手工创建。
- 不从 `pull_request_target` 触发，不给 PR 构建挂任何 secrets；自托管 runner 不得接在有生产凭据或真实数据的机器上执行不可信 PR。
- 不把 `.tools`、真实数据库、`.env`、密钥文件、内部文档或浏览器状态打进镜像、缓存或日志。
- 机器 PASS（`pnpm verify`、CI 全绿）不构成人工验收记录，也不授权任何部署或发版动作。
- 不把 `stage` 分支的推送当作任何实例的部署。

## 本地复现

- `core`：在 worktree 里运行 `pnpm install --frozen-lockfile && pnpm verify`（见 [LOCAL-DEV](LOCAL-DEV.md)）。
- `branch-guard`：`node scripts/check-branch-invariants.mjs --require-remote-refs`，需要本地已有 `origin/main` 与 `origin/stage`；执行记录那一步在 task worktree 里运行 `node scripts/note.mjs check --pr --base origin/stage --head <task 分支>`，一览表用 `node scripts/note.mjs index --summary`。
- `pr-base`：只看 PR 的 base，本地没有对应命令；开 PR 时确认目标是 `stage` 即可。
- `lint-workflows`：本机装 actionlint 1.7.12 后，在仓库根目录运行 `actionlint .github/workflows/*.yml`。

## 官方依据

核对日期：2026-09-25。只说明平台行为，不代表远程设置已经完成。

- https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax — 事件与 ref 过滤、权限、并发。
- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows — `schedule` 与 `workflow_dispatch` 都写明「This event will only trigger a workflow run if the workflow file exists on the default branch.」
- https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/about-issue-and-pull-request-templates — 「Issue templates are stored on the repository's default branch」「You must create templates on the repository's default branch.」；`config.yml` 在合并进默认分支后才改变模板选择页（同目录下的 configuring-issue-templates-for-your-repository）。
- https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments — 免费计划只能给公开仓库配置 Environments；引用不存在的环境会自动创建。
- https://docs.github.com/en/billing/concepts/product-billing/github-actions — Actions 分钟数与 artifact 存储额度。
- https://docs.github.com/en/billing/reference/actions-runner-pricing — 每个 job 的分钟数向上取整到整分钟。
- https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets — rulesets 与分支保护。
