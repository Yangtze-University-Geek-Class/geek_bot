# ADR-0011：一次性 VM 的 qemu 沙箱不启用 elevateprivileges=deny，由 node 容器兜底

> qemu 的 `-sandbox` 改为 `on,obsolete=deny,resourcecontrol=deny`：实测 `elevateprivileges=deny` 会让 guestfwd 的转发进程起不来；提权由 node 容器的 cap_drop ALL 与 no-new-privileges 挡住。取代 ADR-0004 里 `-sandbox` 那一句，ADR-0004 的其余决定不变。

状态：`accepted` · 更新：2026-09-26 · 适用：node 的 QEMU/KVM 执行器（#17）、`tests/integration/vm/`、[SECURITY](../architecture/SECURITY.md) S-13

## 背景

- [ADR-0004](0004-execution-isolation.md) 定的 VM 启动参数是 `-sandbox on,obsolete=deny,elevateprivileges=deny,resourcecontrol=deny`，不禁 spawn，因为 guestfwd 要起进程；VM 只经 `-netdev user,restrict=on` 加 guestfwd 访问节点的出网代理和模型代理。
- #12 在第一台节点上实测（QEMU 7.2.22，Debian 12 的包，数据见 [VM 可行性实测](../services/node/vm-feasibility.md)），逐项二分 `-sandbox` 的取值，来宾经 guestfwd 访问出网代理：
  - `on`、`on,obsolete=deny`、`on,resourcecontrol=deny`：成功；
  - `on,elevateprivileges=deny`、`on,elevateprivileges=children`：来宾连上转发地址后立刻被断开，转发进程起不来，代理一条连接都收不到。
- 按 ADR-0004 原样配置，VM 就连不上出网代理，PR 通道装不了依赖。模型代理那条 guestfwd 这次没有测；如果它也用 `cmd:` 转发（ADR-0004 没有定），推断同样起不来，由 #32 实测。
- node 容器按 ADR-0004 与 S-13 以非 root、`cap_drop: ALL`、`no-new-privileges` 运行。#12 实测实验容器的 `/proc/1/status` 为 `CapEff: 0000000000000000`、`NoNewPrivs: 1`、`Seccomp: 2`。

## 决策

- qemu 的 `-sandbox` 取 `on,obsolete=deny,resourcecontrol=deny`，不带 `elevateprivileges=deny`（等于 `allow`）；仍然不禁 spawn。
- 提权由 node 容器挡住：没有任何 capability，`no-new-privileges` 让 setuid 程序也拿不到新权限，qemu 和它起的转发进程调用 set*uid 拿不到 root。容器的这几项约束因此是 PR 通道隔离的必要条件，不能去掉；#11、#17 的 compose 与 CI 检查要断言它们（S-13）。
- 本篇只取代 ADR-0004 里 `-sandbox` 那一句；ADR-0004 的其余决定（restrict=on 加 guestfwd、原始盘 tar 传输、fw_cfg 传令牌、出网代理、基础镜像、vm 槽位默认 0）不变。

## 替代方案

- **保留 `elevateprivileges=deny`，改走 ADR-0004 的退路 passt**：passt 在 qemu 之外单独起进程，不受 qemu 沙箱影响；但要多一个组件，隔离效果没有实测。留给 #32 评估，作为以后收紧的备选。
- **换一种不需要起进程的转发**：例如 guestfwd 转发到一个 chardev socket。qemu 的 chardev 转发一次只接一条连接，满足不了 pnpm 这类并发下载；或者改用 virtio-vsock，要多挂 `/dev/vhost-vsock` 设备，并重写节点端点。代价都更大。
- **升级 qemu 版本再试**：Debian 12 的包是 7.2；换版本要改基础镜像来源，且新版本行为未知。重新评估时再测。

## 后果

- qemu 进程内少了一层「禁止 set*uid」的 seccomp 规则。qemu 本身若被来宾逃逸利用，能不能提权取决于容器约束；容器约束配错（例如给了 capability 或关了 no-new-privileges）时，这一层就没有兜底了。
- `tests/integration/vm/lab.sh` 默认用本篇的取值；`GEEKBOT_VM_SANDBOX` 可以覆盖，用于复现和以后重测。
- [SECURITY](../architecture/SECURITY.md) S-13 与 [ARCHITECTURE](../architecture/ARCHITECTURE.md) 的执行器一节按本篇改写。

## 实施状态

- #12：实验脚本按本篇的取值跑通，数据见 [VM 可行性实测](../services/node/vm-feasibility.md)。
- #17（计划中）：QEMU/KVM 执行器按本篇实现，并测试容器约束缺失时拒绝开 vm 槽位。

## 重新评估条件

- qemu 升级后 `elevateprivileges=deny` 与 guestfwd 转发兼容（重跑 `GEEKBOT_VM_SANDBOX=on,obsolete=deny,elevateprivileges=deny,resourcecontrol=deny pnpm test:vm`）；
- 改用 passt 或其它不在 qemu 里起进程的转发方式；
- node 容器的约束有任何放宽的需要。

## 所有者结论

接受：所有者 2026-09-26 在维护会话里对 #12 的实测结论选择「接受去掉这一项」，由维护会话转记在 #33 的返工记录里；所有者本人在 #33 回复确认之前，GitHub 上只有这条转记；待确认事项转记在 #22 跟进。
