# 发布与人工验收规范

> 发版只靠打 tag：`vX.Y.Z-rc.N` 打在 `stage` 的提交上发预发布，所有者在预发布验收通过后，在同一提交上打 `vX.Y.Z` 发正式。tag 不可移动、不可删除，版本号不自动提升；正式实例运行的就是预发布验过的那个镜像 digest。

状态：`current` · 更新：2026-09-26 · 适用：本仓库的发布 tag、版本号、镜像与预发布 / 正式实例 · 依据：[ADR-0001](../decisions/0001-standalone-product.md)（独立产品，env 模板只放占位符）；部署方式是 ghcr 同一 digest 加目标机拉取，详细决策见 [ADR-0007](../decisions/0007-ghcr-pull-deploy.md)。分支规则见 [BRANCHING](BRANCHING.md)。

本文中标「计划中」的部分（release.yml、部署与回滚脚本、compose、env 模板、发布规划器、版本接口）还不存在，分别由 #3、#7、#11、#17、#20 实现；tag 格式、授权门禁、rc 编号、版本号与 tag 不可变这些规则现在就生效。

## 发布模型：tag 驱动

| tag | 形状 | 打在哪里 | 触发的工作流 | 镜像 | 部署到 | 展示版本 |
|---|---|---|---|---|---|---|
| 预发布 | `vX.Y.Z-rc.N`（N 从 1 开始） | `stage` 上的提交（`origin/stage` 或它的祖先） | `release.yml`（计划中，#7） | 构建一次，推 `ghcr.io/<owner>/<image>:<sha12>`，再加 `:vX.Y.Z-rc.N` 别名（`<image>` 见表下说明） | 预发布实例：维护者获授权后在目标机运行部署脚本（计划中，#7） | `X.Y.Z-rc.N@<sha12>` |
| 正式 | `vX.Y.Z` | `main` 上的提交，且这个提交上已经有同一 `X.Y.Z` 的 rc tag | `release.yml`（计划中，#7） | 不重新构建：核对同一提交已有 rc 镜像后，给同一 digest 加 `:vX.Y.Z` 别名 | 正式实例：同上（计划中，#20） | `X.Y.Z` |

`<image>` 是 [services](../services/README.md) 里定的镜像名 `geek-bot-control`、`geek-bot-node`、`geek-bot-vmimage`，完整引用形如 `ghcr.io/<owner>/geek-bot-control:<sha12>`；`<owner>` 是本仓库的所有者（GitHub 用户或组织），文档里不写死。推送由 #7 的 `release.yml` 按这个形式实现；要改形式，同步改本文与 [CODE-REVIEW](CODE-REVIEW.md) 第 5 项。

发布 tag 的唯一正则（与 `scripts/release-tags.mjs` 的 `RELEASE_TAG_RE` 逐字一致，`tests/tooling/release-tags.test.ts` 核对两处相同）：

`^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-rc\.([1-9]\d*))?$`

- `X.Y.Z` 必须等于**该提交里**根 `package.json` 的 `version`（不看工作区）。
- push `stage` / `main` 只跑 CI，**不部署任何环境**。
- **没有自动部署。** 发布 tag 只触发构建和推镜像；部署一律由维护者获所有者授权后，在目标机手工运行部署脚本完成。CI 不经 SSH 连目标机，不持有部署凭据。
- 其它 tag 不触发任何构建或部署。

## 发布流程

1. `task/<issue>/<slug>` 经 [CODE-REVIEW](CODE-REVIEW.md) 合入 `stage`。
2. 这次要发的版本号还没写进 `package.json` 时，先按下文「版本号」开一个普通 task PR 改 `version`，同样合入 `stage`。
3. 所有者授权发布这个预发布版本后，维护者在 `stage` 的提交上打 rc tag 并推送：

   ```bash
   git fetch origin --tags && git switch stage && git pull --ff-only
   git tag -a v0.2.0-rc.1 -m "v0.2.0-rc.1" <stage 上的 40 位提交 SHA>
   git push origin v0.2.0-rc.1
   ```

