---
name: code-review
description: "geek_bot 仓库级代码审查。当任何 PR 要进入 stage 或 main、需要合并前自查，或用户说「审查这次改动 / review 这个 diff / 看看这个分支能不能合」时使用。"
---

# 代码审查（geek_bot 仓库级）

规则正文归 [`docs/conventions/CODE-REVIEW.md`](../../../docs/conventions/CODE-REVIEW.md)：看什么、怎么判、写在哪，一律以它为准。本 skill 只补三样东西：审查入口与前置、逐项核对的**可执行命令**、审查记录模板。冲突时以规范文档为准，不在这里复制它的正文。下文「第 n 项」与 CODE-REVIEW 清单的编号一一对应。

## 何时使用

- 任何要合入 `stage` 的 PR（含文档、脚本、配置）。
- 任何要合入 `main` 的操作（`main` 只收 `stage`，这次审查是对当下 `stage` 的第二道复核）。
- Dockerfile、compose、env 模板、`deploy/remote/*.sh`、`release.yml` 的变更，任何触及认证、授权、密钥、令牌、数据库结构的改动，以及任何触及 publisher 写入白名单、OAuth scope、节点协议、sandbox 或 VM 隔离、模型中继的改动。
- 用户要求「审查这次改动 / review 这个 diff / 看看这个分支能不能合」。

不适用：只需要解释代码、写测试、修 bug 的请求——先把活干完，再走本审查。注释错字这类改动不必逐项过清单，但结论仍要写进 PR（写「无需逐项审查 + 理由」）。

geek_bot 部署实例自动发出的 `COMMENT` review 不是本技能的产物，也不等于审查结论（见 CODE-REVIEW「机器审查的边界」）。

## 前置（缺一不可）

1. 确认分支与工作区：`git branch --show-current`、`git status --short`。不在 `task/<issue>/<slug>` 或 `stage` 上就停下来说明现状，不自行切换。
2. 读根 [`AGENTS.md`](../../../AGENTS.md) 的硬门禁，再读 [`docs/conventions/CODE-REVIEW.md`](../../../docs/conventions/CODE-REVIEW.md)（审查清单与结论定义）与 [`docs/conventions/BRANCHING.md`](../../../docs/conventions/BRANCHING.md)（分支不变量）。
3. 明确审查目标：合进 `stage` 还是 `main`、来自哪条分支、被审查的 commit SHA。
4. 被审查的 diff 没读完、验证证据没看到之前，不给结论。

## 取 diff（精确命令）

本地分支 / 已推送的分支：

```bash
git fetch origin
git branch --show-current
git diff origin/stage...HEAD --stat                # 先看范围
git log --oneline --no-merges origin/stage..HEAD   # 提交信息是否合规
git diff origin/stage...HEAD                       # 完整 diff
git diff                                           # 未提交改动同样要算进来
git status --short
```

- 基线由目标分支决定：合进 `stage` 用 `origin/stage`，合进 `main` 用 `origin/main`。下文命令里的 `origin/stage` 按目标替换。
- 必须用三点 `...`（对 merge-base 比较）。两点 diff 会把目标分支上别人的提交算进本次改动，结论直接失真。三点写法本身就是对 merge-base 比较，不要再加 `--merge-base`：git 不接受它和范围一起用，会报错退出。
- 基线解析不了或 diff 为空，在这里停下来说清楚，不要往下走。
- 下文的 `grep` 只是帮你找到要看的行，**命中为空不等于没有问题**，结论必须来自读过的 diff。管道前半段的 `git diff` 一旦报错，`grep` 只收到空输入，输出和「没有命中」一模一样；stderr 里有报错就停下来修命令，不要当成没有命中。

PR 场景（GitHub，在仓库目录里运行，`gh` 自动解析仓库）：

```bash
gh pr view <N> --json number,title,baseRefName,headRefName,mergeStateStatus,files
gh pr diff <N>
gh pr checkout <N>   # 需要跑脚本或看完整仓库上下文时
```

- 先核对 `baseRefName`：base 写错（例如 task 分支直接以 `main` 为 base）本身就是阻塞项。
- 结论要写回 PR；`gh pr comment` 是对外可见动作，执行前先确认。

## 逐项核对的可执行动作

清单条目与严重度定义见 CODE-REVIEW.md；这里只给每项对应的命令与看什么。标「计划中」的路径还不存在，等对应 issue 引入后适用；不存在时在结论里写「不涉及」。

