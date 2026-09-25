# 追踪记录规范（issue 与 PR 的评论）

> 一件事从提出到关闭，每一步都以固定格式的评论留在 issue 与 PR 上；人扫一眼能看懂进展，Agent 按字段就能读出状态。

状态：`current` · 更新：2026-09-26 · 适用：本仓库所有 issue、PR 的评论，人、Agent 与机器人账号都遵守；§3 的格式同时是 geek_bot 产品内置的默认记录格式（§6）。

## §1 生命周期：一件事 = 一个 issue = 一个 task 分支 = 一个 worktree = 一个 PR

```
开 issue ──▶ task.mjs start：从 stage 拉 task/<issue>/<slug> + 独立 worktree ──▶ 开 PR（Closes #<issue>）──▶ 审查 + CI ──▶ 合并进 stage
   │                                                                                                                    │
   └──────────────────────────── 每个阶段在 issue 上发一条「追踪记录」─────────────────────────────────────────────────┘
                                                                                                                         ▼
                                          自动：删远端 task 分支、关闭 issue、两边互相留言；本机：task.mjs finish 删 worktree 与本地分支
```

- **worktree 跟着 issue 走**：开工时由 `node scripts/task.mjs start` 与分支一起建，合并（或放弃关闭）后由 `node scripts/task.mjs finish` 与本地分支一起删；详见 [BRANCHING](BRANCHING.md)「task worktree」。
- **issue 是这件事的主档**：现象、复现、验收条件写在正文；之后的每一步进展写成评论，**不改写已发出的评论**（改正文只补「实施」段与链接）。
- **PR 是这次改动的证据档**：解决链路、验收证据、人工验收步骤写在正文（[PULL-REQUESTS](PULL-REQUESTS.md)）；审查与返工写成评论。
- **合并即结束**：PR 合并进 `stage` 后，`branch-hygiene` 工作流删除 task 分支，`issue-lifecycle` 工作流关闭 issue，并在 issue 和 PR 上各留一条「关闭」记录（由 `github-actions[bot]` 发出）。GitHub 只在合进默认分支 `main` 时才按 `Closes #n` 自动关闭，所以不能依赖它；工作流失败时由合并的人手工补关，并照 §3 的格式留言。
- **一件事做不完**：在原 issue 留「阻塞」或「拆分」记录，拆出的新 issue 用 `Refs #<原 issue>` 互相引用；不在已合并的分支上继续提交。
- **不再需要的事**：留「关闭」记录写明原因（重复、不做、被 #n 取代），再关闭；不静默关闭。
- 评论之外，执行者自己的每一步记在仓库的 `notes/` 里（[NOTES](NOTES.md)）：评论给所有人看进展，`notes/` 按人和时间追溯每个 agent 做过什么，两者都要写，不能互相代替。
- 每周一 `issue-lifecycle` 巡检一次：PR 已合并但 issue 还开着、issue 开着但既没有 task 分支也没有开着的 PR，都会列出来（只告警，不自动关闭）。定时巡检只在工作流进入默认分支 `main` 后运行；第一个正式版之前不会运行，残留由维护者手工核对，没有告警不代表没有残留（见 [CICD](../ops/CICD.md)「触发与职责」）。

## §2 互相引用

| 在哪 | 写什么 | 作用 |
|---|---|---|
| 分支名 | `task/<issue>/<slug>` | 分支 → issue |
| PR 正文「关联」 | `Closes #<issue>`（只关这一个）；其它相关的写 `Refs #n`、依赖写 `Depends on #n` | PR → issue；CI 的 `pr-contract` 核对与分支号一致 |
| issue 正文「实施」段 | 分支名、PR 编号 `#n`；合并后补合并提交（自动「关闭」记录里也有） | issue → PR |
| 评论 | 提到别的 issue / PR / 提交一律写 `#n` 或完整 SHA，不写「上面那个」「刚才的 PR」，也不写带组织名的完整链接 | 在 GitHub 上生成双向链接 |
| 提交信息 | 结尾 `Refs #<issue>`（[COMMITS](COMMITS.md)） | 提交 → issue |

## §3 追踪记录的格式

每条评论第一行是**记录头**，之后是固定的二级字段。字段用 `**名字**：` 开头，一个字段一行或一个列表；没有内容的字段整行省略，不写「无」。

```markdown
<!-- track v1 kind=<类型> stage=<阶段> -->
**<类型中文>**｜<一句话结论>

**现状**：<现在是什么样，一两句>
**证据**：
- <命令 + 真实输出摘要 / 截图 / 日志 / 链接>
**下一步**：<谁、做什么；已结束写「无，关闭」>
**引用**：#<issue> · #<PR> · <提交 SHA>
```