4. `release.yml` 核对 tag、版本号与「提交在 `origin/stage` 上」，把各镜像构建一次并推到 ghcr，在发布记录里写下每个镜像的 digest（计划中，#7）。
5. 所有者授权部署这个 rc 后，维护者在目标机运行部署脚本，按 digest 拉取并部署到预发布实例；健康检查失败时脚本自动回滚（计划中，#7）。
6. 所有者在预发布实例实际试用这个 rc 的产物，按 [RELEASE-ACCEPTANCE-TEMPLATE](../ops/RELEASE-ACCEPTANCE-TEMPLATE.md) 记录结论。不通过就在 `stage` 上修复，打下一个 `rc.N+1`，回到第 4 步。
7. 验收通过后，维护者把 `main` 快进到被验收的那个提交（只允许快进；push `main` 只跑 CI，不部署）：

   ```bash
   git switch main && git merge --ff-only v0.2.0-rc.1 && git push origin main
   ```

8. 所有者授权正式发布后，在**同一提交**上打正式 tag 并推送：

   ```bash
   git tag -a v0.2.0 -m "v0.2.0" "v0.2.0-rc.1^{commit}"
   git push origin v0.2.0
   ```

9. `release.yml` 核对同一提交已有同版本 rc 的镜像，只给同一 digest 加 `:v0.2.0` 别名，不重新构建（计划中，#7）。
10. 所有者授权部署正式实例后，维护者在目标机运行部署脚本。脚本先核对部署历史：预发布实例部署并验收过的正是这组 digest，不是就拒绝部署；不要求预发布实例此刻还在运行（计划中，#20，见 [ADR-0007](../decisions/0007-ghcr-pull-deploy.md)）。

## 授权门禁

- **打 tag 就是发版。** 创建并推送任何发布 tag，都需要所有者对**这个版本号**的明确授权。「继续」「测试都过了」「CI 全绿」都不算授权。Agent 不得自行创建或推送发布 tag。
- **部署也要单独授权。** 在目标机运行部署或回滚脚本，需要所有者对这个版本、这个环境的明确授权。Agent 不得自行部署。
- 打正式 tag 还需要所有者在预发布实例对**同一提交**的验收记录，放行结论写明「批准发布」。
- 代码审查结论、CI 全绿、镜像推送成功、预发布部署成功、发布规划器（`release:plan`，随 #7 加入）的输出，都不构成授权。

## rc 编号

- 每个 `X.Y.Z` 的 rc 从 `rc.1` 开始按顺序递增，已推送的编号不复用。一次只推一个发布 tag（一次推送超过三个 tag 时 GitHub 不触发工作流）。
- 内容有任何变化都要打新的 rc。同一个 rc 需要重新部署时，在目标机对同一 digest 重新运行部署脚本，不重新构建。只有这个 tag 的构建没有触发、或没有成功推出镜像时，才手工运行 `release.yml`：「Use workflow from」选这个 tag，输入框里也填这个 tag（计划中，#7）。前提是 `release.yml` 已经进入 `main`（GitHub 只对默认分支上的工作流提供手工运行入口，见 [CICD](../ops/CICD.md)「触发与职责」）；第一个正式版之前没有这个入口，处理办法由 #7 写明。已经推出镜像的 rc 不再重新构建，否则它的别名会指向另一个 digest。不要为了重新部署或重新构建而新建或移动 tag。
- 某个版本打过正式 tag 后，不能再给它打 rc。下一次发版先升 `version`。
- 正式 tag 必须和其中一个 rc 落在同一提交上，而且部署历史里要有预发布实例部署并验收过这个提交的 digest 的记录（部署脚本核对，计划中，#20）；预发布实例平时可以关着，之后又部署过别的 rc 也不影响，只要被验收的那组 digest 有记录。

## 版本号

- `package.json` 的 `version` 何时改、改成多少，由所有者决定。修改走普通 task PR（先开 issue、经审查合入 `stage`），合入以后才能打这个版本的 rc。版本号按 SemVer 2.0.0 选择升哪一位。
- 禁止 semantic-release、版本机器人或按 commit type 推算版本的脚本；`feat`/`fix` 提交消息不是发版许可。工作流不会改版本号，也不会打 tag。
- 工作区各包的 `version` 不单独发版，展示版本只看根 `package.json`。

## 节点版本