1. **分支不变量**：
   ```bash
   git merge-base --is-ancestor origin/main origin/stage && echo "stage 包含 main"
   git log --oneline origin/main..origin/stage          # stage 领先的方向
   node scripts/check-branch-invariants.mjs --require-remote-refs
   git ls-remote --heads origin                         # 只许 main、stage、task/**、dev/**
   gh pr list --state merged --limit 20 --json number,headRefName
   ```
   新分支名不得含 `-`；已合并的 `task/**` 不得残留在远端；不得有 `main`/`stage` 之外的长期分支。
2. **是否直推 main**：PR 的 `baseRefName`、提交来源、CI 触发 ref 三处交叉验证；`git diff origin/stage...HEAD -- .github/workflows .githooks` 里不得出现向 `main` 写入的新路径。发现绕过 `stage` 写 `main` 的路径即阻塞。
3. **密钥是否入库**：
   ```bash
   pnpm check:secrets
   git diff origin/stage...HEAD | grep -nE '^\+' | grep -niE 'secret|token|passw|private|api_key|_file|bearer|ghp_|gho_|github_pat_|sk-'
   ```
   `check:secrets` 只覆盖部分文本模式，**通过它不等于没有泄漏**。人眼过一遍 diff 中所有新增字符串：OAuth client secret、会话密钥、令牌加密密钥、模型网关密钥、节点加入令牌与节点令牌、机器人账号的 GitHub 令牌、会话 Cookie、SSH 私钥都不得出现真值。
4. **env 模板只放占位符**：
   ```bash
   git diff origin/stage...HEAD -- deploy/env .env.example
   pnpm check:environments   # 随 #7 加入；加入前手工核对
   ```
   每一行只能是占位符（`<owner>`、`https://geek-bot.example.com`、`203.0.113.10` 这类）或通用默认值；密钥项留空或是 `*_FILE` 路径；出现真实域名、地址、组织名或账号即阻塞。字段增删要同步 ENVIRONMENTS（#7 写入）与 `deploy/environments.json`。
5. **镜像与 compose**（计划中，#3、#7、#11、#17）：
   ```bash
   git diff origin/stage...HEAD -- 'app/*/Dockerfile*' deploy/compose .github/workflows/release.yml
   git diff origin/stage...HEAD -- 'app/*/Dockerfile*' deploy/compose | grep -nE 'privileged|cap_add|security_opt|seccomp|docker\.sock|devices|ports|network_mode|volumes|USER|HEALTHCHECK|ARG|ENV'
   docker compose -f deploy/compose/<file>.yml config   # 本机有 compose 时核对展开结果
   ```
   看：镜像只在 rc tag 上构建一次、正式只加别名；镜像不烘焙环境身份、域名或密钥；非 root、有 `HEALTHCHECK`；不挂 `docker.sock`；node 容器只挂 `/dev/kvm`、不 `privileged`、不发布端口；两套栈的 compose 项目、命名卷、端口不共用；命名卷没被换成宿主目录；`dockerfile:` 指向 `app/<service>/Dockerfile*`（node 另有 #17 的 `Dockerfile.vmimage`）、构建上下文是仓库根。
6. **测试与文档同步**：
   ```bash
   pnpm verify
   node scripts/docs-index.mjs --check
   node scripts/check-docs.mjs
   git diff origin/stage...HEAD --stat -- docs tests
   ```
   看真实验证证据（命令 + 输出），不是「本地通过」四个字；行为变更有对应回归（见 `docs/conventions/TESTING.md`）；改动的接口、环境变量、命令、路径已同步到 `docs/services/**`、根 `README.md`、`docs/ops/LOCAL-DEV.md`。
7. **边界规则**：
   ```bash
   pnpm check:boundaries
   pnpm check:boundaries   # runner 的 src/ 引用 src/ 以外的文件、导入 npm 包都会失败
   git diff origin/stage...HEAD -- 'tsconfig*.json' '**/tsconfig*.json' pnpm-workspace.yaml scripts/check-boundaries.mjs
   ls app packages; ls docs/services
   ```
   根目录的 `tsconfig.base.json`、`tsconfig.json` 要单独列 `'tsconfig*.json'`：`'**/tsconfig*.json'` 要求路径里有 `/`，匹配不到根目录的文件。新增 `app/<name>` 或 `packages/<name>` 必须同时有 `docs/services/<name>/README.md`；四个 app 互不导入；protocol 不导入 app；`app/runner/src`（runner 程序本身）不导入 npm 包、不引用 `src/` 以外的文件，`app/runner` 下 `src/` 以外的构建脚本不在此列；新增路径别名或改 `check-boundaries` 规则来放行导入即阻塞。
