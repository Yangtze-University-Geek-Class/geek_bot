# ADR-0004：执行隔离：issue 通道用独立无网 sandbox 容器，PR 通道用节点容器内的 QEMU/KVM 一次性 VM

> 只读代码的 issue 任务在无网、根只读、不挂令牌的独立容器里跑；要执行代码的 PR 任务每个一台新的 QEMU/KVM 临时 VM，结束即删；方案以 #12 的实测为准，不通过时按退路改选。

状态：`accepted` · 更新：2026-09-26 · 适用：`app/node` 的 sandbox 与 VM 执行器、`app/runner` 的运行环境、node 栈的容器配置（由 #12 实测，#14、#17 实现）

## 背景

- 所有者定下的规则（默认值见 [control 服务契约](../services/control/README.md)「计划中的默认行为」）：issue 通道不开 VM，omp 只读代码、不执行代码；PR 通道（审查、修复、返工）每个任务一台新的临时 VM，结束即销毁；单台 VM 规格 1 vCPU / 2 GiB。这个规格的依据是所有者早先在第一台节点上的实测：一个中等规模 pnpm 仓库的完整校验用时 179 秒，内存峰值 1.36 GB。
- 目标仓库的一切内容都是不可信输入（[SECURITY](../architecture/SECURITY.md) S-05）。omp 会自动加载工作目录里的 `AGENTS.md`，仓库里的 `.omp/` hooks、扩展和 MCP 配置也会被自动加载；宿主的用户级规则曾经漏进 omp 的回复（S-04）。
- node 容器以非 root、去掉全部 capability、no-new-privileges 运行，进程没有切换 uid 的能力；同一容器里的进程还能读到节点令牌文件。
- 部署只用 Docker（[AGENTS](../../AGENTS.md) §3）。宿主改动要所有者逐项批准；推荐方案不做系统全量升级、不改防火墙转发规则、不装 incus（#22 第 6、7 项）。

## 决策

### issue 通道：独立的 sandbox 容器

- 每个 sandbox 槽位一个独立容器（node 镜像的另一个入口），与 node 在同一个 compose 项目里：`network_mode: none`、根只读、tmpfs 工作目录、`cap_drop: ALL`、no-new-privileges、非 root，限制内存、CPU 和进程数，不挂任何令牌文件。
- 它只通过共享卷里的 unix socket 访问 node 的任务端点（取任务、回传事件、访问模型代理）。
- omp 只给 `read,grep,glob`，不给 bash，不执行仓库代码。
- 每个任务结束后容器退出，由 restart 策略重建，状态清空。
- 规则画像的提取任务也在这里跑。

### PR 通道：node 容器里的一次性 QEMU/KVM VM

