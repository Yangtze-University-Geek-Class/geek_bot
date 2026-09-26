# ops/

> 运维文档目录：照着做就能跑的操作说明。现在只有本机开发、CI 与发布验收模板，部署、环境、节点等文档随对应 issue 加入。

状态：`current` · 更新：2026-09-26 · 适用：在本机开发、改工作流或准备发版的维护者与 agent

## 现有文档

| 文件 | 什么时候读 |
|---|---|
| [`LOCAL-DEV.md`](./LOCAL-DEV.md) | 第一次在本机装依赖、跑 `pnpm verify`、用 task worktree 开工之前 |
| [`CICD.md`](./CICD.md) | 改工作流、改 GitHub 仓库设置或标签之前 |
| [`RELEASE-ACCEPTANCE-TEMPLATE.md`](./RELEASE-ACCEPTANCE-TEMPLATE.md) | 要做人工验收记录时（空白模板，验收人填；随 #7 首次使用） |

## 计划中的文档

下面这些文件还不存在，由对应 issue 写入；在那之前不要按猜测去部署或改主机。

| 文件 | 内容 | 写入 |
|---|---|---|
| DEPLOY | 按 digest 拉取镜像、部署前备份、健康门、自动回滚、部署记录 | #7 |
| ENVIRONMENTS | `preview` / `production` 两份 env 模板的字段契约、`*_FILE` 密钥、预发布实例的写入限制 | #7 |
| HOST-PREREQS | 目标机前置条件（Docker 与 compose 插件、栈目录、密钥文件）和只读体检 | #7 |
| RUNBOOK | 常见故障的处理步骤 | #7 起草，#20 补全 |
| NODES | 加节点的前提（Docker、`/dev/kvm`）、节点令牌的生成与存放、槽位与节点健康 | #11 |
| BACKUP | 备份、异地副本与恢复演练 | #20 |
| OBSERVABILITY | 告警、关键运行指标与节点看门狗 | #20 |

**部署由人执行，AI 不得自行部署**（授权边界见 [AGENTS](../../AGENTS.md) §3、[PROJECT](../conventions/PROJECT.md) 与 [AGENT-START](../conventions/AGENT-START.md)）。
