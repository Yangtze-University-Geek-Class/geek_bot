# 项目与协作规范

> 产品定位、五个包、授权边界、公开就绪约束、统一入口和完成定义。

状态：`current` · 更新：2026-09-26 · 适用：整个仓库；所有维护者、贡献者与 AI/Agent。

## 身份与入口

所有 AI 进入仓库的第一步是确认当前分支（`git branch --show-current`），再读 [AGENT-START](AGENT-START.md) 及 docs 必读规范；读完之前不做业务操作。分支与发布的唯一规则见 [BRANCHING](BRANCHING.md) 与 [RELEASES](RELEASES.md)：只有 `main`（正式）与 `stage`（预发布）两条长期分支；发版只靠打 tag（`vX.Y.Z-rc.N` 发预发布实例，`vX.Y.Z` 发正式实例）；人工验收先于合入 `main` 和打正式 tag；版本号不自动提升。

geek_bot 是一个可自部署的通用产品。部署者在 Web 后台用一个 GitHub 账号（一般是小号）登录，这个账号就成为机器人。它自动发现该账号能访问的所有仓库，按它在每个仓库的实际权限做事：

- 审查 PR，只发 COMMENT 类型的 review；
- 受理和跟进 issue；
- 在临时 VM 里修小改动，并开 PR。

**批准与合并始终由人来做。** 截至 2026-09-26，上述功能都还没实现：设计与决策见 [ARCHITECTURE](../architecture/ARCHITECTURE.md) 和 ADR-0002 到 ADR-0009（#2），实现由 #3–#21 逐项交付。

根包名 `geek_bot`（`version` 从 `0.1.0` 起，`private: true`，`packageManager: pnpm@9.15.9`，Node `>=22.13.0 <23`）。所有开发与验收命令都从仓库根目录运行。工作区有五个包，每个包都有一份服务契约，放在 [docs/services](../services/README.md)：

| 目录 | 包名 | 职责 |
|---|---|---|
| `app/control` | `@geek-bot/control` | 控制面。Fastify 5 + better-sqlite3（#3 引入）。唯一的 SQLite 写入者、唯一的 GitHub 写入者（publisher 白名单 + outbox）；负责登录、令牌加密存放、仓库发现、轮询、调度、模型中继；同源托管 console 的静态产物。见 [control](../services/control/README.md) |
| `app/console` | `@geek-bot/console` | 管理后台。Vue 3.5 + vue-router 4 + @talex-touch/tuffex 0.6.0 + Vite 7（#4 引入外壳）。不用原生下拉框和复选框，不用 emoji。见 [console](../services/console/README.md) |
| `app/node` | `@geek-bot/node` | 工作节点代理。只向外连 control（HTTP 长轮询 `/api/node/v1`），不开入站端口；管理 issue 通道的无网只读 sandbox 容器和 PR 通道的一次性 QEMU/KVM VM。见 [node](../services/node/README.md) |
| `app/runner` | `@geek-bot/runner` | 在 sandbox 或 VM 里驱动 omp 的单文件程序，只用 Node 标准库。见 [runner](../services/runner/README.md) |
| `packages/protocol` | `@geek-bot/protocol` | 纯类型加 JSON Schema（节点协议、TaskSpec、结果、RepoProfile、catalog 文件契约、console API DTO）。任何 app 都可以导入它；它不导入任何 app。见 [protocol](../services/protocol/README.md) |

四个 app 之间互不导入实现，只经 `@geek-bot/protocol` 共享契约；runner 程序（`app/runner/src`）除 `@geek-bot/protocol` 的类型导入外不导入任何 npm 包。边界由 `pnpm check:boundaries` 强制，细节见 [MODULAR-DEVELOPMENT](MODULAR-DEVELOPMENT.md)。本仓库骨架（#1）不引入任何生产依赖；表里标「计划中」的框架由对应 issue 引入，引入前需要所有者批准。

## 公开就绪

仓库以后可能公开，所以从现在起按公开仓库的标准写：