- 第一行的 HTML 注释对人不可见，给 Agent 和脚本解析：固定以 `<!-- track v1 ` 开头，`kind` 取下表的英文值，`stage` 取 `triage | dev | review | merged | released | closed`；`kind` 在前、`stage` 在后，之后可以跟 §6 的可选属性，最后以 ` -->` 结束。记录头的来历见 [ADR-0010](../decisions/0010-tracking-record-prefix.md)。
- 第二行加粗的中文类型 + 一句话结论，是给人扫的标题行。
- 时间与作者由 GitHub 记录，不在正文里重复写。
- 证据必须是能复查的东西：命令与真实输出、截图（直接拖进评论框上传）、CI 运行链接、提交 SHA。「看起来没问题」不是证据。
- 不贴密钥、令牌、会话、实例数据、真实姓名，也不贴私有仓库的内容、实例的内部地址或主机名；需要时写「已本地核对，不公开」。

| kind | 中文类型 | 什么时候发 | 发在哪 |
|---|---|---|---|
| `triage` | 受理 | 确认能复现 / 确认要做，定了优先级和范围 | issue |
| `repro` | 复现 | 补充或更新复现步骤、设备、日志 | issue |
| `plan` | 方案 | 开工前写定位结论与打算怎么改（大改动必发） | issue |
| `progress` | 进展 | 阶段性结果：分支已建、主要改动完成、卡在哪 | issue |
| `blocked` | 阻塞 | 需要人决定、缺凭据、依赖别的 issue | issue（同时 @ 相关人） |
| `review` | 审查 | 逐项审查结论（也可以写在 PR 正文「审查结论」） | PR |
| `rework` | 返工 | 审查或验收提出的问题，以及改了什么 | PR |
| `accept` | 验收 | 人工验收结果：在哪个环境、按哪几步、看到了什么 | PR 或 issue |
| `closed` | 关闭 | 合并、发布或放弃；写明合并提交或原因 | issue 与 PR 各一条 |

### 例子

```markdown
<!-- track v1 kind=plan stage=dev -->
**方案**｜轮询收到 304 后仍把条目重新入队，改成比较 ETag 后跳过

**现状**：同一个 PR 没有新提交，队列里每轮都多出一个重复的审查任务。
**证据**：
- 用打桩的 GitHub API 连跑两轮轮询：第二轮返回 304，队列长度从 1 变成 2（`pnpm exec vitest run tests/control` 的失败输出）
- 重复任务的触发时间与轮询间隔一致，与 webhook 无关
**下一步**：维护者在 task/8/poll_etag 上改轮询与入队逻辑，补一条区分修复前后的回归测试，今天提 PR
**引用**：#8
```

## §4 Agent 怎么读

- 取某个 issue 的全部记录：`gh issue view <n> --json body,comments`（在本仓库目录里运行，`gh` 会自动解析仓库），只看第一行以 `<!-- track v1 ` 开头的评论；最后一条的 `kind` 与 `stage` 就是当前状态。PR 的记录用 `gh pr view <n> --json body,comments` 取，规则相同。
- 解析记录头时只认 `kind` 和 `stage`，其余属性按 §6 可选；遇到不认识的属性直接忽略，不报错。
- [ADR-0010](../decisions/0010-tracking-record-prefix.md) 之前写下的少数评论（例如 #22 的第一条）记录头带另一个前缀，不回改；读这些 issue 的历史时一并参考，新记录只用 `track v1`。
- 恢复上下文（新会话、压缩后）先读 issue 正文 + 最后三条追踪记录，再读关联 PR 的正文与最后一条 `review` / `rework` / `accept`，不凭记忆续做。
- 自己做完一个阶段就发一条记录；不发「收到」「在做了」这类没有字段的评论。

## §5 与其它规范的关系

issue 正文字段见 [ISSUES](ISSUES.md)，PR 正文字段与 CI 契约见 [PULL-REQUESTS](PULL-REQUESTS.md)，审查清单见 [CODE-REVIEW](CODE-REVIEW.md)，分支规则见 [BRANCHING](BRANCHING.md)，仓库内的执行记录见 [NOTES](NOTES.md)。本文件只规定评论与生命周期，不重复它们的内容。

## §6 机器人的记录与产品默认格式

### 产品默认格式

