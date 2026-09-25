# components/

> 管理后台所用组件库的本地资料入口：Tuffex 0.6.0 的离线文档快照，加上本仓库手写的使用政策。

状态：`current` · 更新：2026-09-25 · 适用：`app/console` 与一切界面改动

geek_bot 的管理后台全部用 Tuffex 0.6.0（Vue 3.5），依赖和外壳由 #4 引入。从 [Tuffex 文档库](tuffex/README.md) 进入，Tuffex 的引入与版本规则见 [Tuffex 使用政策](tuffex/USAGE-POLICY.md)。

`tuffex/` 下的上游文档、类型和 Demo 是固定提交的文本快照，受 `manifest.json` 里的 SHA-256 管理，一个字节都不改；本仓库自己的规则只写在四份手写文档（README、AI-GUIDE、TASK-MAP、USAGE-POLICY）里。`pnpm check:tuffex-docs` 检查快照完整性。

界面规范见 [DESIGN](../design/DESIGN.md)，完整规范由 [docs 总入口](../README.md) 导航。
