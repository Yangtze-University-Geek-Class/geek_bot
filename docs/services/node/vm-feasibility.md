# 一次性 VM 可行性实测（#12）

> 在第一台节点的临时容器里，用 QEMU/KVM 起 1 vCPU / 2 GiB 的一次性 VM：冷启动、网络隔离、出网代理、依赖安装、pnpm verify 与内存峰值的实测数据，以及对 ADR-0004 的结论。

状态：`current` · 更新：2026-09-26 · 适用：[ADR-0004](../../decisions/0004-execution-isolation.md) 的实施、#17 的 QEMU/KVM 执行器与出网代理、`tests/integration/vm/`

本文记录 2026-09-26 在第一台节点上的实测。数字只代表这台主机、这个时间点、这份仓库，换主机或换版本要重新跑（`pnpm test:vm`）。主机的机型、`/dev/kvm` 的现有权限、散热等具体状况不写在这里，见运维记录。

## 怎么测的

入口 `pnpm test:vm`（`tests/integration/vm/run.sh`），只能在有 `/dev/kvm` 与 Docker 的 Linux 主机上以 root 手动运行：要读防火墙规则做前后比对，宿主要有 `iptables-save`、`ip6tables-save` 与 `nft`。环境变量 `GEEKBOT_VM_PROBE_ONLY=1` 只跑网络探测，`GEEKBOT_VM_SANDBOX` 覆盖 qemu 的 `-sandbox` 取值，用法见 [LOCAL-DEV](../../ops/LOCAL-DEV.md)。

- **宿主上只做**：构建一个实验镜像（`Dockerfile.lab`：Node 22 bookworm-slim 加 qemu），建一个缓存卷，起一个临时容器，跑完删除容器、实验镜像和缓存卷；基础镜像只在它是本次拉下来的时候才删，Docker 的构建缓存不清（和宿主上别的构建共用）。不装宿主软件包，不改防火墙；实验前后各取一次防火墙规则的指纹（去掉注释与包计数器），在容器删掉之后比较。
- **实验容器按 node 容器的约束运行**：uid 1000、`--group-add` 宿主 kvm 组、只挂 `/dev/kvm`、`cap_drop ALL`、`no-new-privileges`、Docker 默认 seccomp、不发布端口、限制内存与进程数。
- **容器里**（`lab.sh`）：下载 Debian 12 genericcloud 镜像与 Node 22 并按官方 `SHA512SUMS`、`SHASUMS256` 核对；起出网代理 `egress-proxy.mjs`；两次引导 VM：
  - `-enable-kvm -cpu host -smp 1 -m 2048`，qcow2 overlay 叠在只读的基础镜像上；
  - `-netdev user,restrict=on`，只有一条 guestfwd：来宾里的代理地址 → 容器回环地址上的出网代理；
  - 任务输入是只读原始盘上的 tar，结果写到可写原始盘上的 tar，与 ADR-0004 的 I/O 方式一致；
  - 第一次（cold）从零安装依赖；第二次（warm）带上第一次导出的 pnpm store。
- **VM 里**（`guest.sh`，cloud-init 以 root 运行）：直连探测宿主与各类地址 → 经代理探测放行与拒绝 → 经代理用 apt 装 git（`pnpm verify` 的公开安全检查要用 `git ls-files`）→ 装 Node 与 pnpm → 对本仓库 `stage`（400917d）跑 `pnpm install --frozen-lockfile` 与 `pnpm verify`，每秒采样一次已用内存。
- **出网代理规则**（S-03、S-14）是纯函数，有单测 `tests/integration/vm/egress-proxy.test.ts`，随 `pnpm test` 在任何机器上跑。

## 结果

测试环境：第一台节点（x86_64，16 个逻辑 CPU），Docker 29，实验镜像里的 QEMU 7.2.22（Debian 12 包），来宾 Debian 12 genericcloud、Node v22.23.3、pnpm 9.15.9。

### 节点容器里能不能用 KVM

