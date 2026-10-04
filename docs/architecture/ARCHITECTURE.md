# geek_bot 架构

> 一个控制面管理共享项目、需求、任务和机器；渠道通过适配器读取，任务在隔离执行环境运行，外部写入只经 publisher。

状态：`current` · 更新：2026-10-03 · 适用：五个工作区包的现有实现（#34）

## 产品范围与事实来源

产品范围见 [ADR-0012](../decisions/0012-shared-cross-platform-workspace.md)。一个实例共用数据库、项目、需求、任务、机器池和模型池，不引入租户、团队空间或每用户独占池。管理员授权项目处理类别和可用机器，中央调度器决定具体任务去向。

当前事实来自各包的源码与 [服务契约](../services/README.md)。本页 current 表示文档描述现有代码，不表示真实外部账号、镜像、Linux/KVM 或线上环境通过验收。

## 运行位置与信任边界

| 组件 | 运行位置 | 责任 | 凭据 |
|---|---|---|---|
| control | 控制主机的独立进程／容器 | Fastify 后台与 node API、独占 SQLite、认证、连接、发现同步、需求、任务、资源租约、模型中继、publisher、同源后台 | master、backup、session、OAuth secret、gateway key 的独立文件；连接密文 |
| console | 管理员浏览器 | 项目、需求、机器、任务、连接、模型池和管理员页面 | HttpOnly 会话 cookie；没有连接或模型凭据 |
| node | 工作主机的非 root 容器 | 出站心跳、长轮询、槽位与资源上限、任务包、sandbox / VM、模型与出网代理、spool、取消回收 | 自己的节点令牌文件；租约期内的任务模型令牌 |
| runner | 无网 sandbox 或一次性 VM | 干净 HOME、关闭发现源、显式工具白名单、omp、事件、结果和补丁 | 本任务模型令牌只在内存，VM 通过 fw_cfg 暂时输入 |
| protocol | 构建时共享 | 纯 DTO、JSON Schema 和固定取值；不做 I/O | 无 |

四个 app 不导入彼此的实现。跨包只通过 `@geek-bot/protocol` 与显式 HTTP / JSON 契约。control 不运行 omp，也不执行仓库脚本。

## 数据流

1. owner 认领实例。后台登录只取 GitHub 数字身份并撤销临时令牌；渠道连接另外绑定，机器人账号可以与登录账号不同。
2. GitHub / GitLab 读取适配器按账号与 token 的实际权限发现项目。外部项目 id 与连接一起构成稳定标识，失去访问记 lost，历史保留。
3. 同步 issue 与 PR/MR，PR/MR 归一为 change，保留原来源。bot_authored 用同一连接当前账号的数字 id 判断，不按可变 login 认身份。
4. 项目监控、四类处理开关和外部写入模式分开。新项目处理开关全关；owner 重新认证后才能打开，operator 可以关掉。
5. 平台条目形成有稳定 item 关联的需求与任务。消息先形成需求，再关联项目。未关联不能派发；自由文本不决定外部写入目标。
6. control 准备真实任务包：执行提交固定 head，规则只取 base。剔除代理扩展、MCP、git 配置和 env；拒绝路径逃逸、符号链接、子模块或不完整快照。
7. node 长轮询领租约。control 在事务里检查资源、槽位、标签、项目机器范围、信任与状态，写 lease、epoch 和短期模型凭据。
8. node 校验原样任务包的 SHA-256，执行器运行 runner。模型经 runner 回环转发、node Unix socket、本实例 relay 到配置网关。
9. node 事件先打码并写入磁盘 spool，再回传。结果和失败也先持久化；control 按 machine / task / lease / epoch 拦迟到或越界报告。
10. 平台结果进入受控 publisher，发送前再核对状态、权限、head、开关、环境和凭据。无代码条目的只读需求完成本地报告；消息进展另由 IM outbox 回传，不假称代码平台写入成功。

## 控制面

入口和生命周期在 `control/src/{index,services,app}.ts`。`platform/index.ts` 组装服务与路由。静态后台由 control 同源托管；非 API 路由回到实际 SPA，未知 `/api/*` 返回 JSON 404，静态路径不能读取数据目录或密钥。

SQLite 为 WAL、FULL synchronous、foreign_keys、独占锁，只有 control 写入。会写库的运维 CLI 走本地 Unix socket，离线时先独占打开并核对版本。版本迁移只扩不缩，已有迁移不回改，迁移前备份。

