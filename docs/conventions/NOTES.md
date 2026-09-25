# 执行记录规范（notes/）

> 每个人、每个 agent 做的每一步，都按北京时间写进仓库里的 `notes/<日期>/<GitHub 用户名>/<链路>.md`；开发前先记开工，开发后记到收尾，链路不完整的 PR 不能合并。

状态：`current` · 更新：2026-09-26 · 适用：所有在本仓库开发的人和 agent（含委派出去的子代理），所有 `task/<issue>/<slug>` 分支。

## §1 为什么要有

issue 和 PR 的评论（[TRACKING](TRACKING.md)）记的是「这件事走到哪一步了」，给所有人看。`notes/` 记的是「谁的 agent 在什么时候做了什么、结果如何」，一条链路从开工一直记到收尾，随代码一起入库。出了问题时能按日期和人找到当时的每一步：改了什么、跑了什么命令、看到什么输出、谁做的决定。两者都要写，不能互相代替。

## §2 目录结构

```
notes/
├── INDEX.md                          生成物：按日期列出每天有哪些人的记录
└── 2026-09-26/                       北京时间的日期
    └── alice/                        负责人的 GitHub 用户名（小写）
        ├── task_12_review_queue.md   一条链路一个文件，文件名是分支名把 / 和 - 换成 _
        └── task_8_poll_etag.md
```

- **日期**：写这条记录时的北京日期（`Asia/Shanghai`，+08:00），由脚本读系统时钟决定，不手填。一条链路跨过零点时，后面的记录落在新日期目录下的同名文件里，合起来仍是一条链路。
- **负责人**：替谁干活就写谁的 GitHub 用户名。agent 替 alice 干活，记录放在 `alice/` 下；自己动手的人写自己。
- **链路**：一个 task 分支一条链路（`task/12/review_queue` → `task_12_review_queue.md`）。不属于任何 task 的操作（发布、验收、打 tag、排查实例上的问题）记在当时所在分支的链路里，比如 `stage`、`main`。
- **执行者**：每条记录单独写，同一条链路可以有多个执行者（主 agent、子代理、人）。

## §3 格式

一个链路文件：

```markdown
# task/12/review_queue · alice · 2026-09-26

负责人：alice

## 10:41:07 +08:00 · 开工 · #12 · 从 origin/stage 0123456789ab 建 task/12/review_queue

- 执行者：agent-claude-geek-bot-01（Claude Code，<模型>）
- 做了什么：node scripts/task.mjs start 12 review_queue：从 origin/stage 0123456789abcdef0123456789abcdef01234567 建分支与 worktree .claude/worktrees/task-12，在 issue 上留开工记录
- 结果：worktree 已建好，issue 上已留开工记录
- 下一步：写审查队列的入队逻辑

## 11:20:33 +08:00 · 提交 · #12 · 入队逻辑与回归测试一起提交

- 执行者：agent-claude-geek-bot-01（Claude Code，<模型>）
- 做了什么：fix(control): 轮询收到 304 时不再重复入队；pnpm verify
- 结果：pnpm verify 通过（Tests 212 passed）
```

- 第一行 `# <分支> · <负责人> · <日期>`，第二段 `负责人：<负责人>`，都和所在目录一致。
- 每条记录的标题 `## HH:MM:SS +08:00 · <阶段> · #<issue> · <一句话>`；涉及多个 issue 写 `#8 #12`，确实没有 issue 写 `无 issue`。
- 必填三项：`执行者`、`做了什么`、`结果`；`下一步` 可选。每项一行。
- 执行者写成 `agent-<工具>-<会话>（说明）` 或 `human-<GitHub 用户名>`，例：`agent-claude-geek-bot-01（Claude Code，<模型>）`、`agent-omp-geek-bot-02`、`human-alice`。括号里写工具和模型，模型写实际用的 id。
- 「结果」写能复查的东西：命令的真实输出摘要、提交 SHA、PR 号、CI 运行号、截图在 PR 里的位置。失败就写失败，没验证就写「未验证」。
- 只能往文件末尾追加，已写的记录不改不删；写错了再追加一条说明。时间只能往后走。
- 不写密钥、令牌、会话、真实个人信息和实例数据；也不写组织名、内部主机、内网或组网地址、网关地址（[PROJECT](PROJECT.md)「公开就绪」）。负责人的 GitHub 用户名是唯一允许出现的真实账号名，见 §7。需要时写「已本地核对，不公开」。