8. **提交信息规范**：`git log --format='%h %s' --no-merges origin/stage..HEAD`，按 `docs/conventions/COMMITS.md` 的 `<type>(<scope>): <中文简述>` 检查；一次提交一个可独立回滚的目的，不出现 `update`/`WIP`。
9. **写死实例信息与被禁字面量**：
   ```bash
   pnpm check:public-safety
   git diff origin/stage...HEAD | grep -nE '^\+' | grep -nE 'https?://|github\.com/|([0-9]{1,3}\.){3}[0-9]{1,3}|\.mesh\.'
   git diff origin/stage...HEAD -- scripts/public-safety-allow.json scripts/public-safety-denylist.json
   git diff origin/stage...HEAD -- app packages | grep -nE 'track v1|geek-bot v1'
   ```
   逐条核对新增的 URL、地址、账号名、组织名：只许占位符（`<owner>`、`<org>/<repo>`、`https://geek-bot.example.com`、`203.0.113.10`）；本组织 issue/PR 写 `#n`；允许清单新增条目逐条看理由；产品代码里的追踪记录头和产品标记只能是可配置默认值。再扫一遍发布模型：tag 只能是 `vX.Y.Z-rc.N` / `vX.Y.Z`，不得出现「push 分支即部署」、CI 经 SSH 部署、systemd、pm2 或手工 `node` 进程。
10. **危险操作与绕过 CI**：
    ```bash
    git diff origin/stage...HEAD | grep -nE '\|\| true|continue-on-error|\[skip ci\]|--no-verify|DROP (TABLE|COLUMN)|rm -rf'
    git diff origin/stage...HEAD -- 'tests/**' | grep -nE '^-.*(expect|assert)'
    git diff origin/stage...HEAD -- scripts .github/workflows .githooks
    ```
    看：迁移是否只扩不缩、有没有恢复路径；有没有删除数据、覆盖配置、顺带升级无关依赖、修改生产凭据；有没有删断言、改校验器、放宽既有校验换绿色；有没有「以测试通过代替人工验收」的表述。
11. **publisher 写入白名单**（实现计划中，#9；白名单文档 #2 写入）：
    ```bash
    git diff origin/stage...HEAD -- app/control/src/publisher docs/services/control
    git diff origin/stage...HEAD | grep -nE 'APPROVE|REQUEST_CHANGES|COMMENT|event|refs/tags|refs/heads|force|merge|\.github/workflows|DELETE|ALLOWLIST|allowlist'
    grep -rnE "method: *['\"](POST|PUT|PATCH|DELETE)['\"]" app/control/src | grep -v '/publisher/'
    ```
    任何放宽（新端点、新参数、新 event、新 ref 形状、新目标范围）按阻塞级审查：要有 issue、所有者批准和对应拒绝用例；review event 只能是字面量 `COMMENT`；publisher 以外出现 GitHub 写请求即阻塞。
12. **令牌 scope 变化**（计划中，#5、#6、#9）：
    ```bash
    git diff origin/stage...HEAD | grep -nE 'scope|X-OAuth-Scopes|read:org|read:user|workflow|admin:org|delete_repo|write:packages|admin:repo_hook'
    grep -rn 'decrypt' app/control/src | grep -v -e '/publisher/' -e '/secrets/' -e '/github/client\.ts:'
    ```
    `/secrets/` 是解密的实现处；`/github/client.ts` 是 GitHub 读取层的计划路径（[control 服务契约](../../../docs/services/control/README.md)「计划中的模块与对应 issue」，#6）。只排除读取客户端这一个文件，`src/github/` 下的其它文件（例如 #9 的 `markers.ts`）照样要查；#6 实际落地的路径不同时，同步改这条命令。申请的 scope 增加、拒绝名单删减或放宽，都要写明理由并有所有者批准；publisher 与 GitHub 读取层以外调用令牌解密即阻塞。
13. **执行环境不持有凭据**（计划中，#11、#14、#17）：
    ```bash
    git diff origin/stage...HEAD -- app/node app/runner deploy/compose | grep -nE 'environment|env|process\.env|fw_cfg|volumes|mount|docker\.sock|HOME|TOKEN|KEY|SECRET'
    ```
    有运行实例且获授权时，再看实际状态（只读）：`docker inspect <容器> --format '{{json .Config.Env}} {{json .Mounts}} {{.HostConfig.Privileged}} {{json .HostConfig.Devices}}'`。sandbox、VM、node 容器里不得有 GitHub 令牌、模型网关密钥或宿主凭据；只允许每任务中继令牌和节点令牌。
