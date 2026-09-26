# 本机开发

> 在本机准备 Node 22 与 pnpm 9.15.9，安装依赖，跑 `pnpm verify`，启用 Git 钩子，用 task worktree 开工和收尾，每一步写执行记录。

状态：`current` · 更新：2026-09-26 · 适用：在本机开发本仓库的维护者与 agent

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
- 生产依赖目前是 console 的 Vue、vue-router、Tuffex（#4）和 control 的 Fastify、better-sqlite3（#3）。版本见 [STACK](../design/STACK.md)。
- better-sqlite3 13 的包里自带各平台的预编译二进制；安装时它的 `binding.gyp` 仍会触发一次 node-gyp（检测到预编译二进制后不编译），本机需要有 python3 与 make（macOS 装了 Xcode 命令行工具即可）。
- Tuffex 依赖的 `@talex-touch/utils` 把 Electron 声明为 peer；根 `package.json` 的 `pnpm.packageExtensions` 把它标成可选，安装时不会下载 Electron（[console 服务契约](../services/console/README.md)「Tuffex 0.6.0 在 Node 22 上的实测」）。

## 验证：`pnpm verify`

`pnpm verify` 依次运行 `pnpm check`、`pnpm test`、`pnpm build`，任一步失败就以非 0 退出。提交前在自己的 worktree 里完整跑一遍，把命令和真实输出贴进 PR。

| 步骤 | 实际命令 | 做什么 |
|---|---|---|
| `check:runtime` | `node scripts/check-runtime.mjs` | 当前 Node 必须是 22 且不低于 22.13 |
| `check:boundaries` | `node scripts/check-boundaries.mjs` | 五个包互不导入实现；都可以导入 `@geek-bot/protocol`；protocol 不导入任何 app；`app/runner/src` 只用 Node 标准库、不引用 `src/` 以外的文件；每个包都登记在 `pnpm-workspace.yaml`、都有 `typecheck` 与 `build` 脚本。用 AST 解析，解析不了就失败 |
| `check:docs` | `node scripts/docs-index.mjs --check && node scripts/check-docs.mjs && node scripts/tuffex-docs.mjs check` | `docs/INDEX.md` 与文档一致；`AGENTS.md`、`README.md`、`docs/README.md` 存在；相对链接指向真实文件；每个 `app/<name>` 与 `packages/<name>` 都有 `docs/services/<name>/README.md`；`.omp/skills/code-review` 与 `.claude/skills/code-review` 是指向 `.agents/skills/code-review` 的符号链接；`docs/components/tuffex/` 里受哈希管理的上游文件逐个与清单一致，`reference/`、`snapshot/` 下不许有清单以外的文件（报「没有登记在清单里」） |
| `check:notes` | `node scripts/note.mjs check` | `notes/` 只能是 `<日期>/<GitHub 用户名>/<链路>.md` 加 `INDEX.md`；标题、负责人与目录一致；每条记录的标题是北京时间 `HH:MM:SS +08:00`、阶段在词表里、`执行者`/`做了什么`/`结果` 齐全；时间不倒退；task 链路以「开工」开始、收尾之后不再记；`notes/INDEX.md` 是最新的（[NOTES](../conventions/NOTES.md)） |
| `check:secrets` | `node scripts/check-secrets.mjs` | 私有 env 文件、数据库文件不入库；env 模板里的密钥项只能留空或写 `*_FILE`；不出现私钥、GitHub 令牌、`sk-` 开头的长密钥。不按扩展名挑文件，每个非二进制文件都扫（`Dockerfile`、`.npmrc`、没有扩展名的文件都在内）；私钥文件名（`*.pem`、`*.key`、`id_ed25519` 等）和数据库附属、备份文件（`.db.bak`、`.sqlite-wal` 等）不看内容，一律不许入库 |
| `check:public-safety` | `node scripts/check-public-safety.mjs` | 不出现私网、CGNAT、链路本地地址和带 mesh 子域的组网主机名；被禁词按 SHA-256 比对；确需保留的放行项逐条写进 `scripts/public-safety-allow.json` 并写明理由。文件名、目录名、符号链接目标同样扫描；`notes/` 下的路径和内容不做被禁词比对（记录必须写负责人的 GitHub 用户名，见 [NOTES](../conventions/NOTES.md) §7），地址和主机名规则照常；放行清单自己的 `path`、`reason` 照常扫描；`docs/components/tuffex/reference/`、`snapshot/` 下只跳过清单（`manifest.json`）里登记过的文件内容 |
| `typecheck` | `pnpm -r --if-present run typecheck && tsc -p tsconfig.json` | 每个包 `tsc -p tsconfig.json --noEmit`；再用根 `tsconfig.json` 对 `tests/**` 与 `vitest.config.ts` 做类型检查，不产出文件 |
| `test` | `vitest run` | 运行 `tests/` 下的全部单测 |
| `build` | `pnpm check:runtime && pnpm -r --if-present run build` | 每个包 `tsc -p tsconfig.json`，产物进各包的 `dist/`（已被 `.gitignore` 忽略）；control 另把 `src/db/migrations/*.sql` 复制进 `dist/db/migrations/`；console 是 `vite build` |