阶段只能用下面这些：

| 阶段 | 什么时候记 |
|---|---|
| 开工 | 开发前，链路的第一条（`task.mjs start` 自动写） |
| 方案 | 定位结论和打算怎么改；大改动必记 |
| 开发 | 阶段性的改动完成、重要的中间结果 |
| 提交 | 每次本地提交：提交说明和跑过的检查 |
| 推送 | 推 task 分支 |
| PR | 开 PR 或改 PR 正文 |
| 审查 | 收到审查结论（谁审的、审的哪个 SHA、结论） |
| 返工 | 按审查或验收意见改了什么 |
| 合并 | PR 合进 stage，合并提交 SHA |
| 发布 | 打 rc 或正式 tag、构建运行号 |
| 验收 | 在哪个环境按哪几步看到了什么 |
| 阻塞 | 卡住了：缺授权、缺凭据、等别人 |
| 收尾 | 链路的最后一条（`task.mjs finish` 自动写），之后不能再记 |

## §4 前后必须执行

- **开发前**：`node scripts/task.mjs start <issue> <slug>` 建分支和 worktree 时写下「开工」，没有开工记录不许改代码。启动时必须带身份（见 §5），缺了直接报错。
- **开发中**：每完成上表里的一步就记一条，至少包括每次提交、开 PR、收到审查结论、每轮返工。
- **合并前**：PR 的链路里必须已经有引用本 issue 的「开工」「提交」「PR」「审查」，并且这个 PR 新增了引用本 issue 的记录（§6 的 CI 检查会拦）。审查人在审查进行中先核对已有的开工、提交、PR 记录（`node scripts/note.mjs check --pr --for-review`）；审查结论给出后，作者补一条「审查」记录（`docs(notes): …`），推送到 task 分支，CI 变绿后才能合并。
- **开发后**：合并、发布、验收在 task 分支之外发生，照样要记（会先暂存，见 §5）；`node scripts/task.mjs finish <issue>` 删 worktree 前写下「收尾」。链路以收尾结束才算完整。
- 委派子代理时，把身份和链路交代给它；子代理自己记，执行者写它自己。
- 本规范生效前已经开工、还没合并的 task：下一次提交前补一条「开工」，「做了什么」写明原来的开工时间和「本规范生效前开工，补记」，之后照常记。时间就是补记的时刻，不往前改。本规范生效前开的 task 没有「开工」时，`task.mjs finish` 不写「收尾」。

## §5 怎么写

```bash
export GEEK_NOTES_USER=alice
export GEEK_NOTES_BY="agent-claude-geek-bot-01（Claude Code，<模型>）"

node scripts/task.mjs start 12 review_queue          # 写「开工」
node scripts/note.mjs add --stage 提交 --issue 12 \
  --title "入队逻辑与回归测试一起提交" \
  --did "fix(control): …；pnpm verify" --result "pnpm verify 通过（Tests 212 passed）" \
  [--next "…"] [--chain task/8/poll_etag]
node scripts/task.mjs finish 12                      # 暂存「收尾」
```

