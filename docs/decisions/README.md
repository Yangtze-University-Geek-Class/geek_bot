# 架构决策

> 已接受决策及其背景、替代方案、后果和重新评估条件。

状态：`current` · 更新：2026-09-26 · 适用：需要确认某项取舍为什么这样定、能不能改的时候

本目录文档由 [总入口](../README.md) 导航，完整列表见 [生成索引](../INDEX.md)。

## 写法

- 文件名 `NNNN-<slug>.md`，编号四位、按顺序分配，不复用。
- 每篇 ADR 写背景、决策、替代方案、后果和重新评估条件；状态用 `accepted` 或 `proposed`（词表见 [DOCUMENTATION](../conventions/DOCUMENTATION.md)）。`accepted` 不表示代码已经落地，正文要写实施状态。
- 已接受的决策不回改结论；要改就写一篇新的 ADR 取代它，并在旧 ADR 里注明被哪一篇取代。
- ADR 里不写组织名、真实仓库名、内部主机、网段、网关地址和真实账号。

## 编号表

| 编号 | 标题 | 状态 |
|---|---|---|
| 0001 | [geek_bot 独立成可自部署的通用产品](0001-standalone-product.md) | `accepted`（2026-09-25） |
| 0002 | [机器人身份用 OAuth App 用户令牌；默认「登录即成为机器人」](0002-github-identity.md) | `proposed`（2026-09-26，待所有者在 #2 的 PR 上给结论） |
| 0003 | [控制面单进程单写者；节点只出站拉任务；control 是唯一 GitHub 写入方](0003-single-writer-control.md) | `proposed`（2026-09-26，待所有者在 #2 的 PR 上给结论） |
| 0004 | [执行隔离：issue 通道用独立无网 sandbox 容器，PR 通道用节点容器内的 QEMU/KVM 一次性 VM](0004-execution-isolation.md) | `proposed`（2026-09-26，待所有者在 #2 的 PR 上给结论） |
| 0005 | [规则来源只信 base 分支；机器可执行字段只来自结构化配置](0005-rules-from-base-branch.md) | `proposed`（2026-09-26，待所有者在 #2 的 PR 上给结论） |
| 0006 | [模型目录只读 catalog 文件；密钥只在 control；每任务令牌中继](0006-model-catalog-relay.md) | `proposed`（2026-09-26，待所有者在 #2 的 PR 上给结论） |
| 0007 | [部署：ghcr 同一 digest 跨环境、目标机拉取式部署、CI 不部署](0007-ghcr-pull-deploy.md) | `proposed`（2026-09-26，待所有者在 #2 的 PR 上给结论） |
| 0008 | [数据：SQLite 版本化迁移只扩不缩；GitHub 标记注释可重建状态；每日恢复校验](0008-sqlite-migrations-recovery.md) | `proposed`（2026-09-26，待所有者在 #2 的 PR 上给结论） |
| 0009 | [管理后台用 Vue 3 + Tuffex 0.6.0，由 control 同源托管](0009-tuffex-console.md) | `proposed`（2026-09-26，待所有者在 #2 的 PR 上给结论） |
| 0010 | [本仓库开发流程用的追踪记录头](0010-tracking-record-prefix.md) | `accepted`（2026-09-25） |