另外几条命令不在 `verify` 里：

- `pnpm docs:index`：改了文档标题、摘要或路径后重新生成 `docs/INDEX.md`，不要手工编辑它。
- `pnpm check:branch-invariants`：核对 `stage` 包含 `main`、`main` 不领先 `stage`，违反就以非 0 退出；分支命名不合规默认只告警（加 `--strict-long-lived` 才算失败）。CI 的 `branch-guard` 用 `--require-remote-refs` 跑同一脚本。
- `node scripts/check-public-safety.mjs --hash <词>`：打印一个词的 SHA-256，维护者用它往被禁词表里追加条目；表里只存哈希，不存明文。只接受单个 `[a-z0-9]+` token（大小写不限）或 IPv4；带连字符、空格的词要拆开分别登记；汉字词不支持，会以 2 退出。扫描时每个 token 连同它长度 4 到 32 的前缀、后缀一起比对，所以登记一个词就能拦住它和别的词、数字连写的形式（夹在两个词中间的拦不住）；短于 4 个字符的词只按整词比对，`--hash` 会在 stderr 提示。
- `node scripts/note.mjs add|flush|index|check`：写执行记录、把暂存的记录并进当前 task worktree、重新生成 `notes/INDEX.md`（`--summary` 输出全部链路的一览表）、核对记录；`check --pr --base origin/stage --head <task 分支>` 是 CI 对 task PR 的检查，本地开 PR 前可以先跑（审查进行中加 `--for-review`，允许暂缺「审查」）。用法见 [NOTES](../conventions/NOTES.md) §5。
- `pnpm labels:plan`：只打印创建标签的 `gh label create` 命令，不执行，由所有者决定是否运行（见 [CICD](CICD.md)）。
- `pnpm dev:console`：console 的样板数据模式开发服务器（`vite --mode sample`），数据全部虚构、不连控制面；地址栏加 `?sample=empty|slow|error|forbidden|unauthenticated|offline` 看各种状态。
- `pnpm test:e2e`：浏览器回归。以样板数据模式构建 console（`app/console/.sample-dist/`，已忽略），在 127.0.0.1:4174 预览，用 Playwright 跑 `tests/e2e/`；报告在 `playwright-report/`，验收截图在 `test-results/evidence/`（都已忽略）。第一次运行前 `pnpm exec playwright install chromium`，浏览器下载到用户缓存目录（macOS 是 `~/Library/Caches/ms-playwright`），不进仓库。4174 端口被占用时它直接失败，不复用已有的服务。
- `pnpm dev:control`：本机运行 control（先构建 protocol 与 control，再运行 `app/control/scripts/dev.mjs`）。库、加密备份和运维本地通道放在仓库根的 `data/`（已忽略）；第一次运行时在 `data/dev-secrets/` 生成本机用的一次性 master key 与备份加密密钥（0600），它们不是任何实例的密钥。默认实例角色 `preview`、只绑 `127.0.0.1:8080`、日志级别 `debug`；仓库根有 `.env.local`（从 `.env.example` 复制）时先读它，环境变量里有值的项优先，例如端口被占时 `GEEK_BOT_PORT=18080 pnpm dev:control`。Ctrl-C 触发优雅停机。起来以后 `curl http://127.0.0.1:8080/readyz` 应返回 `{"status":"ready"}`。
- control 的运维命令（`backup`、`verify-backup`、`restore --dry-run`）在本机用构建产物运行，环境变量要和 `dev:control` 一致，例如 `GEEK_BOT_INSTANCE_ROLE=preview GEEK_BOT_DB_PATH=./data/geek-bot.db GEEK_BOT_MASTER_KEY_FILE=./data/dev-secrets/master_key GEEK_BOT_BACKUP_KEY_FILE=./data/dev-secrets/backup_key node app/control/dist/cli.js backup`；control 在运行时命令经 `data/run/control.sock` 交给它执行，没在运行时独占打开库自己执行（[control 服务契约](../services/control/README.md)「运维命令与单写者」）。
- 还没有的命令：`check:environments` 与 `release:plan`（#7）、`test:vm`（#12）。