- 身份也可以用 `--user` / `--by` 传（`note.mjs add` 与 `task.mjs start`、`finish`、`prune` 都接受）；两者都没有时拒绝写入。
- **记录落在哪**：当前 worktree 就在这条链路的 task 分支上、PR 还没合并、阶段也不是合并之后的「合并」「发布」「验收」「收尾」时，直接写进这个 worktree 的 `notes/`，并重新生成 `notes/INDEX.md`，随下一次提交入库。别的情况（在主工作区或发布用的 worktree 里打 tag、给别的链路补记、PR 合并之后、`task.mjs finish` 写收尾）先暂存到主工作区的 `.claude/notes-pending/`（已在 `.gitignore`）。下一个 `task.mjs start` 会把它并进新的 task worktree，也可以在任意 task worktree 里手动 `node scripts/note.mjs flush`。并入时按时间合并；别的 task worktree 还在用的链路、在目标 worktree 里接不上「开工」的 task 链路留在暂存，不并。暂存的记录要随最近的一个 PR 入库，不能一直留在本机。
- 提交：记录和代码放在同一个提交里；开 PR、拿到审查结论后单独补的记录用 `docs(notes): <一句话>`（[COMMITS](COMMITS.md)）。
- `node scripts/note.mjs index` 重新生成 `notes/INDEX.md`；`node scripts/note.mjs index --summary` 输出全部链路的一览表（负责人、链路、issue、执行者、条数、开工时间、最后一条）。
- 每个子命令都接受 `--root <目录>`，默认是脚本所在仓库（或 worktree）的根目录；测试用它在临时目录里跑。参数不认识时打印用法并以 2 退出。

## §6 门禁

| 在哪 | 查什么 |
|---|---|
| `pnpm check`（`check:notes` → `node scripts/note.mjs check`） | 目录只能是 `<日期>/<用户名>/<链路>.md` 加 `INDEX.md`，不放符号链接；标题、负责人和目录一致；每条记录的标题、阶段和必填项；时间不倒退；每条 task 链路第一条是「开工」、收尾之后没有记录；`notes/INDEX.md` 是最新的 |
| CI `branch-guard` 的「执行记录（notes/）」（task 分支进 stage 的 PR） | 上面全部，加上：这个 task 的链路存在；有引用本 issue 的「开工」「提交」「PR」「审查」；本次 PR 新增了引用本 issue 的记录；`notes/` 下已有的记录没被改写或删除（`INDEX.md` 除外）。取不到比较基线时直接失败，不当作通过 |
| CI `branch-guard` 的「执行记录一览（运行摘要）」（每次运行） | 把全部链路的一览表贴进 Actions 的运行摘要，stage 和 main 上随时能看到所有人的链路 |

检查不过就补记录，不许改检查脚本来换绿色，也不许补写没发生过的事。脚本只能核对格式和是否记了，记的内容是否属实由审查人对照提交、PR 和 CI 核对（[CODE-REVIEW](CODE-REVIEW.md) 第 15 项）。

## §7 公开安全检查对 notes/ 的处理

`pnpm check:public-safety`（`scripts/check-public-safety.mjs`）对 `notes/` 下的文件**只免一条规则**：不做被禁 token 的比对，路径（目录名、文件名）和内容都不做。其余规则照常：私网、CGNAT、链路本地地址，组网主机名，被禁 IPv4 的哈希，在 `notes/` 里出现同样失败。

理由：记录按 §2、§3 必须写负责人的 GitHub 用户名（目录名、文件标题、负责人行），被禁词表里登记了一些真实账号名，不免掉这一条，这些人就写不了记录。免掉的只是这一条，而且只限 `notes/`：

- `notes/` 的目录结构由 `check:notes` 限定（只能是 `<日期>/<用户名>/<链路>.md` 和 `INDEX.md`），别的文件放不进来；
- 记录内容里除了负责人的用户名，仍然不写组织名、内部主机和其它真实账号（§3）。这一条没有机器检查，由作者和审查人逐句看（[CODE-REVIEW](CODE-REVIEW.md) 第 9、15 项）；
- 例外的反例测试在 `tests/tooling/public-safety.test.ts`：`notes/` 下的被禁词不报、`notes/` 之外照报；`notes/` 下的私网地址、组网主机名、被禁 IPv4 照报。

## §8 与其它规范的关系

issue、PR 评论的格式见 [TRACKING](TRACKING.md)，PR 正文见 [PULL-REQUESTS](PULL-REQUESTS.md)，task 分支和 worktree 见 [BRANCHING](BRANCHING.md)。实现在 `scripts/note.mjs`，`scripts/task.mjs` 的 start / finish 调用它；测试在 `tests/tooling/notes.test.ts`。