- 实验容器以 uid 1000 运行，`/proc/1/status` 为 `CapEff: 0000000000000000`、`NoNewPrivs: 1`、`Seccomp: 2`（Docker 默认 seccomp 生效）；`docker inspect`：`privileged=false`、`capDrop=["ALL"]`、`capAdd=null`、`securityOpt=["no-new-privileges"]`、只挂了 `/dev/kvm`、没有发布端口。
- 在这些约束下 `/dev/kvm` 可读写，`-enable-kvm` 正常引导。**通过。**
- 这台宿主 `/dev/kvm` 的现有权限比 kvm 组更宽，所以本次实测证明不了「只靠 `group_add` 就够」；ADR-0004 仍要求 node 容器只靠 `group_add` 取得访问权，在别的宿主上部署时核对。

### 纯 QEMU 能不能引导 cloud 镜像，冷启动多久

- Debian 12 genericcloud 镜像由 QEMU 直接引导，cloud-init 从 NoCloud 种子盘读 user-data。**通过。**
- 从启动 qemu 到来宾里的 runner 脚本开始执行，六次引导在 10.5 到 13.1 秒之间：cold 12.1、10.5、12.5、13.1 秒，warm 10.5、11.0 秒。

### 网络隔离：restrict=on 加一条 guestfwd

直连探测（来宾里用 bash 的 `/dev/tcp` 或 curl，4 秒超时）全部 **不通**。第 7、8 次运行（只跑探测）记下了失败类型，并加了阳性对照，两次结果相同：

- **阳性对照**：QEMU 用户态网络里的宿主别名地址对应的是实验容器自己的回环地址，它的 3128 端口上有出网代理在监听。来宾照样连不上（refused）。所以宿主别名上别的端口连不上，是 `restrict=on` 挡住的，不是端口没人在听。
- **节点宿主**：实验容器的默认网关，也就是节点宿主在 Docker 网桥上的地址。它的 22 和 3128 端口都不可达（unreachable）。
- 宿主别名地址的 22、139、445、3055、3183 端口：refused。
- 用户态网络的 DNS 地址 53 端口：refused。来宾里的域名解析也失败，只能经代理访问外网。
- RFC 1918 三个私网段、CGNAT、链路本地的云元数据地址、一个公网 IP 的 443：unreachable。
- IPv6：用户态网络的宿主地址、ULA、链路本地、IPv4 映射地址、NAT64 地址，都不通。
- 反向核对：出网代理的 guestfwd 转发地址连得上。

上面这些网段外的目标报 unreachable，是因为来宾里没有 IPv4 默认路由（`restrict=on` 时 DHCP 不下发网关，`ip -4 route show default` 为空），包没有离开来宾。来宾里以 root 运行的代码可以自己加默认路由，所以第 8 次运行（只跑探测）在上面的探测之后，让来宾自己加上默认路由再探一遍：

- IPv4 加 `default via <宿主别名地址>`，IPv6 本来就有一条经路由通告下发的默认路由（下一跳是用户态网络的链路本地地址），用 `ip -6 route replace` 把它换成经用户态网络宿主地址的。两条都设置成功。
- 节点宿主（容器网关）的 22、3128，RFC 1918、CGNAT、云元数据地址、公网 IP 的 443：全部 **refused**。QEMU 用户态网络在 `restrict=on` 时直接拒掉来宾发往外面的连接，包到不了宿主网络。
- IPv6 的 ULA、NAT64、一个公网 IPv6 地址：全部不通，curl 退出码 7、0 毫秒内失败。报错里既没有 refused 也没有 unreachable，分不出是哪一种；从 7908d4f 之后的脚本起，报错的最后一段会原样记下来。
- 出网代理的 guestfwd 转发地址照样连得上。

所以「来宾连不出去」不依赖来宾里的路由表，靠的是 `restrict=on` 本身。

经出网代理：

| 目标 | 结果 | 代理记录的原因 |
|---|---|---|
| `registry.npmjs.org`（白名单内） | HTTP 200 | 放行 |
| `github.com`、`api.github.com`、`raw.githubusercontent.com` | 拒绝 | `github_denied` |
| `example.com`（白名单外） | 拒绝 | `not_in_allowlist` |
| 直接写 IP 的 CONNECT | 拒绝 | `ip_literal` |
| 解析到回环地址的公共域名（为验证放进了实验白名单） | 拒绝 | `resolved_to_forbidden_address` |