- node 容器里的 qemu，每个任务一台：`-enable-kvm`，默认 `-smp 1 -m 2048`（规格取自 `GEEK_BOT_VM_VCPUS`、`GEEK_BOT_VM_MEMORY_MIB`，默认值在 `app/control/src/config.ts`）；qcow2 overlay 叠在只读的基础镜像上，任务结束删除 overlay 和临时磁盘。
- `-sandbox on,obsolete=deny,elevateprivileges=deny,resourcecontrol=deny`；不禁 spawn，因为 guestfwd 要起进程。（**这一句已被 [ADR-0011](0011-qemu-sandbox-elevateprivileges.md) 取代**：#12 实测 `elevateprivileges=deny` 会让 guestfwd 的转发进程起不来，改为不带这一项、由 node 容器兜底。）
- 网络：`-netdev user,restrict=on`，只加两条 guestfwd，一条到节点的本地模型代理，一条到出网 CONNECT 代理。按 QEMU 文档，restrict=on 时来宾访问不到宿主和外网，只能走显式配置的转发（[QEMU Invocation](https://www.qemu.org/docs/master/system/invocation.html)，登记在 [REFERENCES](../conventions/REFERENCES.md)）。
- 任务输入是只读原始盘上的 tar，产物写到可写原始盘上的 tar，实时事件走 virtio-serial。这样少依赖 guestfwd「每个连接起一个进程」的转发。
- 任务令牌经 `-fw_cfg name=opt/geekbot/token,file=<0600 临时文件>` 传入，不进 qemu 的命令行参数。
- 出网代理：默认只放包管理源，**不放** GitHub 的域名，免得 VM 里的代码直接把私有仓库推到或传到 GitHub。域名清单只在 [SECURITY](../architecture/SECURITY.md) 维护（S-03、S-14），本篇不另列。代理在域名解析后拒绝私网、CGNAT、链路本地、回环等地址（完整范围见 S-14），每个任务限制连接数和字节数。
- 出网白名单只能限制从哪里下载，挡不住借允许的包源把代码外传（SECURITY 残余风险）。全局白名单只能由 owner 重新认证后扩大，仓库层只能缩小（S-09、S-14）。
- VM 里是干净的 HOME。omp 用 `--no-extensions`、`--no-lsp`、`--tools` 白名单、`--approval-mode yolo`；overlay 关闭更新检查、memory、web_search、github 和 browser 工具，并设 `mcp.enableProjectConfig: false`。
- VM 里没有任何 GitHub 凭据。修复结果以补丁带回，由 control 提交和推送（[ADR-0003](0003-single-writer-control.md)）。
- 基础镜像：优先在 CI 里用钉死的输入构建（cloud 镜像地址加 sha512、Node 22、pnpm、git、按 SHA256SUMS 校验的 omp、runner），装进 `geek-bot-vmimage` 载体镜像推到 ghcr，再由 node 栈里的一次性容器拷进基础镜像卷后退出。#12 证明 CI 构建不可行时，退回在节点本地构建。
- 依赖缓存：每个节点维护一份只读的 pnpm store 缓存盘，按锁文件哈希预热，以只读方式挂进 VM，减少每个任务重新下载。这是推断，未验证，由 #12 实测。

### node 容器

- 非 root；`devices: /dev/kvm`，`group_add` 宿主 kvm 组的 gid；不挂 docker.sock，不挂 incus socket，不用 privileged，不为放宽隔离新增 capability 或关闭 seccomp；不发布端口（[CODE-REVIEW](../conventions/CODE-REVIEW.md) 第 5 项）。
- 任何一台宿主上 `/dev/kvm` 的现有权限都不能作为通用前提，node 容器只靠 `group_add` 取得访问权。第一台节点的宿主条件见运维记录。
- vm 槽位默认 0（节点配置 `GEEK_BOT_NODE_VM_SLOTS`），#12 实测通过后由部署者显式打开。

### control

- control 永远不运行 omp，也不执行目标仓库里的任何代码。

### VM 就绪之前的过渡

- #17 完成之前，PR 审查可以先在只读 sandbox 里上线（#22 第 5 项）：只读工具，不执行代码；#17 完成后切回 VM。第一个可见里程碑 #15 因此不必等 VM。
- 过渡期的审查任务要有自己的只读工具白名单，不能沿用 runner 目前 PR 通道不带 `--tools` 的参数（[runner 服务契约](../services/runner/README.md)「已知限制」）。

### 以 #12 实测为准，不通过时的退路

#12 要实测这几条核心假设：

- restrict=on 加 guestfwd 的隔离与吞吐；
- 纯 QEMU 能否引导 cloud 镜像；
- Docker 默认 seccomp 下能否使用 `/dev/kvm`；
- omp（约 0.6 GB）加一次完整校验（约 1.36 GB）在 2 GiB 里会不会 OOM；
- 每个任务重新安装依赖要多久。

任何一项不通过时，按下面的顺序改选，并另写 ADR 取代本篇：

1. **passt**：把 VM 的用户态网络后端换成 passt，其余（node 容器里的 qemu、原始盘 tar、fw_cfg、出网代理）不变。
2. **宿主 incus 临时 VM**：只在 passt 也不通过时考虑。它需要宿主全量升级、持久化的转发规则和 `network_mode: host`，incus 在 Docker 之外运行；每一项宿主改动都要所有者单独批准。

1 vCPU / 2 GiB 只是默认值：#12 实测不够用时，改的是默认规格，不是本决策。

## 替代方案

- **宿主 incus 临时 VM 作为主方案**：需要全量升级、持久化转发规则、`network_mode: host`；incus 在 Docker 之外运行，与「只用 Docker」冲突；它的 ACL 能否拦住「实例到宿主」方向没有验证。只保留为最后一条退路。
- **sandbox 放在 node 容器里、用不同 uid 隔开**：去掉全部 capability 后切换不了 uid，而且同一容器能读到节点令牌。
- **PR 通道用 Docker 容器代替 VM**：与所有者「每个任务一台新临时 VM」的规则不符；PR 通道要执行仓库代码，与宿主共享内核的隔离更弱。
- **一开始就用 passt**：QEMU 自带的用户态网络加 restrict=on 不需要额外组件，先实测它，不通过再换。
- **PR 审查一直留在 sandbox 里**：跑不了仓库自己的校验命令，只适合 VM 就绪之前过渡。

## 后果

- PR 通道要求节点宿主有 KVM；没有 KVM 的宿主只能开 sandbox 槽位。
- 每台 VM 占 1 vCPU / 2 GiB，另有冷启动和依赖安装的时间（未验证，#12 实测）。节点按 vCPU 和内存预算算 vm 槽位数，主机健康越线时临时视为 0（调度见 [ARCHITECTURE](../architecture/ARCHITECTURE.md)）。
- 出网默认不放 GitHub：要从 GitHub 拉依赖的仓库装不上依赖。放开要由 owner 重新认证后把域名加进全局出网白名单（写审计），这会重新打开把私有代码传到 GitHub 的口子；仓库层的配置只能缩小白名单，不能替自己放开。
- 私有仓库的代码会随任务流到节点宿主和模型网关。私有仓库默认只派给信任等级高的节点；信任等级配错，就会把私有代码派给不受信的节点。
- 残余风险：qemu 或 KVM 逃逸；`--no-extensions` 能否挡住仓库里的 `.omp/` hooks 没有验证，现在靠剔除文件、无网容器和 VM 三层兜底（[SECURITY](../architecture/SECURITY.md)）。

## 实施状态

本篇只是设计，还没有代码。

- #12（2026-09-26 实测，数据见 [VM 可行性实测](../services/node/vm-feasibility.md)）：
  - 非 root、cap_drop ALL、no-new-privileges、默认 seccomp 的容器里能用 `/dev/kvm`（这台宿主 `/dev/kvm` 的现有权限比 kvm 组宽，「只靠 group_add 就够」没有被证明）；
  - 纯 QEMU 引导 Debian 12 cloud 镜像，10.5–13.1 秒到 runner 就绪；
  - restrict=on 加一条 guestfwd 时，来宾直连宿主、私网、元数据地址和 IPv6 全部不通；
  - 出网代理按 S-03、S-14 放行与拒绝；
  - 1 vCPU / 2 GiB 对本仓库跑完整的 `pnpm verify`，内存峰值 896–944 MiB，没有 OOM；宿主的 filter、nat 与 FORWARD 规则前后没变（raw 表与 incus 表的差异来自 Docker 自动加的容器规则和宿主上的其它程序，见实测报告）。
  - 与本篇不符的一处：QEMU 7.2 上 `-sandbox` 的 `elevateprivileges=deny` 会让 guestfwd 的 `cmd:` 转发进程起不来。所有者 2026-09-26 决定去掉这一项、由容器的 cap_drop ALL 与 no-new-privileges 兜底，写成 [ADR-0011](0011-qemu-sandbox-elevateprivileges.md)。
  - omp、恶意夹具、只读缓存盘、passt、CI 构建基础镜像这一轮没有覆盖，随 #17 补测。
- #11：node 容器（非 root、只挂 `/dev/kvm`、不开端口）。
- #14：sandbox 执行器、runner、事件打码。
- #15：VM 就绪前在只读 sandbox 里审查的过渡。
- #17：QEMU/KVM 执行器、出网代理、VM 基础镜像、泄漏回收，以及 PR 通道的工具白名单。

## 重新评估条件

- #12 有任何一项核心假设不通过；
- QEMU 或 KVM 出现影响本方案的漏洞；
- 所有者改变「PR 通道每个任务一台临时 VM」或「issue 通道不执行代码」的规则。

## 所有者结论

接受：所有者 2026-09-26 答复「ADR 全部接受」，记在 #25。按本 ADR 执行（对应 #22 第 6 项；VM 就绪前 PR 审查先在只读 sandbox 上线对应第 5 项）。

- 所有者 2026-09-25 回复 #22 时只改了第 4 项，对第 5、6 项没有提出修改（记在 #22 的第二条评论里）。
- 第 7 项的宿主改动不因本 ADR 获批，仍要逐项批准，清单见 [ADR-0007](0007-ghcr-pull-deploy.md)。开 vm 槽位之前要先满足的第一台节点宿主条件见运维记录。