连接读取在 `connectors`，连接明文只在读请求期间或 publisher 内。外部写入在 `publisher`，使用固定意图，不提供任意方法／路径调用。主体字段、权限与协议来源见 [后台 API](API.md)、[数据模型](../services/control/data-model.md) 和 [写入白名单](../services/control/write-whitelist.md)。

## 调度与恢复

- 两类槽位是 sandbox 和 vm。自检实际就绪、健康门通过后才有有效槽位；登记后的节点先 cordoned，不让“文件存在”冒充隔离通过。
- 任务资源为 CPU / 内存，不能超过管理员上限或本机声明。VM 还需要可用内存多于任务预算加 1 GiB。
- 私有项目默认只派 high 信任机器；该信任提升由 owner 重新认证。共享池不意味私有代码可以发给任意节点。
- 条目任务最多一个活跃任务，项目写任务最多一个活跃 fix/rework。新 head 作废旧结果，重新排队也不能绕过这些条件。
- lease_id 与 epoch 阻止重复领取和迟到结果。节点声明 boot_id、seq 和持有的租约，与 control 对账；令牌重置使旧身份立即失效。
- 网络结果未知不盲重试写操作。节点的事件和结果留在磁盘 spool，重启按原 lease/epoch 回放或按栅栏作废。
- 已知过热、电池供电或磁盘不足会隔离，恢复带回滞。采集不到的可选传感器不编值，不假称通过；必需内存、磁盘或自检信息未知则关门。

具体字段、超时、失败码与 API 见 [节点协议](../services/node/protocol.md)。硬件报告来自半可信 node，control 验证结构并做最终派发判断。

## 执行隔离

sandbox 每槽位一个独立容器，network none、根只读、临时工作目录、非 root、cap_drop ALL、no-new-privileges、资源和进程限制。runner 报到时给出真实 omp 版本和进程隔离证据，未通过不能领任务。只读白名单为 read / grep / glob。

VM 每任务一个只读基础镜像上的 qcow2 overlay；实际探针与任务共用 QEMU 参数。受限用户态网络只经 guestfwd 到本地模型和 CONNECT 代理；输入输出为原始盘 tar，事件经 virtio-serial，任务令牌经 fw_cfg 临时文件。QMP 关机后按时终止并回收 overlay。qemu 沙箱的明确例外继续按 ADR-0011 执行，不因此增加 capability、privileged 或 docker.sock。

出网代理只连接校验过的一次 DNS 结果，拒绝私网和保留地址、IP 字面量、未授权域名及默认 GitHub 出网；TLS ClientHello 的 SNI 必须与 CONNECT 目标一致。连接数与字节数有界。

这些执行代码存在，不代表本机已完成 Linux/KVM 与镜像隔离证明。

## 模型

catalog 来自只读文件，provider.baseUrl 必须与部署配置相同。模型池不含密钥，档位仅来自目录。所有 gateway key 只在 control；每任务模型令牌限定节点、租约、模型和预算，租约结束即失效。

relay 校验字段、模型、effort、预算和 active lease，流式回复按 usage 记账并随取消中止。runner 处理实际 omp JSONL、结果校验和可重试模型错误，不把上下文溢出、取消或预算耗尽当作降级理由。

## 发布与部署边界

GitHub review 只为 COMMENT；GitLab 只评论。修复在 control 的隔离 Git 工作目录提交，只更新有实例记录的机器人分支；Git 配置、hooks、credentials、tags 和目标 ref 均受限制。批准、合并和默认分支仍归人。

Dockerfile 不表示实例已部署。发布与目标机操作继续按 [RELEASES](../conventions/RELEASES.md)、ADR-0007 和人工验收单独授权。本次不创建发布 tag、不改根版本、不推送或部署。

## 实际验证和未验证

真实本机 HTTP / SQLite 已证明需求、调度、栅栏、权限、令牌重放拒绝和重启保存。真实生产模式 console 已在 Ego 观察桌面与 390px 需求创建、项目关联、派发和取消。外部 APIs 使用隔离协议服务，这与真实账号授权、外部发布、模型质量和线上验收不同。

尚未亲测的 Linux/KVM、sandbox / node 镜像、guestfwd、fw_cfg、QMP、硬件传感器和真实外部发布须逐项记录，不能从源码、类型或构建成功推断为通过。安全模型与残余风险见 [SECURITY](SECURITY.md)。