宿主防火墙：实验前后按 iptables、ip6tables 和 nft 的每张表分别取指纹（去掉包计数器），容器删掉之后再比较。
- **filter、nat 表和 FORWARD 规则每次都没变**。第 8 次运行全部 14 项指纹前后一致。
- **第 6 次**：唯一变了的是 nft 的 `bridge incus` 表，多出的是 incus 实例的链。实例名里带的创建时间正好落在实验时间窗里，实验脚本不调用 incus，所以**推断**这个差异来自宿主上的另一套程序。这是按时间归因，不是直接证明。
- **第 7 次**：iptables 的 raw 表（nft 里的 `ip raw`）多了两条规则，是 Docker 给接在默认网桥上的容器自动加的「直连防护」DROP 规则（`-d <容器地址>/32 ! -i docker0 -j DROP`）。实验前 raw 表里没有这类规则：把这两条去掉后，指纹和实验前完全一致。
  - 一条属于实验期间宿主上另一套程序起的容器，Docker 事件里有它的创建时间，它现在还在运行。
  - 另一条指向一个已经释放的容器地址。实验期间先后用过这个地址的，有实验镜像构建时的中间容器、实验容器，也可能有另一套程序的容器；现在已经无法确定是谁留下的。它只丢弃发往这个空闲地址的流量，由 Docker 管理，实验脚本没有写防火墙。**没有删**：删它要改宿主防火墙，不在这次授权范围内，交给所有者决定。
- 从这一版起，`run.sh` 会把实验时间窗内的 Docker 容器事件存进 `docker-events.txt`，以后可以直接归因。
- **#12 验收条件 5（「iptables 和 FORWARD 规则前后没有变化」）没有完全满足**：第 7 次运行后 raw 表里留下一条来源无法确定的规则，不能排除是实验的构建或实验容器留下的。是否算满足、那条规则删不删，待所有者判定，转记在 #22 跟进。

### 依赖安装、pnpm verify 与内存（1 vCPU / 2 GiB）

完整跑了两次（第 5、6 次），每次先 cold 再 warm：

| | cold（无缓存） | warm（带 pnpm store） |
|---|---|---|
| `pnpm install --frozen-lockfile` | 36 秒 / 40 秒，350 个包，退出码 0 | 3 秒 / 4 秒（另有 2 秒把 308 MiB 的 store 解包到 VM 里），退出码 0 |
| `pnpm verify` | 32 秒 / 36 秒，退出码 0，23 个测试文件、319 个用例通过 | 35 秒 / 31 秒，同样全部通过 |
| 来宾内存峰值（MemTotal − MemAvailable） | 938 MiB / 904 MiB，总共 1979 MiB | 944 MiB / 896 MiB |
| OOM | 没有；来宾没有 swap | 没有 |
| 经代理的连接与下载量 | 357 个连接，下载约 112.7 MB（含 apt 的索引与 git） | 7 个连接，下载约 42.7 MB（几乎都是 apt 的索引与 git） |

- 导出的 pnpm store 是 287 MiB。
- apt 经代理装 git 在几次运行里用了 248 到 575 秒，主要花在下载软件源索引上。生产的基础镜像会预装 git（见 ADR-0004「基础镜像」），这段时间不计入任务耗时。
- 本仓库目前的规模（350 个包、319 个用例）比 ADR-0004 背景里那次实测用的仓库小，内存峰值也低。2 GiB 对它足够；对更大的仓库，默认规格要按实测再定。

## 发现