§3 的记录头和字段格式也是 geek_bot 产品内置的默认记录格式：机器人在没有自己追踪规范的仓库里按它写。

- 部署者可以在后台修改这个默认格式（计划中：publisher 按模板生成记录头由 #9 实现，内置默认规范由 #10 实现）。产品代码里它只是可配置的默认值，不写死。
- 目标仓库有自己的追踪或评论规范时，以目标仓库为准。
- 产品每条写入另带一行隐藏标记 `<!-- geek-bot v1 ... -->`，用于幂等和从 GitHub 重建状态（ADR-0005，由 #2 写入）。它是产品标识，不是追踪规范：解析追踪记录只看记录头，两者不能互相替代。

本仓库自己的开发流程也用同一套格式，用自己的仓库验证产品的默认格式。截至 2026-09-25 机器人还没有上线（审查 #15、issue 跟进 #16、修复与返工 #18）；上线后它在本仓库发的记录同样遵守 §1–§4 和本节。

### 可选属性

机器人写的记录头在 `stage=` 之后可以加这几个可选属性，仍然是 `v1`：

| 属性 | 含义 |
|---|---|
| `actor=bot` | 这条记录由机器人账号发出 |
| `model=<id>` | 生成这条记录用的模型，取部署者 catalog 文件里的 id |
| `effort=<档位>` | 思考档位；模型没有档位时写 `off` |
| `commit=<40 位 SHA>` | 被审查或被处理的提交，完整 40 位小写十六进制 |

人写的记录不加这些属性。解析记录的脚本和 Agent 必须忽略不认识的属性；要改变已有字段的含义时升到 `v2`，不改 `v1`。

### 各类记录的写法

- **审查**（`kind=review`，发在 PR 上）：
  - 用 PR review 的 `COMMENT` 类型发，不用 APPROVE 或 REQUEST_CHANGES；
  - **现状** 写被审查的提交和按哪份规范审；
  - **证据** 逐条写 `[严重度] 文件:行 — 理由 — 修法`，严重度取 [CODE-REVIEW](CODE-REVIEW.md) 的 `阻塞` / `应修` / `建议`；
  - 不写 `**结论：…**` 这一行。机器审查不是审查结论，边界见 [CODE-REVIEW](CODE-REVIEW.md)「机器审查的边界」。
- **返工**（`kind=rework`）：机器人自己的 PR 收到审查意见、CI 失败或和目标分支冲突后返工，写改了什么、回应了哪几条意见、用什么验证（[PULL-REQUESTS](PULL-REQUESTS.md)「机器人开的 PR」）。
- **阻塞**（`kind=blocked`）：追问时写清缺什么，同时给 issue 打 `bot:blocked`；有人回复后由机器人去掉标签。
- **关闭**（`kind=closed`）：关闭 issue 之前先发，写明原因（重复、已解决、不属于本仓库、被 #n 取代、追问后仍不清楚）；机器人只关 issue，不关 PR。
- **进展**（`kind=progress`）：开工前或发出前复核时发现条件变了（分给了人、打了 `bot:manual`、有人开了关联 PR）而放弃，写明哪条变了，不关 issue。

哪些 issue 由机器人接、标签怎么用见 [ISSUES](ISSUES.md) §5；追问轮数、提醒与关闭天数、优先级等完整默认行为见 [control 服务契约](../services/control/README.md)「计划中的默认行为」。

### 例子

```markdown
<!-- track v1 kind=review stage=review actor=bot model=example-model effort=medium commit=0123456789abcdef0123456789abcdef01234567 -->
**审查**｜3 条意见，其中 1 条阻塞；结论由人来写

**现状**：审查提交 0123456789abcdef0123456789abcdef01234567，依据本仓库的 CODE-REVIEW。
**证据**：
- [阻塞] app/control/src/publisher/whitelist.ts:42 — review 的 event 为空时会被当成待提交的草稿，绕过「只发 COMMENT」— event 只接受字面量 COMMENT，补一条空 event 被拒的回归测试
- [应修] tests/control/whitelist.test.ts:10 — 用例连了真实网络 — 改用注入的 fetch 桩，默认拒绝网络
- [建议] app/control/src/publisher/outbox.ts:88 — 重试次数写成了魔法数 — 提成配置项
**下一步**：等人按 CODE-REVIEW 审查并写结论；机器人不批准、不合并
**引用**：#9 · #<PR>
```

例子里的模型 id 和提交 SHA 是虚构的；属性值里不能有空格，实际记录写 catalog 里的真实 id 和完整 SHA。
