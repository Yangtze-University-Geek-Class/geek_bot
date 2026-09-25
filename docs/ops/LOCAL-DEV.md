# 本机开发

> 在本机准备 Node 22 与 pnpm 9.15.9，安装依赖，跑 `pnpm verify`，启用 Git 钩子，用 task worktree 开工和收尾。

状态：`current` · 更新：2026-09-25 · 适用：在本机开发本仓库的维护者与 agent

先读完 [AGENTS](../../AGENTS.md) §0 列出的规范再照本文操作。分支与 worktree 的规则以 [BRANCHING](../conventions/BRANCHING.md) 为准，测试规则以 [TESTING](../conventions/TESTING.md) 为准，本文只写操作步骤。

## 运行时

| 工具 | 版本 | 来源 |
|---|---|---|
| Node | 22，且不低于 22.13 | `.nvmrc` 与 `.node-version` 写 `22`；根 `package.json` 的 `engines.node` 是 `>=22.13.0 <23` |
| pnpm | 9.15.9 | 根 `package.json` 的 `packageManager: pnpm@9.15.9` |

- Node：用 nvm、fnm 等按 `.nvmrc` 切到 22。`pnpm check:runtime` 在当前 Node 不是 22 或低于 22.13 时失败。换了 Node 版本后重新安装依赖。
- pnpm 二选一：
  - corepack（Node 22 自带）：`corepack enable`，之后在仓库里运行 `pnpm` 会按 `packageManager` 用 9.15.9；
  - 独立安装：按 pnpm 官方的独立安装方式装 9.15.9。
- 装好后在仓库根目录确认：`node --version` 输出 `v22.x`（x ≥ 13），`pnpm --version` 输出 `9.15.9`。版本不对时先换版本再安装，不要用别的 pnpm 主版本改写 `pnpm-lock.yaml`。

## 安装

```bash
pnpm install --frozen-lockfile
```

- 锁文件不可变：安装不应改动 `pnpm-lock.yaml`。要加依赖，按 [CONTRIBUTING](../conventions/CONTRIBUTING.md) 在 PR 里说明目的、许可和维护代价。
- 每个 task worktree 各装一次；pnpm 的全局 store 会复用已下载的包。
- 现阶段（#1）只有开发依赖 `typescript`、`vitest`、`@types/node`，没有任何生产依赖；Fastify、better-sqlite3、Vue、Tuffex 由后续 issue 引入。

## 验证：`pnpm verify`

`pnpm verify` 依次运行 `pnpm check`、`pnpm test`、`pnpm build`，任一步失败就以非 0 退出。提交前在自己的 worktree 里完整跑一遍，把命令和真实输出贴进 PR。

| 步骤 | 实际命令 | 做什么 |
|---|---|---|
| `check:runtime` | `node scripts/check-runtime.mjs` | 当前 Node 必须是 22 且不低于 22.13 |
| `check:boundaries` | `node scripts/check-boundaries.mjs` | 五个包互不导入实现；都可以导入 `@geek-bot/protocol`；protocol 不导入任何 app；runner 只用 Node 标准库。用 AST 解析，解析不了就失败 |
| `check:docs` | `node scripts/docs-index.mjs --check && node scripts/check-docs.mjs && node scripts/tuffex-docs.mjs check` | `docs/INDEX.md` 与文档一致；`AGENTS.md`、`README.md`、`docs/README.md` 存在；相对链接指向真实文件；每个 `app/<name>` 与 `packages/<name>` 都有 `docs/services/<name>/README.md`；`.omp/skills/code-review` 与 `.claude/skills/code-review` 是指向 `.agents/skills/code-review` 的符号链接；`docs/components/tuffex/` 里受哈希管理的上游文件逐个与清单一致，`reference/`、`snapshot/` 下不许有清单以外的文件（报 `unlisted`） |
| `check:secrets` | `node scripts/check-secrets.mjs` | 私有 env 文件、数据库文件不入库；env 模板里的密钥项只能留空或写 `*_FILE`；不出现私钥、GitHub 令牌、`sk-` 开头的长密钥。不按扩展名挑文件，每个非二进制文件都扫（`Dockerfile`、`.npmrc`、没有扩展名的文件都在内）；私钥文件名（`*.pem`、`*.key`、`id_ed25519` 等）和数据库附属、备份文件（`.db.bak`、`.sqlite-wal` 等）不看内容，一律不许入库 |
| `check:public-safety` | `node scripts/check-public-safety.mjs` | 不出现私网、CGNAT、链路本地地址和带 mesh 子域的组网主机名；被禁词按 SHA-256 比对；确需保留的放行项逐条写进 `scripts/public-safety-allow.json` 并写明理由。文件名、目录名、符号链接目标同样扫描；放行清单自己的 `path`、`reason` 照常扫描；`docs/components/tuffex/reference/`、`snapshot/` 下只跳过清单（`manifest.json`）里登记过的文件内容 |
| `typecheck` | `pnpm -r --if-present run typecheck && tsc -p tsconfig.json` | 每个包 `tsc -p tsconfig.json --noEmit`；再用根 `tsconfig.json` 对 `tests/**` 与 `vitest.config.ts` 做类型检查，不产出文件 |
| `test` | `vitest run` | 运行 `tests/` 下的全部单测 |
| `build` | `pnpm check:runtime && pnpm -r --if-present run build` | 每个包 `tsc -p tsconfig.json`，产物进各包的 `dist/`（已被 `.gitignore` 忽略） |

另外几条命令不在 `verify` 里：

