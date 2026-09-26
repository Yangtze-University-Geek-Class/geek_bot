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

## 13:36:56 +08:00 · 推送 · #12 · 推送 task/12/vm_feasibility

- 执行者：agent-claude-geek-bot-821e（Claude Code，claude-opus-5-5）
- 做了什么：git push -u origin task/12/vm_feasibility（HEAD bf06b05）
- 结果：推送成功，pre-push 钩子通过

## 13:36:57 +08:00 · PR · #12 · 开 PR #33 指向 stage；未覆盖的项拆到 #32

- 执行者：agent-claude-geek-bot-821e（Claude Code，claude-opus-5-5）
- 做了什么：开 #32 承接 omp、恶意夹具、只读缓存盘、passt、CI 构建基础镜像；在 #12 留进展与拆分记录；gh pr create --base stage，正文先经 pr-contract 核对
- 结果：PR #33；pr-contract 通过；审查结论段写阻塞，等独立审查与所有者对 -sandbox 的结论

## 14:22:53 +08:00 · 审查 · #12 · 独立审查员审 bf06b05：阻塞（缺 PR 记录）与 8 条应修

- 执行者：agent-claude-geek-bot-821e（Claude Code，claude-opus-5-5）
- 做了什么：独立审查代理只读核对 bf06b05，跑了 pnpm verify、vitest、shellcheck、note check 与纯函数探针，不连远程主机
- 结果：阻塞：推送与 PR 记录未提交导致 CI 缺 PR 记录；应修：直连探测无阳性对照、run.sh 非 root 或缺 nft 时比较空洞、基础镜像与构建缓存残留、代理字节上限只在新连接时查且连接数有竞态、KVM 结论缺前提、引导次数写错、未测项漏列、IPv6 字面量；另有 3 条建议

## 14:22:53 +08:00 · 返工 · #12 · 按审查意见改实验脚本、代理与报告，所有者决定写成 ADR-0011

- 执行者：agent-claude-geek-bot-821e（Claude Code，claude-opus-5-5）
- 做了什么：所有者选择接受去掉 elevateprivileges=deny，写 ADR-0011 取代 ADR-0004 那一句，同步 SECURITY S-13、ARCHITECTURE；代理：连接数先占位、字节上限逐块核对、解析期间暂停客户端、上游失败记 error、拦嵌入 IPv4 的 IPv6 段、注入 lookup 后补 8 条行为测试（变异 3 处各有测试失败）；探测加阳性对照、失败类型与容器网关、只跑探测模式；run.sh 要求 root 与命令、读不到记 UNKNOWN、资源名加后缀、基础镜像只删本次拉的、记 docker 事件；IPv6 地址运行时拼出；报告与 ADR-0004、STACK、node 契约的措辑按意见改；#32 补漏项；第 7 次只跑探测：阳性对照 refused、宿主网关 unreachable、guestfwd 可达，raw 表多了 Docker 的容器直连防护规则
- 结果：pnpm verify 退出码 0（338 passed (338)）；shellcheck 无输出；节点上的实验资源与临时目录已清理

## 14:22:53 +08:00 · 提交 · #12 · 返工一起提交

- 执行者：agent-claude-geek-bot-821e（Claude Code，claude-opus-5-5）
- 做了什么：git commit：fix(node): 按审查意见收紧实验代理与探测，写 ADR-0011；提交前 pnpm verify、shellcheck
- 结果：pnpm verify 退出码 0

## 14:27:54 +08:00 · 提交 · #12 · 合入最新 stage（含 #3），并入 #3 暂存的合并与收尾记录

- 执行者：agent-claude-geek-bot-821e（Claude Code，claude-opus-5-5）
- 做了什么：git merge origin/stage（619ff73）；package.json 与 docs/ops/LOCAL-DEV.md 冲突手工合并（保留 dev:control 与 test:vm 两条脚本）；REFERENCES 的 QEMU 行改指 vm-feasibility 与 ADR-0011；node scripts/note.mjs flush 并入 task_3 链路的「合并」「收尾」；pnpm install --frozen-lockfile；pnpm verify
- 结果：pnpm verify 退出码 0（Test Files 30 passed，Tests 433 passed）
