# ADR-0007：部署：ghcr 同一 digest 跨环境、目标机拉取式部署、CI 不部署

> rc tag 构建一次镜像推到 ghcr，正式 tag 只给同一 digest 加别名；维护者获授权后在目标机运行仓库里的部署脚本，按 digest 拉取、过健康门、失败自动回滚；CI 不连目标机。

状态：`proposed` · 更新：2026-09-26 · 适用：镜像、`release.yml`、`deploy/` 下的 compose 与部署和回滚脚本、preview 与 production 两套环境（由 #7 实现，正式环境上线见 #20）

## 背景

- 发版流程已由 [RELEASES](../conventions/RELEASES.md) 定下：`vX.Y.Z-rc.N` 打在 `stage` 的提交上发预发布，所有者验收后在同一提交上打 `vX.Y.Z` 发正式；正式实例运行的就是预发布验过的那个镜像 digest。本篇写的是镜像怎样构建、怎样到达目标机。
- env 模板只放占位符和通用默认值、密钥一律 `*_FILE` 的决定和理由已经写在 [ADR-0001](0001-standalone-product.md)（#22 第 3 项），本篇沿用，不重复。
- 目标机没有公网入站端口：第一台节点只在私有组网里可达，GitHub 托管的 runner 连不到它。免费计划的私有仓库没有 Environments，也就没有环境级 secrets 和部署审批（[CICD](../ops/CICD.md)）。
- 常见的做法是由 CI 经 SSH 推送部署。放在这里既连不上目标机，也要把高权限的 SSH 密钥放进 CI。
- Container registry 的镜像存储和流量目前免费，GitHub 承诺改变前至少提前一个月通知（[GitHub Packages 计费](https://docs.github.com/en/billing/concepts/product-billing/github-packages)，2026-09-26 核对）。

## 决策

### 镜像

- 三个镜像：`geek-bot-control`（内含 console 的构建产物，见 [ADR-0009](0009-tuffex-console.md)）、`geek-bot-node`（内含 runner、omp、qemu 和 sandbox 入口）、`geek-bot-vmimage`（VM 基础镜像的载体，见 [ADR-0004](0004-execution-isolation.md)）。
- 构建上下文是仓库根。control 与 node 镜像以非 root 运行、带 `HEALTHCHECK`，由 CI 断言；基础镜像按草案用 `node:22-bookworm-slim`，#3、#11 引入时核对。
- 镜像里不烘焙环境身份、域名或密钥；两个环境的差异只来自运行时 env 与 `*_FILE` 指向的密钥文件。

### 构建与发布：CI 只构建，不部署

- 发布 tag 触发 `release.yml`：
  - `vX.Y.Z-rc.N`：核对 tag 与版本号，跑校验，每个镜像构建一次，推 `ghcr.io/<owner>/<image>:<sha12>` 并加 rc 别名，再把 `release-manifest.json`（完整提交 SHA 与各镜像的 digest）附到 GitHub Release；
  - `vX.Y.Z`：核对同一提交已有同版本 rc 的镜像，只给同一 digest 加 `:vX.Y.Z` 别名，不重新构建。
- `release.yml` 只用 `GITHUB_TOKEN`，权限只给 `contents: read` 和 `packages: write`；做构建来源证明（artifact attestation）时再加 `id-token: write` 和 `attestations: write`，这是 GitHub 文档列出的所需权限（[Using artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)，2026-09-26 核对）；其余一律不给。它不写 `environment:`，不经 SSH 连任何机器，不持有部署凭据。

### 部署：维护者在目标机拉取

- 维护者获得所有者对这个版本、这个环境的授权后，在目标机运行 `deploy/remote/deploy-stack.sh --environment <env> --role control|node --version <tag>`。脚本依次：
  1. 用 flock 串行，同一环境同一时间只允许一次部署；
  2. 校验 env 字段契约，以及密钥文件的权限和属主，不打印值；
  3. 按 manifest 里的 digest 执行 `docker pull`；
  4. 部署 control 前先备份数据库；
  5. `docker compose --env-file .env.<env> -p geek-bot-<env> up -d`；
  6. 健康门：`/readyz` 连续 3 次返回 200；有同机节点时，60 秒内要看到节点心跳。`/readyz` 的就绪条件见 [API](../architecture/API.md) A-54，按兼容版本判断，回滚到上一版镜像时同样能过（[ADR-0008](0008-sqlite-migrations-recovery.md)）；
  7. 健康门不过，自动回滚到上一组 digest；
  8. 追加一行部署历史。
- 运行仓库里有版本的部署脚本，是改变运行中的栈的唯一合法途径；手工改容器或 compose 属于「在目标机手工修改运行中的栈」，禁止（[AGENTS](../../AGENTS.md) §3）。
- 回滚：`deploy/remote/rollback-stack.sh --to previous|<version>`，从部署历史查到 digest 后切换，不动数据卷。数据库结构不兼容时停下来由人处理，不用重置数据库代替回滚（迁移只扩不缩，见 [ADR-0008](0008-sqlite-migrations-recovery.md)；回滚规则见 [RELEASES](../conventions/RELEASES.md)「回滚」）。
- 部署 production 时，脚本先核对部署历史：要部署的这组 digest 必须是 preview 上部署过、被验收的那一组，不一致就拒绝（#20）。不要求 preview 此刻还在运行，preview 栈平时可以关着。验收本身以所有者的验收记录为准，脚本只核对 digest。
- v1 由所有者或获授权的维护者执行部署脚本；AI 只有在每一次得到明确授权后才可以代为执行（#22 第 10 项），任何情况下不自行部署、不打 tag。
- 仓库私有期间，目标机用一枚只有 `read:packages`、设了过期时间的令牌登录 ghcr 拉取镜像；这枚令牌只在宿主的 docker 配置里。

### 环境

- `production` 与 `preview` 是两套完全独立的控制面栈：compose 项目、网络、命名卷、端口、OAuth App、master key、会话签名密钥、备份加密密钥、节点令牌各自一套。每台工作主机另有 node 栈。
- env 文件仍然只有 `deploy/env/.env.production` 与 `deploy/env/.env.preview` 两份，node 栈的字段也写在里面，不另建环境文件。
- 两个环境可以共用同一个机器人账号，但授权是两枚不同的令牌（[ADR-0002](0002-github-identity.md)）。preview 的 publisher 只写所有者新建的沙盒仓库（例如 `<org>/geek_bot-sandbox`），production 自动排除这些仓库；preview 栈只在验收期间开启，平时 vm 槽位为 0（#22 第 9 项）。

### 第一台节点的宿主前置条件

下面每一项都要所有者单独批准，都能回退，都不需要系统全量升级（#22 第 7 项）。操作步骤写进 HOST-PREREQS（#7 写入）。

1. 安装 Docker Compose v2 的静态插件，并校验 sha256；
2. 用只读令牌登录 ghcr（只在仓库私有期间需要）；
3. 建两个环境的栈目录和密钥目录（目录权限 0700），实际路径只写在目标机上；
4. 数据卷和 VM 工作目录放在不进文件系统快照的独立子卷上；
5. 开启 `net.ipv4.ip_nonlocal_bind=1`，让 control 能绑定私有组网的地址；不批准这一项时，后台只绑回环地址，经 SSH 隧道访问；
6. 开 vm 槽位之前，先满足第一台节点的宿主条件（见运维记录）。

不装 incus，不改防火墙和转发规则，不改 Docker 守护进程配置，不改 subuid。

## 替代方案

- **CI 经 SSH 推送部署的工作流**：目标机没有入站端口，免费计划的私有仓库也没有 Environments，做不到。
- **CI runner 用临时的组网加入密钥入网后经 SSH 部署**：多一枚高权限密钥进 CI；留待以后评估。
- **栈内拉取式部署器**（轮询 Release manifest，自己过健康门）：能恢复自动闭环，作为 v1 之后的增强。
- **把 `docker save` 的归档作为 Release 附件**：体积大；ghcr 目前免费，更合适。
- **正式 tag 重新构建，或按环境分别构建**：正式环境跑的就不是预发布验过的那组字节。
- **在目标机上临时构建**：不可复现，还要在宿主装构建工具链；[RELEASES](../conventions/RELEASES.md) 已禁止在服务器上临时构建。
- **按可变 tag（例如 `latest`）部署**：保证不了两个环境跑的是同一组字节。
- **部署 production 时要求 preview 此刻仍在运行同一 digest**（前一版写法）：preview 栈平时关着（#22 第 9 项），这条会逼着为了发正式版重开 preview；要核对的其实是「验收过的就是这组 digest」，部署历史足以证明。

## 后果

- 没有自动部署：每次部署都要人授权、人执行，比推送即部署慢。脚本的串行锁、契约校验、健康门和自动回滚用来减少人为失误。
- CI 只持有 `GITHUB_TOKEN`；目标机在仓库私有期间持有一枚只读的 packages 令牌。
- 回滚很快（换 digest），前提是数据库兼容；迁移只扩不缩保证上一版镜像能读库。
- ghcr 的免费政策变化时要重新评估。仓库公开后镜像也可以公开，拉取不再需要令牌。
- preview 与 production 共用一个机器人账号，互斥全靠 publisher 的仓库白名单；配错就会在真实仓库重复写入（#9 用测试覆盖）。
- 两套栈加 VM 放在同一台机器上时资源很紧。「preview 只在验收期间开、平时 vm=0」要严格执行，否则会挤占 production。
- control 绑定私有组网地址依赖宿主参数；组网接口与 Docker 谁先启动的问题，要在 #7 用一次重启实测。私网明文模式下会话 cookie 没有 `Secure` 属性，保密性依赖组网本身的加密。

## 实施状态

本篇只是设计，还没有代码。

- #3：control 镜像的 Dockerfile、`/readyz`、备份命令。
- #7：`release.yml`、compose、env 模板、部署与回滚脚本、DEPLOY、ENVIRONMENTS、HOST-PREREQS；在第一台节点上跑起 preview 栈。
- #11：node 镜像与 node 栈。
- #17：`geek-bot-vmimage`。
- #20：production 上线、按部署历史核对「production 要部署的就是 preview 验收过的那组 digest」、RUNBOOK。

## 重新评估条件

- 仓库公开或升级计划后，Environments 与部署审批可用；
- 目标机有了公网入站，或出现可信的部署通道；
- ghcr 的计费政策改变；
- 需要自动部署（栈内部署器）。

## 所有者结论

待定：在 #2 的 PR 上给出。推荐按本 ADR 执行（对应 #22 第 10 项；preview 的用法对应第 9 项；第一台节点的宿主改动对应第 7 项）。

- env 模板只放占位符（第 3 项）已经写在 [ADR-0001](0001-standalone-product.md)，本篇不重复；所有者对第 3 项没有提出修改（#22 的第二条评论），逐字的明确确认补在 #2 的 PR 上（见 ADR-0001）。
- 第 7 项的每一项宿主改动都要所有者单独批准；本 ADR 被接受不等于这些改动获批。
- 第 9 项的沙盒仓库要由所有者创建。
- 所有者 2026-09-25 回复 #22 时只改了第 4 项，对第 7、9、10 项没有提出修改（记在 #22 的第二条评论里）。
