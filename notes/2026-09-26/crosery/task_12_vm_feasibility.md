# task/12/vm_feasibility · crosery · 2026-09-26

负责人：crosery

## 11:23:21 +08:00 · 开工 · #12 · 从 origin/stage 400917d090a0 建 task/12/vm_feasibility

- 执行者：agent-claude-geek-bot-821e（Claude Code，claude-opus-5-5）
- 做了什么：node scripts/task.mjs start 12 vm_feasibility：从 origin/stage 400917d090a08843376296014fdf38d3ce9ac3aa 建分支与 worktree .claude/worktrees/task-12，在 issue 上留开工记录
- 结果：worktree 已建好，issue 上已留开工记录

## 11:31:45 +08:00 · 方案 · #12 · 实验只在第一台节点上起临时容器，qemu 与出网代理都在容器里

- 执行者：agent-claude-geek-bot-821e（Claude Code，claude-opus-5-5）
- 做了什么：读完 ADR-0004、SECURITY S-03/S-04/S-13/S-14、node 契约；所有者 2026-09-26 允许在第一台节点上做临时实验（不装宿主软件包、不改防火墙、不动现有服务、做完清理）。方案：tests/integration/vm/ 下的 run.sh（宿主，只需 docker）起实验容器（非 root、只挂 /dev/kvm、cap_drop ALL、no-new-privileges、默认 seccomp、不发布端口），容器里 lab.sh 下载并校验 Debian 12 genericcloud 与 Node 22，起 egress-proxy.mjs，两次引导 1 vCPU / 2 GiB 的 VM（restrict=on + 一条 guestfwd）：冷装与带 pnpm store；guest.sh 探测网络隔离与代理规则、装 git 与 pnpm、对本仓库 stage 400917d 跑 pnpm install 与 pnpm verify 并采样内存；前后比对防火墙规则哈希。omp、恶意夹具、passt、CI 构建基础镜像不在这一轮
- 结果：宿主基线（只读）：kvm 组存在、Docker 内置 seccomp、FORWARD 策略 DROP、负载与温度正常；实验于 11:30 在节点上启动。代理规则单测 11 条通过，其中一条回归：Node BlockList 会拿 IPv4 地址去比 IPv4 映射规则，映射地址改为单独判断

## 12:05:05 +08:00 · 开发 · #12 · 前三次实验失败的原因与 qemu 沙箱的发现

- 执行者：agent-claude-geek-bot-821e（Claude Code，claude-opus-5-5）
- 做了什么：第 1 次：旧版 docker build 拉基础镜像卡住 16 分钟，停掉后单独 docker pull 成功；第 2 次：命名卷 /cache 属 root、uid 1000 写不进（curl 23），防火墙指纹含包计数器导致前后不同，改为镜像里预建 /cache 并去掉计数器、删容器后再取指纹；第 3 次：冷启动到 runner 就绪 12.1 秒，直连探测全部不通，但经 guestfwd 的代理请求全部失败。单独调试：去掉 -sandbox 后经代理访问 npm 源 HTTP 200；逐项二分：on、obsolete=deny、resourcecontrol=deny 都正常，elevateprivileges=deny 与 =children 都会让 guestfwd cmd: 的转发进程起不来（QEMU 7.2.22，Debian 12）
- 结果：lab.sh 的 -sandbox 改为可配置，默认 on,obsolete=deny,resourcecontrol=deny，靠容器 cap_drop ALL 与 no-new-privileges 兜底（实测 CapEff 0、NoNewPrivs 1、Seccomp 2）；与 ADR-0004 的写法不同，放不放宽由所有者决定。12:05 带 --keep 重跑全量实验
- 下一步：等全量结果，写 vm-feasibility.md 与 ADR-0004 实施状态

## 13:34:05 +08:00 · 开发 · #12 · 第 5、6 次完整实验成功，报告与 ADR-0004 实施状态写完，节点上已清理

- 执行者：agent-claude-geek-bot-821e（Claude Code，claude-opus-5-5）
- 做了什么：修了三处实验脚本问题（来宾没有 HOME 导致 git safe.directory 写不进、代理 SIGTERM 等 server.close 卡住、防火墙指纹改按表取）；第 5、6 次各跑 cold 与 warm；nft 差异经按表指纹定位到宿主上另一套程序新建的 incus 实例链；写 docs/services/node/vm-feasibility.md，更新 ADR-0004 实施状态、node 契约、STACK、TESTING、LOCAL-DEV、CONTRIBUTING；节点上删掉实验镜像、为实验拉的基础镜像、缓存卷与临时目录
- 结果：冷启动 10.5–13.1 秒；直连探测 18 项全部不通；代理放行 npm、拒绝 GitHub 三个域名、白名单外、IP 字面量、解析到回环的域名；cold 装依赖 36–40 秒、verify 32–36 秒（319 passed），warm 装依赖 3–4 秒；内存峰值 896–944 MiB / 1979 MiB，无 OOM；实验没有改动宿主防火墙；elevateprivileges=deny 与 guestfwd cmd: 不兼容，待所有者决定。pnpm verify 退出码 0（Tests 330 passed）

## 13:34:05 +08:00 · 提交 · #12 · 实验脚本、代理规则单测与实测报告一起提交

- 执行者：agent-claude-geek-bot-821e（Claude Code，claude-opus-5-5）
- 做了什么：git commit：test(node): 一次性 VM 可行性实验与出网代理规则，附实测报告；提交前 pnpm verify、actionlint、shellcheck
- 结果：pnpm verify 退出码 0（Tests 330 passed）；actionlint 与 shellcheck 无输出
