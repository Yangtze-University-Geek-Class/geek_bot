# Tuffex 组件库本地文档

> 官方中文文档、API、Vue 示例和类型参考，供维护者和 AI 按组件与章节离线查询。

状态：`current` · 更新：2026-09-25 · 适用：`app/console` 与一切界面改动

官方入口：https://tuff.tagzxia.com/zh/docs/dev/components

## 阅读入口

先读 [AI 阅读指南](AI-GUIDE.md) 和 [项目使用政策](USAGE-POLICY.md)，再通过 [组件目录](COMPONENTS.md) 或 [任务映射](TASK-MAP.md) 选择需要的组件。版本、来源、许可与同步说明见 [SOURCES](SOURCES.md)。

## 本地查询

从 geek_bot 仓库根目录运行：

```bash
node scripts/tuffex-docs.mjs search "按钮"
node scripts/tuffex-docs.mjs search "TxDataTable" --json --limit 3
node scripts/tuffex-docs.mjs search "loading-variant" --text --limit 3
node scripts/tuffex-docs.mjs read button --section Props --max-lines 120
node scripts/tuffex-docs.mjs read installation --max-lines 180
node scripts/tuffex-docs.mjs check
```

查询不联网；结果包含路径，JSON 输出包含章节行号。`--text` 检索正文 API 和示例并返回匹配行，默认只查轻量索引。输出截断时会给出下一段的读取命令。不要一次载入整个资料库。也可以用根脚本 `pnpm docs:tuffex` 与 `pnpm check:tuffex-docs`。

## 内容结构

`reference/` 保存转换后的中文 Markdown；`snapshot/` 保存原始文档、完整 Demo、组件类型及实现，统一存为 .txt 参考，不参与业务编译。`catalog.json` 保存名称、标签、章节、示例和源码映射；`manifest.json` 保存固定提交、包版本和逐文件 SHA-256；`llms.txt` 是简短导航。

受哈希管理的文件（`reference/**`、`snapshot/**`、`catalog.json`、`COMPONENTS.md`、`llms.txt`、`SOURCES.md`）一个字节都不改，改了 `check` 就失败。本目录下只有 README、AI-GUIDE、TASK-MAP、USAGE-POLICY 四份是本仓库手写的，可以按规范修改。

`llms.txt` 与 `SOURCES.md` 由 `sync` 从固定上游提交生成，项目名取自根 `package.json` 的 `name`；要改它们的内容，改 `scripts/tuffex-docs.mjs` 里的模板后重新 sync，不手改。本仓库的事实以这四份手写文档和 [console 服务文档](../../services/console/README.md) 为准。

## 实现边界

geek_bot 的管理后台 `app/console` 全部用 Tuffex 0.6.0（Vue 3.5），由 #4 引入依赖和外壳。在那之前，本目录只是离线参考：仓库里还没有安装 `@talex-touch/tuffex`，也没有任何页面代码。

上游快照的源码包版本为 0.6.0，其 manifest 声明 Node >=26 和 Vue ^3.5.27；本仓库的运行基线是 Node 22（至少 22.13）。#4 接入时要实测 0.6.0 在 Node 22 上的安装、构建与运行，并把结论写进 console 服务文档。文档中的 since 字段不是 npm 包版本。

本目录是开发用的组件参考，不是 geek_bot 的产品使用文档。更新前先审阅上游版本差异，再显式同步并运行完整性检查；升级 Tuffex 版本单独立项。