- 节点能不能接任务只看节点协议版本（整数，定义见 [protocol 服务契约](../services/protocol/README.md)），不看发布版本号：control 支持协议版本 N 与 N-1；节点的协议版本不在这个范围内时，control 只收它的心跳、不给它派任务，后台把它标为需要升级（计划中，#11）。
- 升级顺序先 control 后节点：先升级实例的 control，再逐台升级节点；多节点的滚动升级流程由 #19 写入。

## 展示值与发布身份

- 界面显示的版本来自发布 tag 与提交：
  - 正式实例：`X.Y.Z`（禁止任何后缀）；
  - 预发布实例：`X.Y.Z-rc.N@<sha12>`（`<sha12>` 是提交 SHA 前 12 位）；
  - 本机：明确标记「本地开发 · 未发布」。
- 展示值由部署脚本写入运行时环境，control 通过版本接口返回，后台页脚显示（计划中，#7）；不从 `NODE_ENV` 猜环境，也不按环境分别构建镜像。组合规则：`-rc.N` 只能和 `@<sha12>` 一起出现且只用于预发布，正式只能是 `X.Y.Z`，`<sha12>` 必须等于提交前 12 位。
- 镜像 tag 是提交的 `<sha12>`，另有发布 tag 别名；部署以 digest（`@sha256:…`）为准，不以可变的 tag 为准。镜像 tag 标识代码，发布 tag 标识一次发版。
- **两个环境运行同一个 digest。** 镜像里不含环境身份、域名或密钥；预发布与正式的差异只来自运行时 env 与 `*_FILE` 指向的密钥文件。正式实例运行的就是预发布验过的那个 digest，不为正式环境重新构建。
- 展示值只是构建身份，不是人工验收的证据，也不能当作发布凭据。

## 人工验收先于正式 tag

人工验收针对**某个 rc tag 所在提交的产物**，不是对 `stage` 整条分支的一次性放行。正式部署的授权不能替代预发布试用。

### 验收记录至少包含

验收人、时间（ISO 8601 含时区）、目标环境（`preview` / `production`）、被验收的 rc tag、完整提交 SHA（40 位小写十六进制）、被试用产物的镜像 digest、试用范围与结果（实际点击或操作了什么、观察到什么）、已知问题、回滚对象、明确的放行结论（批准或不批准）、可追溯的审批记录链接。模板见 [RELEASE-ACCEPTANCE-TEMPLATE](../ops/RELEASE-ACCEPTANCE-TEMPLATE.md)。

Agent 可以整理候选改动、测试结果、差异和空白模板，**不能替验收人填写「已试用」**，不能伪造审批人或时间，不能靠 `approved=true`、环境变量或改校验器解除门禁。Git 作者名称、提交邮箱、签名或手填 JSON 都不能单独证明有人实际验收。

验收记录保存在能追溯到验收人本人的记录里（所有者本人在 issue 或 PR 里的评论、审批工单等）。**不要为了把记录写进候选提交而制造自引用**：在候选提交之后再追加一个引用它的验收文件会产生新提交，新提交不能冒用旧验收。

## 环境与入口绑定

| 环境 | 提交所在分支 | 运行的镜像 | 入口 | 栈 |
|---|---|---|---|---|
| `preview` | `stage` | rc 的 digest | `<preview-origin>`（例：`https://preview.geek-bot.example.com`） | 目标机上的预发布控制面栈 |
| `production` | `main` | 与被验收的 rc 相同的 digest | `<production-origin>`（例：`https://geek-bot.example.com`） | 目标机上的正式控制面栈 |

「提交所在分支」是发布 tag 必须打在哪条分支的提交上：rc tag 对应 `stage`，正式 tag 对应 `main`。分支本身的推送不触发部署。

