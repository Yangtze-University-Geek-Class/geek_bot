# 贡献规范

> 统一入口、最小变更、可审查的提交与资源隔离。

状态：`current` · 更新：2026-09-25 · 适用：所有向本仓库提交改动的人与 AI/Agent。

## 开始前

AI 先执行 [AGENT-START](AGENT-START.md) 的阅读门禁，不能先运行下列命令再补读规范。**第一步是确认分支**：`git branch --show-current`，确认自己在 `task/<issue>/<slug>` 或 `stage` 上，不在就直接停止。

读根 [README](../../README.md) 与对应包的服务契约（[docs/services](../services/README.md)）。确认 `git status --short`、分支和 HEAD；不要覆盖已有的未提交修改。

环境与安装：

- Node 22（`engines` 要求 `>=22.13.0 <23`，版本写在 `.nvmrc` 与 `.node-version`）；pnpm 固定为 `pnpm@9.15.9`。
- 安装：`pnpm install --frozen-lockfile`。不要在没有授权时改锁文件；新增依赖见下文。
- 启用本仓库的 git hook：`pnpm hooks:enable`（把 `.githooks/` 设为 hook 目录，推送前运行分支不变量检查，见 [BRANCHING](BRANCHING.md)）。
- 本机启动命令 `pnpm dev:*` 随 #3（control）、#4（console）加入；本机运行说明见 [LOCAL-DEV](../ops/LOCAL-DEV.md)。本机开发不需要任何真实令牌或正式配置。

## 分支与改动

长期分支只有 `main`（正式）和 `stage`（预发布），完整规则（含不变量、禁止事项、清理要求）见 [BRANCHING](BRANCHING.md)：

- 开发前先按 [ISSUES](ISSUES.md) 开 issue，再用 `node scripts/task.mjs start <issue> <slug>` 从最新 `stage` 拉 `task/<issue>/<slug>`（例 `task/12/review_queue`；分支名不用 `-`），**同时得到一个独立的 worktree**，所有开发都在里面做，不在主工作区切分支（见 [BRANCHING](BRANCHING.md)「task worktree」）；
- 一次任务一条 task 分支、一个 worktree，PR 回 `stage`，正文按 [PULL-REQUESTS](PULL-REQUESTS.md) 的契约写；
- **PR 合并后远端分支与 issue 自动清理，本机用 `node scripts/task.mjs finish <issue>` 删 worktree 与本地分支**，不留死分支、死目录；`node scripts/task.mjs list` 查看状态，`node scripts/task.mjs prune` 批量清理；
- `dev/<github-username>`（例 `dev/alice`）是个人自由分支，想怎么改都行，但不得作为进入 `stage` 的凭据，也不部署；
- 禁止直接向 `main` 提交，禁止 `task/**`、`dev/**` 直接进 `main`。`main` 只接受来自 `stage` 的合并。

发版与人工验收见 [RELEASES](RELEASES.md)：发版只靠打 tag（`vX.Y.Z-rc.N` 发预发布实例，验收通过后在同一提交上打 `vX.Y.Z` 发正式实例），合并进 `stage` 或 `main` 本身不部署；打 tag 需要所有者对该版本的授权。改 `package.json` 的 `version` 走普通 task PR，普通提交不自动升号，也不把 feat/fix 消息当作发版许可。

先定包、契约与验收，再改代码；修复缺陷时添加能区分修复前后的回归测试。新增依赖要在 PR 里说明目的、许可证、运行环境、体积与维护代价；新增生产依赖还需要所有者批准。不要顺便升级无关框架，也不要为了纯目录偏好搬整个工程。

## 提交前

- 运行根 `pnpm verify`（依次是 `pnpm check`、`pnpm test`、`pnpm build`），贴真实输出。
- 影响浏览器行为时跑 `pnpm test:e2e`（随 #4 加入）。
- 需要 `/dev/kvm` 的 VM 测试 `pnpm test:vm`（随 #12 加入）是可选的，只在有 KVM 的机器上跑；没跑就在 PR 的「验证命令与结果」里逐条写「未验证」和原因，不能写成通过。
- 审阅 diff，补文档；确认没有密钥、令牌、真实数据、编译产物，也没有组织名、真实仓库名、内部主机或网段（`pnpm check:secrets`、`pnpm check:public-safety` 只覆盖部分模式，仍要人眼看一遍）。
- 改动触及文档标题、摘要或路径时，重新生成文档索引（`pnpm docs:index`），并用 `pnpm check:docs` 核对。
- 失败项和未验证项如实写进 PR，不能只截取部分成功输出。

提交遵循 [COMMITS](COMMITS.md)，审查按 [CODE-REVIEW](CODE-REVIEW.md) 逐项过一遍并把结论写进 PR，PR 字段要求见 [PULL-REQUESTS](PULL-REQUESTS.md)，issue 与 PR 上的评论按 [TRACKING](TRACKING.md) 的格式写。提交、推送、合并、部署分别需要对应授权；要求改代码不等于要求自动发布。

## 数据、账号与运维

**真实机器人账号的令牌、真实仓库上的写操作（评论、标签、分支、PR、关闭 issue）都不属于普通贡献流程。** 开发和测试一律用打桩的 GitHub API（默认拒绝网络）和虚构的样板数据；需要在真实仓库上验证时，先取得所有者对具体仓库、具体账号和具体动作的授权，并且只在沙盒仓库里做。

实例数据修改同样不属于普通贡献流程。维护脚本必须写明绝对路径和写入确认，先在经过验证的副本上演练，再由授权人员操作。部署、环境变量、节点接入、备份与恢复的运维文档（DEPLOY、ENVIRONMENTS、NODES、BACKUP 等）计划中，由 #7、#11、#20 写入；在那之前，任何实例上的操作都要先取得所有者授权。
