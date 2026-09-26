# 技术文档规范

> 区分当前事实、已接受决策、未实施提议和历史材料；`docs/` 与 `app/`、`packages/` 严格对齐；仓库可能公开，docs 里任何内容都要能公开。

状态：`current` · 更新：2026-09-26 · 适用：根 `README*`、`AGENTS.md`、`docs/**`、`.agents/skills/**`

## 存放与结构

所有规范、架构、服务契约、设计决策和运维说明存放在根 `docs/`。根 README、根 AGENTS 只作导航，不建立第二份知识库。

**目录对齐规则（硬规则）**：每个 `app/<name>` 与 `packages/<name>` 对应 `docs/services/<name>/README.md`（源码地图、契约、运行方式、验证命令、已知限制），模块细节放同目录子文档。新增包必须同时补文档，缺一即视为未完成（`check-docs` 会查）。[docs/README.md](../README.md) 是 app ↔ docs ↔ 规范的三列地图；`docs/INDEX.md` 是生成物，不手工编辑。

| 目录 | 内容 |
|---|---|
| `conventions/` | 怎么协作：分支、提交、审查、Issue/PR、追踪、发版、测试、文档 |
| `services/` | 每个 `app/<name>`、`packages/<name>` 的契约与源码地图 |
| `architecture/` | 系统设计：拓扑、信任边界、安全模型、API 契约 |
| `design/` | 管理后台的界面规范与技术选型 |
| `ops/` | 本机开发、CI/CD、发布验收、部署与节点运维 |
| `decisions/` | 决策记录（ADR） |
| `components/` | 第三方组件参考（含生成快照） |

每篇技术文档的开头固定为三行：一级标题；一行引用块（一句话说明，`docs-index` 取它做索引摘要）；状态行，形如：

```text
状态：`proposed` · 更新：YYYY-MM-DD · 适用：<范围>（由 #n 实现）
```

正文至少写清事实来源或代码位置、约束和验证方法。服务与模块文档说明公开接口、依赖、数据归属、异常和测试，不只画目录树。

写法：中文平实、具体、短句；规则写成可以核对的句子；不写口号和空泛形容；不用 emoji；不写「示意」「装饰」之类的元说明。

## 状态词表

状态仅用：`current` 当前有效；`accepted` 已接受决策；`proposed` 未实施提议；`historical` 历史记录。`accepted` 不自动表示代码已经落地，正文须列实施状态。还没实现的服务契约、架构和运维文档标 `proposed`，并写明由哪个 issue 实现（写 `#n`）。

历史材料如果以后加入（例如 `docs/history/`），里面的旧路径、旧分支名、旧部署模型和数据只作历史证据：**必须显式标注历史**（状态 `historical`），不得被当作现行规范，也不得作为操作的依据。发现 current 文档与代码不一致时，先改文档再继续（见「同步规则」）。

## 事实来源

当前版本来源于 manifest、锁文件和已安装包，分清「声明范围」「锁定版本」「运行环境」「目标版本」。路线图不能写入当前技术栈。引用外部版本、标准和迁移限制时给出官方来源与核对日期（登记在 [REFERENCES](REFERENCES.md)）；未经核对不写「最新版」。未落地的目标（例如 VM 执行器、多节点调度、正式实例）只能写在 `proposed` 或明确标注「计划中，#n」的段落里，不能写成已完成。

接口来源是代码：control 各路由模块的 `contracts.ts` 与路由实现（#3 起），节点协议、TaskSpec、结果和 console API 的 DTO 来源是 `packages/protocol` 的类型与 JSON Schema。权限来源是服务端检查，不以按钮是否显示为准。机器人能对 GitHub 做什么，来源是 publisher 的白名单实现与它的拒绝用例，不以文档或提示词为准。安全文档描述防护条件和残余风险，不使用「绝对安全」「全面通过 WCAG/ASVS」等无证据结论。

## 同步规则