## control 镜像

构建上下文是仓库根，只构建、不推送（推镜像只在 `release.yml`，#7）：

```bash
docker build -f app/control/Dockerfile -t geek-bot-control:local .
```

- 基础镜像按 digest 钉死，要能从 Docker Hub 拉到它；拉不到时，可以先把同一 digest 的镜像放进本机，再用 `--build-arg NODE_IMAGE=<本机镜像名>` 构建（内容与钉死的 digest 一致才算同一个基础镜像）。
- 本机起一次容器做实机检查（密钥是临时生成的一次性值，用完删掉容器、卷和文件）：

  ```bash
  secrets=$(mktemp -d) && (umask 077; openssl rand -base64 32 > "$secrets/master_key"; openssl rand -base64 32 > "$secrets/backup_key")
  docker run -d --name geek-bot-control-local -p 127.0.0.1:18080:8080 \
    -e GEEK_BOT_INSTANCE_ROLE=preview -e GEEK_BOT_HOST=0.0.0.0 -e GEEK_BOT_PUBLIC_ORIGIN=https://geek-bot.example.com \
    -v "$secrets/master_key:/run/secrets/master_key:ro" -v "$secrets/backup_key:/run/secrets/backup_key:ro" \
    -v geek-bot-control-local-data:/data geek-bot-control:local
  curl -i http://127.0.0.1:18080/readyz                                   # 200 {"status":"ready"}
  docker inspect --format '{{.Config.User}} {{json .Config.Healthcheck}} {{.State.Health.Status}}' geek-bot-control-local
  docker exec geek-bot-control-local geek-bot backup                       # 运维命令经本地通道交给运行中的 control
  docker stop geek-bot-control-local                                       # SIGTERM：checkpoint 后以 0 退出
  docker rm geek-bot-control-local && docker volume rm geek-bot-control-local-data && rm -rf "$secrets"
  ```

- 绑定 `0.0.0.0` 必须配 `GEEK_BOT_PUBLIC_ORIGIN`（S-20）；本机 `curl` 走的是端口映射，origin 只是占位。
- 删掉 master key 文件（或不挂它）再起，容器以 1 退出，`docker logs` 里只有变量名和路径，没有密钥内容。

## Git 钩子

```bash
pnpm hooks:enable          # 等于 git config core.hooksPath .githooks
```

- 每个克隆运行一次；task worktree 共用所在克隆的 Git 配置，不用再设。停用：`git config --unset core.hooksPath`。
- `.githooks/pre-push` 在每次推送前运行 `check-branch-invariants --push`，下列情况拒绝推送：
  - 推 `main`：被推的提交不在本地 `stage` 里（本地没有 `stage` 时看 `origin/stage`），或两者都找不到；本地 `stage` 落后时先 `git fetch` 并更新它，否则已经进了 `origin/stage` 的提交也会被拒；
  - 推 `stage`：来源不是 `stage` 自身或合规的 `task/<issue>/<slug>`，或被推的 `stage` 不包含 `main`；
  - 删除远端 `main` 或 `stage`；
  - 发布 tag：格式不对、删除或移动已有发布 tag、rc tag 不在 `stage` 的提交上、正式 tag 不在 `main` 的提交上、tag 版本与该提交 `package.json` 的 `version` 不一致、已有正式 tag 的版本再打 rc。
- 推到其它分支时，命名不合规（例如 `task/12-foo`、`dev-alice`）只告警，推送照常放行；以不合规分支为来源推 `stage` 才会被上面第二条拒绝（命名规则见 [BRANCHING](../conventions/BRANCHING.md)）。
- 本仓库是免费计划下的私有仓库，GitHub 没有分支保护（见 [CICD](CICD.md)）。分支不变量由两道机器检查核对：这个钩子和 CI 的 `branch-guard`；合并前再由审查者和 `issue-lifecycle` 的 `pr-base`、`pr-contract` 把关。发布 tag 在 `release.yml`（#7）加入之前只有本地钩子这一道（见 [RELEASES](../conventions/RELEASES.md)「tag 不可变」）。不要用 `--no-verify` 绕过钩子。

## task worktree：开工与收尾

一个 issue 一个 `task/<issue>/<slug>` 分支、一个 worktree、一个 PR。`task.mjs` 需要本机已登录的 `gh`，它会读 issue 状态并在 issue 上留追踪记录；`start`、`finish`、`prune` 还要知道是谁在干活（执行记录的身份，[NOTES](../conventions/NOTES.md)）。