14. **仓库内容是不可信输入**（计划中，#10、#14、#15）：
    ```bash
    git diff origin/stage...HEAD | grep -nE 'AGENTS\.md|CLAUDE\.md|\.omp|\.claude|mcp\.json|geek-bot\.yml|prompt|system|body|title'
    git diff origin/stage...HEAD -- app/runner app/control/src/publisher
    ```
    看：规则文件只从 base 分支读，不从 PR head 读；issue/PR 正文、评论、代码只作为数据进入提示词，不改变规则、能力开关或写入目标；runner 的剔除清单（`.omp`、`.claude`、`mcp.json`、`.env*`）与干净 HOME 没被削弱；输出中和（注释标记、结论行、`Closes #n`、@ 他人）仍有测试。

## 输出格式

- 每条一行，四要素：`[严重度] 文件:行 — 理由（指向具体规则或真实后果）— 修法（可执行动作）`。
- 严重度只用 CODE-REVIEW.md 定义的三档：`阻塞`（破坏不变量、泄漏密钥、越权、数据不可恢复、把历史当现行规范——必须修完再合并）、`应修`（写明为何本次不修则可不阻塞）、`建议`。
- 结论只允许三种，逐字使用：**阻塞** / **有条件通过** / **通过**。不能写「基本没问题」「看起来可以」。
- 第 1–14 项逐项给出结果；不涉及的项写「不涉及」，不能省略。
- **未验证项必须显式列出**（例如没跑浏览器回归、没在预发布实例验证、没验证回滚、没在有 KVM 的机器上跑 VM 冒烟）。没验证就写「未验证」，不得写「应该没问题」。
- 审查记录必须写进 PR（描述或评论，不是聊天记录，也不写进被审查的提交本身），至少含：审查人、时间、被审查 commit SHA、逐条结论、最终结论。两种写法（CODE-REVIEW「审查记录位置」）各有模板，按写的位置选一个。
- 不论选哪种，PR 描述的 `### 审查结论` 段最后都要有 `**结论：…**` 行，`pr-contract` 只核对这一段（[PULL-REQUESTS](../../../docs/conventions/PULL-REQUESTS.md)「正文契约」）。

**写进 PR 描述**：放在 `### 审查结论` 段下，段内不另起标题（`pr-contract` 按 `### ` 标题切段）。

```md
### 审查结论

- 审查人：<name> · 时间：<YYYY-MM-DD HH:mm>
- 被审查 commit：<40 位 SHA> · 范围：`origin/stage...HEAD` · 目标分支：stage

[应修] `app/control/src/x.ts:42` — 理由… — 修法…
[建议] `app/console/src/y.ts:7` — 理由… — 修法…

逐项：1 通过；2 通过；3 通过；4 不涉及；…；11 不涉及；12 不涉及；13 不涉及；14 不涉及。

未验证项：未运行浏览器回归；未在预发布实例验证。

**结论：有条件通过**
```

**写成 PR 评论**：按 [TRACKING](../../../docs/conventions/TRACKING.md) §3 写成 `review` 追踪记录，第一行是记录头，第二行是类型和一句话结论（结论词逐字用三种之一）；审查人与时间由 GitHub 记录，不在正文里重复写。没有记录头的评论，Agent 恢复上下文时会被跳过（TRACKING §4）。

```md
<!-- track v1 kind=review stage=review -->
**审查**｜有条件通过：<一句话理由>

**现状**：
- 被审查 commit：<40 位 SHA> · 范围：`origin/stage...HEAD` · 目标分支：stage
- [应修] `app/control/src/x.ts:42` — 理由… — 修法…
- [建议] `app/console/src/y.ts:7` — 理由… — 修法…
- 逐项：1 通过；2 通过；3 通过；4 不涉及；…；11 不涉及；12 不涉及；13 不涉及；14 不涉及
**证据**：
- `pnpm verify`：<真实输出摘要>
- 未验证：未运行浏览器回归；未在预发布实例验证
**下一步**：作者修完应修项后在本 PR 发 `rework` 记录，审查人复查
**引用**：#<issue> · #<PR> · <被审查 commit SHA>
```

## 边界

- 默认只读：不改文件、不提交、不推送、不合并、不部署。用户明确要求「按审查意见修」时才动手，改完重新出结论。
- 审查通过不等于发版授权，也不能代替 [RELEASES](../../../docs/conventions/RELEASES.md) 要求的人工试用与发布批准。