- 变更 control 的接口 → [API](../architecture/API.md)（节点接口是 [节点协议](../services/node/protocol.md)）+ 对应 `docs/services/*` 契约；
- 变更节点协议、TaskSpec、结果或 catalog 格式 → `packages/protocol` + [protocol 契约](../services/protocol/README.md) + [node 契约](../services/node/README.md)；
- 变更数据库结构 → [data-model](../services/control/data-model.md) + 迁移与恢复说明（#3 起）；
- 变更环境变量或端口 → env 模板（#7 引入）+ ENVIRONMENTS 与 DEPLOY（#7 写入）+ [LOCAL-DEV](../ops/LOCAL-DEV.md)；
- 变更写入白名单 → [写入白名单](../services/control/write-whitelist.md) + publisher 的允许与拒绝用例；
- 变更机器人的默认行为 → [默认行为](../services/control/behavior.md)（编号 B-xx 与配置项一览）+ [control 契约](../services/control/README.md) 的摘要；
- 变更构建或验收命令 → 根 [README](../../README.md) + [TESTING](TESTING.md) + [LOCAL-DEV](../ops/LOCAL-DEV.md)；
- 变更服务边界或目录 → [MODULAR-DEVELOPMENT](MODULAR-DEVELOPMENT.md) 与 `docs/services/**`；
- 变更文档标题、摘要或路径 → 重新生成 INDEX（`pnpm docs:index`）。

私有环境文件或工具限制访问的模板不为满足同步规则而读取，不能绕过访问限制；公开的配置说明只写占位符和通用默认值。

中文是主要规范源。英文伴随文档（`.en.md`）是明确标记的导航概要：**已有的保持同步**，不得保留与当前实现矛盾的旧版完整指令；新增规范文档不强制补 twin，只有需要英文导航时才加。规则引用优先使用相对链接；相对链接只指向已经存在的文件，还没写的文档写成纯文本「（#n 写入）」；移动后验证所有相对链接，避免复制旧目录路径。

## 第三方组件参考

组件资料统一放在 `docs/components` 下，固定来源提交、包 manifest、许可证、转换规则和文件哈希。第三方生成资料用 `reference-snapshot` 标记，它是资料属性，不覆盖 current/accepted 项目规则。

每个库提供 AI 指南、组件/机器索引和按需查询入口；总索引不重复展开数百份生成页。原始文档和源码以不可执行文本保存；普通检查不联网（`pnpm check:tuffex-docs` 按清单离线校验逐文件哈希），更新显式进行：`pnpm docs:tuffex sync --source <上游 checkout> --commit <40 位 SHA>`，步骤见 [Tuffex 来源](../components/tuffex/SOURCES.md)「更新」一节。实例见 [Tuffex 文档库](../components/tuffex/README.md)。

## 公开与内部文档

仓库以后可能公开，所以**docs 里任何内容都要能公开**，没有「内部文档」这一类：

- 不写内部主机名、IP 地址、网段、组网地址、模型网关地址、私有仓库名、组织名、真实账号名。需要时写占位：`<owner>`、`<org>/<repo>`、`https://geek-bot.example.com`、`203.0.113.10`（文档专用地址）。
- 不写私网地址字面量，包括虚拟化默认网段里的地址；写成文字描述，例如「QEMU 用户态网络的 guestfwd 地址」。确实要在代码或配置里出现的，逐条登记到 `scripts/public-safety-allow.json` 并写明理由。
- 本组织的 issue 与 PR 一律写 `#n`，不写带组织名的完整链接。
- 实例专属的非密事实（真实域名、地址、栈目录、端口、组织、账号）只放在目标机的 `.env.<环境>` 里，不进仓库、不进文档。
- 不得在任何文件里写真实 Token、密码、会话 Cookie、私钥或完整 `.env`；env 模板只放占位符和通用默认值，密钥项留空或写 `*_FILE` 路径。

`pnpm check:public-safety` 扫描私网与组网地址、组网（mesh）主机名和登记过哈希的被禁词，`pnpm check:secrets` 扫描密钥形态；它们只认识已登记的模式，**通过不等于可以公开**，作者和审查者仍要逐句看新增内容（见 [CODE-REVIEW](CODE-REVIEW.md) 第 3、9 项）。

## 验收

`pnpm docs:index` 更新索引；`pnpm check:docs` 检查索引、相对链接、每个包的服务文档、入口文件、技能符号链接与 Tuffex 快照哈希；`pnpm check:public-safety` 检查可公开性。自动检查不证明内容语义正确，审查者仍须比对代码和声明。审查报告明确命令、结果、隔离方式以及未执行的项目。