- `pnpm docs:index`：改了文档标题、摘要或路径后重新生成 `docs/INDEX.md`，不要手工编辑它。
- `pnpm check:branch-invariants`：核对 `stage` 包含 `main`、`main` 不领先 `stage` 和分支命名；CI 的 `branch-guard` 用 `--require-remote-refs` 跑同一脚本。
- `node scripts/check-public-safety.mjs --hash <词>`：打印一个词的 SHA-256，维护者用它往被禁词表里追加条目；表里只存哈希，不存明文。只接受单个 `[a-z0-9]+` token（大小写不限）或 IPv4；带连字符、空格的词要拆开分别登记；汉字词不支持，会以 2 退出。
- `pnpm labels:plan`：只打印创建标签的 `gh label create` 命令，不执行，由所有者决定是否运行（见 [CICD](CICD.md)）。
- 还没有的命令：`dev:control`（#3）、`dev:console` 与 `test:e2e`（#4）、`check:environments` 与 `release:plan`（#7）、`test:vm`（#12）。

## Git 钩子

```bash
pnpm hooks:enable          # 等于 git config core.hooksPath .githooks
```

- 每个克隆运行一次；task worktree 共用所在克隆的 Git 配置，不用再设。停用：`git config --unset core.hooksPath`。
- `.githooks/pre-push` 在每次推送前运行 `check-branch-invariants --push`：核对两条分支不变量、`main` 与 `stage` 的写入来源、分支命名和发布 tag 规则，不通过就拒绝推送。
- 本仓库是免费计划下的私有仓库，GitHub 没有分支保护（见 [CICD](CICD.md)）。分支不变量由两道机器检查核对：这个钩子和 CI 的 `branch-guard`；合并前再由审查者和 CI 的 `pr-contract` 把关。发布 tag 在 `release.yml`（#7）加入之前只有本地钩子这一道（见 [RELEASES](../conventions/RELEASES.md)「tag 不可变」）。不要用 `--no-verify` 绕过钩子。

## task worktree：开工与收尾

一个 issue 一个 `task/<issue>/<slug>` 分支、一个 worktree、一个 PR。`task.mjs` 需要本机已登录的 `gh`，它会读 issue 状态并在 issue 上留追踪记录。

```bash
git branch --show-current                        # 1. 确认当前在哪
node scripts/task.mjs start <issue> <slug>       # 2. 从最新 origin/stage 建 task/<issue>/<slug> 与 .claude/worktrees/task-<issue>，并在 issue 上留开工记录
cd .claude/worktrees/task-<issue>
pnpm install --frozen-lockfile                   # 3. 在 worktree 里安装、开发、验证、提交
pnpm verify
# 4. 开 PR → stage，正文按 PULL-REQUESTS 的契约写；每个阶段在 issue 上留追踪记录
# 5. PR 合并进 stage 后，远端分支与 issue 由 branch-hygiene / issue-lifecycle 自动处理；
#    回到主工作区删本机的 worktree 与本地分支：
node scripts/task.mjs finish <issue>
```

- `node scripts/task.mjs list` 列出每个 worktree 对应的 issue 与 PR 状态；`node scripts/task.mjs prune` 一次清掉所有可清理的 worktree。
- `slug` 只用小写字母、数字和 `_`（例 `review_queue`），不用 `-`。
- 只有 PR 已合并，或 issue 已关闭（放弃）且没有开着的 PR 时，`finish` 才删除；worktree 有未提交改动、PR 还开着、issue 还开着且 PR 没合并、或查不到 issue 状态时，只报告原因、不删除，并以非 0 退出。
- 在主工作区运行 `finish`，不要在要删的 worktree 里运行。
- 脚本按真实路径判断自己是否被直接运行：即使经符号链接路径启动，参数不对也会打印用法并以非 0 退出，不会静默退出 0。

## 测试目录

| 目录 | 内容 |
|---|---|
| `tests/control/`、`tests/console/`、`tests/node/`、`tests/runner/`、`tests/protocol/` | 各包的单测，与 `app/<name>`、`packages/protocol` 一一对应 |
| `tests/tooling/` | 门禁脚本与工作流辅助脚本的测试：缺服务文档、跨包导入、私网地址、模板密钥有值、PR 正文缺段等反例必须失败；经符号链接启动 CLI 的回归；分支不变量、task worktree、PR 正文契约、标签声明 |
| `tests/e2e/`（计划中，随 #4 加入） | 管理后台的浏览器测试，入口 `pnpm test:e2e` |
| `tests/integration/vm/`（计划中，随 #12 加入） | 一次性 VM 的实测，入口 `pnpm test:vm`；需要 `/dev/kvm`，只在有它的 Linux 机器上手动运行，macOS 本机跑不了 |

测试文件以 `.test.ts` 结尾，由根 `vitest.config.ts` 收集。测试不读 `.env`、不连真实 GitHub、不用真实数据；需要反例的字面量（私网地址、被禁词）在运行时拼出来，不写进仓库。隔离要求见 [TESTING](../conventions/TESTING.md)。

## 常见问题

- `check:runtime` 失败：切到 Node 22（≥ 22.13）后删掉 `node_modules` 重新安装。
- `check:docs` 报索引过期：运行 `pnpm docs:index`，把生成的 `docs/INDEX.md` 一起提交。
- `check:public-safety` 报被禁词或私网地址：改成占位（`<owner>`、`<org>/<repo>`、`https://geek-bot.example.com`、`203.0.113.10`）；确实是必须保留的技术常量时，才在放行清单里加一条并写明理由，放行项要在审查里单独说明。