- 代码、文档、测试、夹具、提交信息里都不写组织名、真实仓库名、内部主机名、内网或组网地址、模型网关地址、真实账号名。需要举例时用占位：`<owner>`、`<org>/<repo>`、`https://geek-bot.example.com`、`203.0.113.10`（RFC 5737 文档地址）。
- 不写死任何只属于某个组织的东西：追踪记录格式、审查规范、标签名、仓库名都做成配置或可修改的默认值。
- 引用本仓库的 issue 与 PR 只写 `#n`，不写带组织名的完整链接。
- 私网地址不写成字面量，写成文字描述（例如「QEMU 用户态网络的 guestfwd 地址」）；确实需要字面量的，登记到 check-public-safety 的允许清单并写明理由。
- 实例专属的真实非密值只放在目标机上，不进仓库；密钥一律经 `*_FILE` 挂载的文件提供（见根 [AGENTS](../../AGENTS.md) §3）。

`pnpm check:public-safety` 在本地和 CI 里拦截私网、CGNAT 与链路本地地址、组网内部域名形式的主机名，以及按哈希登记的被禁词（组织名、内部主机名、真实公网地址等）；它只覆盖这些模式，通过不等于没有泄漏，审查时仍要人眼看一遍新增的字符串和占位写法（[CODE-REVIEW](CODE-REVIEW.md)）。

仓库真正公开之前，还要满足 [ADR-0001](../decisions/0001-standalone-product.md) 列出的条件：选定许可证并提交 `LICENSE`、提交 `SECURITY.md`、全仓库通过公开安全检查、提交历史里没有内部信息（#21 负责核对）。

## 变更边界

先确认分支、HEAD 和未提交改动，保留他人工作。一次改动要有可描述的目标、受影响的包、契约变化和验收方式；不能以「清理」为名混入未要求的产品改版、依赖升级或数据重置。

普通代码任务可以修改源码、测试、配置模板和文档。下列动作都需要对应动作和目标的明确授权：

- 提交、推送、合并、打发布 tag、发布；
- 在目标机运行部署脚本，或修改任何实例的配置；
- 读取真实密钥、机器人账号令牌或模型网关密钥；
- 操作任何实例的数据库；
- 让机器人账号在任何真实仓库里写入（评论、标签、分支、PR、关闭 issue）；
- 新增生产依赖。

不得把正式实例当作开发捷径。开发前先开 issue，见 [ISSUES](ISSUES.md)。

## 语言与一致性

中文协作，代码标识符用英文，用户文案以中文为主。提交消息只遵循 [COMMITS](COMMITS.md)，不存在另一套英文提交规则。界面规范以 [DESIGN](../design/DESIGN.md) 与 [STACK](../design/STACK.md) 为准，不自行加入深色主题、SSR 或多语言框架。命令行输出和报错写中文。

## 变更完成定义

- 代码与契约一致；
- 相关回归测试覆盖正确路径和失败路径；
- 根 `pnpm verify` 通过；
- 涉及浏览器行为时，提供真实浏览器的结果；
- 文档与代码在同一改动里更新；
- 工作区差异只包含授权范围内的内容。

未完成的环境验收必须单独列出，不得标为 PASS。类型检查、mock 预览、构建成功、浏览器通过和线上验收是不同的证据，不能相互替代。既有测试失败要定位原因，不能靠删除断言、复制处理器、伪造返回值或固定退出码来解决。

## Agent 入口与适配器

**只有根 [AGENTS.md](../../AGENTS.md) 一个 agent 入口。** 不维护 `CLAUDE.md`、`GEMINI.md`、`CONVENTIONS.md`、`.clinerules`、`.cursorrules`、`.windsurfrules`、`.cursor/rules/*`、`.github/copilot-instructions.md` 等第二份规则来源，也不新增模块级规则文件（包括模块级 `AGENTS.md`）。

技能只有一个实现，放在 `.agents/skills/<name>/`；其它 CLI 用自己的目录建符号链接指向它（`.omp/skills/<name>`、`.claude/skills/<name>`），不复制内容。现有技能：[code-review](../../.agents/skills/code-review/SKILL.md)。

服务文档只引用根入口与对应规范，不复制全局规则。文档结构（`app/<name>`、`packages/<name>` 与 `docs/services/<name>` 严格对齐）见 [DOCUMENTATION](DOCUMENTATION.md) 与 [MODULAR-DEVELOPMENT](MODULAR-DEVELOPMENT.md)。