```bash
git branch --show-current                        # 1. 确认当前在哪
export GEEK_NOTES_USER=<GitHub 用户名>            #    执行记录的身份：替谁干活
export GEEK_NOTES_BY="agent-claude-geek-bot-01（Claude Code，<模型>）"   # 执行者；人自己做写 human-<GitHub 用户名>
node scripts/task.mjs start <issue> <slug>       # 2. 从最新 origin/stage 建 task/<issue>/<slug> 与 .claude/worktrees/task-<issue>，在 issue 上留开工记录，notes/ 里写「开工」
cd .claude/worktrees/task-<issue>
pnpm install --frozen-lockfile                   # 3. 在 worktree 里安装、开发、验证、提交
pnpm verify
node scripts/note.mjs add --stage 提交 --issue <issue> --title "…" --did "…" --result "…"   # 每一步记一条，和代码一起提交
# 4. 开 PR → stage，正文按 PULL-REQUESTS 的契约写；每个阶段在 issue 上留追踪记录，notes/ 里记「PR」「审查」「返工」
# 5. PR 合并进 stage 后，远端分支与 issue 由 branch-hygiene / issue-lifecycle 自动处理；
#    回到主工作区删本机的 worktree 与本地分支（「收尾」先暂存，下一个 task 开工时随它入库）：
node scripts/task.mjs finish <issue>
```

- `node scripts/task.mjs list` 列出每个 worktree 对应的 issue 与 PR 状态；`node scripts/task.mjs prune` 一次清掉所有可清理的 worktree。
- `slug` 只用小写字母、数字和 `_`（例 `review_queue`），不用 `-`。
- 只有 PR 已合并，或 issue 已关闭（放弃）且没有开着的 PR 时，`finish` 才删除；worktree 有未提交改动、PR 还开着、issue 还开着且 PR 没合并、或查不到 issue 状态时，只报告原因、不删除，并以非 0 退出。
- `start` 缺身份时直接以 1 退出，不查 issue、不建分支。`start` 查 issue 时分清两种失败：gh 明确回答没有这个编号，提示先开 issue；gh 本身失败（网络、TLS、认证、没装 gh），报「查 issue 状态失败」并附上 gh 的错误，以 1 退出，这时先修好 gh 再重跑。
- 在主工作区运行 `finish`，不要在要删的 worktree 里运行。
- 脚本按真实路径判断自己是否被直接运行：即使经符号链接路径启动，参数不对也会打印用法并以非 0 退出，不会静默退出 0。

## 测试目录

| 目录 | 内容 |
|---|---|
| `tests/control/`、`tests/console/`、`tests/node/`、`tests/runner/`、`tests/protocol/` | 各包的单测，与 `app/<name>`、`packages/protocol` 一一对应 |
| `tests/tooling/` | 门禁脚本与工作流辅助脚本的测试：缺服务文档、跨包导入、私网地址、模板密钥有值、PR 正文缺段等反例必须失败；经符号链接启动 CLI 的回归；分支不变量、task worktree、PR 正文契约、标签声明 |
| `tests/e2e/` | 管理后台的浏览器回归（Playwright），入口 `pnpm test:e2e`；类型检查用 `tests/e2e/tsconfig.json` |
| `tests/integration/vm/`（计划中，随 #12 加入） | 一次性 VM 的实测，入口 `pnpm test:vm`；需要 `/dev/kvm`，只在有它的 Linux 机器上手动运行，macOS 本机跑不了 |

测试文件以 `.test.ts` 结尾，由根 `vitest.config.ts` 收集；浏览器回归以 `.spec.ts` 结尾，只由 Playwright 收集。测试不读 `.env`、不连真实 GitHub、不用真实数据；需要反例的字面量（私网地址、被禁词）在运行时拼出来，不写进仓库。隔离要求见 [TESTING](../conventions/TESTING.md)。

## 常见问题

- `check:runtime` 失败：切到 Node 22（≥ 22.13）后删掉 `node_modules` 重新安装。
- `check:docs` 报索引过期：运行 `pnpm docs:index`，把生成的 `docs/INDEX.md` 一起提交。
- `check:public-safety` 报被禁词或私网地址：改成占位（`<owner>`、`<org>/<repo>`、`https://geek-bot.example.com`、`203.0.113.10`）；确实是必须保留的技术常量时，才在放行清单里加一条并写明理由，放行项要在审查里单独说明。