1. **`-sandbox` 的 `elevateprivileges=deny` 与 guestfwd 的 `cmd:` 转发不兼容（已由 [ADR-0011](../../decisions/0011-qemu-sandbox-elevateprivileges.md) 处理）。** QEMU 7.2.22 上逐项实测：`on`、`obsolete=deny`、`resourcecontrol=deny` 都正常；`elevateprivileges=deny` 或 `=children` 时，来宾连上转发地址后立刻被断开，转发进程起不来，代理一条连接都收不到。ADR-0004 写的是 `-sandbox on,obsolete=deny,elevateprivileges=deny,resourcecontrol=deny`，照原样做不到「VM 只经 guestfwd 出网」。本次实验改用 `on,obsolete=deny,resourcecontrol=deny`，靠容器的 `cap_drop ALL` 与 `no-new-privileges` 兜底：没有任何 capability、不能经 setuid 程序提权，qemu 与转发进程调用 set*uid 也拿不到权限。这是对 ADR-0004 隔离配置的放宽；所有者 2026-09-26 决定接受，写成 ADR-0011，取代 ADR-0004 里 `-sandbox` 那一句。
2. **Node 的 `net.BlockList` 会拿 IPv4 地址去比 IPv4 映射规则。** 把 `::ffff:0:0/96` 加进 BlockList，会把全部 IPv4 地址都判为禁止。出网代理改成单独判断 IPv4 映射地址，单测里有这条回归。#17 写生产版出网代理时照此处理。
3. **代理收到 SIGTERM 时不能等 `server.close()`**：VM 关机后还开着的隧道可能永远不关，要主动断开全部连接再退出。
4. cloud-init 的 runcmd 里没有 `HOME`，`git config --global`、npm、pnpm 会写不到家目录；来宾脚本要先 `export HOME=/root`。

## 结论

| ADR-0004 要验证的假设 | 结论 |
|---|---|
| Docker 默认 seccomp 下 node 容器（非 root、cap_drop ALL、no-new-privileges）能用 `/dev/kvm` | 通过；但这台宿主 `/dev/kvm` 的权限比 kvm 组宽，「只靠 group_add 就够」没有证明 |
| 纯 QEMU 能引导 cloud 镜像 | 通过；到 runner 就绪 10.5–13.1 秒 |
| restrict=on 加 guestfwd 的隔离 | 通过：直连探测全部不通，阳性对照（有进程在听的宿主别名端口）也不通；来宾自己加上默认路由之后，节点宿主、私网、元数据地址、公网地址仍然全部被拒；`-sandbox` 按 ADR-0011 不带 `elevateprivileges=deny` |
| 出网代理的放行与拒绝（S-03、S-14） | 通过 |
| 1 vCPU / 2 GiB 跑一次完整校验会不会 OOM | 本仓库不会（峰值 896–944 MiB）；omp 加校验的组合没有测，见下 |
| 依赖安装耗时与缓存 | 冷装 36–40 秒；带 store 3–4 秒（外加解包 2 秒），几乎不走网络 |
| 宿主防火墙规则不变 | 未完全满足，待所有者判定：filter、nat、FORWARD 每次都没变，第 8 次全部指纹一致；但第 7 次后 raw 表留下一条 Docker 自动加的容器直连防护规则，来源无法确定，不能排除是实验留下的；incus 表的差异推断来自另一套程序。都没有删（见「网络隔离」） |

## 这一轮没有覆盖的

以下各项都是 **未验证**，不能当作已通过：

- **omp**：omp 在 VM 里的内存（ADR-0004 估约 0.6 GB）与 omp 加校验的峰值；带 `.omp/hooks`、`mcp.json`、`.env` 的恶意夹具是否被加载。跑 omp 需要模型中继与每任务令牌（#13、#14），在 #17 的执行器里补测。
- **只读缓存盘**：ADR-0004 设想的是只读挂进 VM 的 pnpm store 缓存盘；本次 warm 是把 store 解包到 VM 的可写盘上再装，只能说明「有缓存时下载量和耗时是多少」，不能说明只读挂载可行。
- **passt**：没有评估。
- **两种 I/O 方式与吞吐**：#12 范围里「对比 guestfwd 与原始盘 tar 两种 I/O 方式」、ADR-0004 假设里的吞吐，都没有测。
- **第二条 guestfwd（模型代理）**：只测了出网代理这一条。
- **出网代理的 SNI 绑定**：实验代理没有把 CONNECT 的主机名与 TLS 的 SNI 绑定，共享 CDN 上可换 SNI 绕过白名单；#17 的生产代理要处理。连接数与字节数上限已在实验代理里实现并有单测，但没有在 VM 里压测。
- **基础镜像在 CI 里构建**：没有试跑。
- **中等规模的其它仓库**：只测了本仓库。
- 取消后 qemu 退出、overlay 回收、fw_cfg 传令牌：属于执行器行为，随 #17 实现与测试。