- 两套栈完全隔离：独立目录、独立 compose 项目、独立命名卷、独立端口、独立密钥、独立入口。栈目录、真实域名和端口由部署者决定，只写在目标机的 `.env.<环境>` 里，仓库模板只放占位符（计划中，#7）。节点另有一套 node 栈（#11 引入），加入哪个实例由部署者配置。
- Cookie 使用 host-only（不写 `Domain`），两个环境不共享父域 Cookie。
- 预发布实例不得写真实仓库：它的 publisher 只允许写配置的沙盒仓库，或者设为只演练不写（publisher 只记录、不发送）。预发布实例可以和正式实例共用同一个机器人账号，但用独立的 OAuth App 与独立授权，两边的令牌互不通用（计划中，#7、#9）。
- 本机 `localhost` 只能标为 local / 未发布，绝不能标成已在预发布实例试用。
- 配置细节由 ENVIRONMENTS（#7 写入）说明，部署操作由 DEPLOY（#7 写入）说明。

## 回滚

回滚是把某个环境切回一个**更早发布 tag 的镜像 digest**。不移动分支，不移动、删除或重打 tag，不改版本号，不重置数据库：

1. 选定该环境此前部署成功过的发布 tag（正式环境即更早的 `vX.Y.Z`），从部署历史记录里查到它的 digest（计划中，#7）；
2. 在目标机运行回滚脚本 `deploy/remote/rollback-stack.sh`（计划中，#7），把本环境切回该 digest 并重新起栈；
3. 数据库结构不兼容时停下来由人处理，不用重置数据库代替回滚（迁移只扩不缩，保证上一版镜像仍能读库，见 ADR-0008；迁移器从 #3 起强制结构上能查的部分，语义上的收缩靠审查，见 [data-model](../services/control/data-model.md)「迁移规则」）；目标 digest 在本机已被清理时，从 ghcr 按 digest 重新拉取，不在服务器上临时构建。

回滚之后的修复走新的 rc（必要时先升版本号），不改写已发布的 tag。同一环境同一时刻只允许一个部署任务（串行锁）；正式环境部署不得在切换过程中被新任务打断。

## tag 不可变

- 发布 tag 一经推送就不移动、不覆盖、不删除重建。打错了（提交不对、版本号不对）就打下一个 rc 或升版本，已推送的错误 tag 保留作记录。
- 本地 pre-push 守卫（`.githooks/pre-push` 调用 `scripts/check-branch-invariants.mjs --push`，用 `pnpm hooks:enable` 启用）拒绝删除和强制移动发布 tag。GitHub 的 tag 保护（rulesets）在当前计划下不可用（见 [CICD](../ops/CICD.md)），所以这条规则目前只有本地 pre-push 钩子和流程约束，**没有服务端强制**；工作流对发布 tag 的核对随 `release.yml`（#7）加入，加入之前推 tag 不要跳过本地钩子（不用 `--no-verify`）。
- ghcr 上的发布 tag 别名同样不移动：同一个 `vX.Y.Z-rc.N` 或 `vX.Y.Z` 别名只指向一个 digest（计划中，#7）。

## 实现与核验边界

- tag 语法与相关的 Git 查询只在 `scripts/release-tags.mjs` 实现，`scripts/check-branch-invariants.mjs` 引用它：CI 的分支守卫用 `--require-remote-refs`，本地 pre-push 用 `--push`。它只读 Git 证据，不 fetch、不改 refs、不创建 tag。
- 发布规划器（`release:plan`，随 #7 加入）是只读的：核对 tag 格式、tag 指向传入的提交、`X.Y.Z` 等于该提交的 `package.json` `version`、rc 提交在 `stage` 上且该版本还没有正式 tag、正式提交在 `main` 上且同一提交有同版本的 rc tag，并给出 ghcr 镜像引用。输出里 `deploymentAuthorized` 恒为 `false`。它不创建 tag、不写文件、不连服务器，也不证明人工批准；拒绝分支名、`latest`、短 SHA 与格式错误的 tag。
- 「正式复用 rc 的 digest」由 `release.yml` 核对（计划中，#7）；「预发布实例验收过同一 digest」由部署脚本按部署历史在目标机核对（计划中，#20）。
- **规范不等于远程保护已启用**：GitHub 计划能力需维护者实测确认（见 [CICD](../ops/CICD.md)）。
- 机器检查（`pnpm verify`、CI 全绿、构建成功、规划器输出）**不构成**人工验收记录，也不授权任何部署或发版动作。
- `deploy/environments.json`（计划中，#7）只保存环境身份，不写真实域名；发布 tag 规则只在 `scripts/release-tags.mjs` 实现，不在别处复制第二份。
