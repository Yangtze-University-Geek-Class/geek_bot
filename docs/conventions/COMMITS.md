# Commit 提交规范

> Conventional Commits 结构，中文说明，一次提交一个可回滚目的。

状态：`current` · 更新：2026-09-26 · 适用：本仓库的所有提交，包括 PR 标题与机器人账号的提交。

## 格式

```text
<type>(<scope>): <中文简述>

为什么改；改变了什么；用什么命令验证。

Refs #<issue>
```

首行不超过 72 字符，使用半角冒号，不加句末句号或 emoji。代码标识符和路径保持英文。结尾用 `Refs #<issue>` 指向对应 issue（[TRACKING](TRACKING.md) §2）。

type 为 `feat`、`fix`、`refactor`、`perf`、`docs`、`test`、`build`、`ci`、`chore`、`style`。`style` 只表示格式，不表示界面功能改动。

scope 只用下表的词，按职责中心选一个，不罗列全部文件：

| scope | 指什么 |
|---|---|
| `control` | `app/control`：控制面（登录、令牌、仓库发现、轮询、调度、写入出口、模型中继） |
| `console` | `app/console`：管理后台 |
| `node` | `app/node`：工作节点代理、sandbox 与 VM 管理 |
| `runner` | `app/runner`：在 sandbox 或 VM 里驱动 omp 的程序 |
| `protocol` | `packages/protocol`：共享类型与 JSON Schema |
| `deploy` | 部署模板、compose、env 模板、部署脚本 |
| `docs` | `docs/`、根 README 与 AGENTS.md |
| `notes` | 只补 `notes/` 执行记录的提交（开 PR、拿到审查结论后补记，写成 `docs(notes): …`，见 [NOTES](NOTES.md)）；记录和代码一起提交时用代码的 scope |
| `tooling` | 根脚本、`scripts/`、`.githooks/`、`.github/` 工作流与模板 |
| `deps` | 依赖与锁文件变更 |
| `release` | 版本号与发布相关的改动 |
| `security` | 跨包的安全修复或加固（令牌、写入白名单、隔离、密钥扫描）；只属于一个包的，用那个包的 scope |

例：

- `fix(control): 轮询收到 304 时不再重复入队`
- `test(node): 验证租约过期后节点放弃任务并上报`
- `feat(console): 仓库列表显示机器人在每个仓库的权限`
- `docs(tooling): 统一根目录验收入口`
- `fix(security): 写入出口拒绝 event 为空的 review`
- `docs(notes): 补记 #12 的审查结论`

## 原子性与兼容性

一个提交对应一个可以独立理解、独立回滚的逻辑目的。代码和它的契约、测试、文档属于同一改动。机械搬迁和行为改变在条件允许时分开，但不能故意制造不可构建的中间状态。兼容性变更用 `!` 或 `BREAKING CHANGE:` 正文说明影响和迁移（节点协议、`@geek-bot/protocol` 的 schema、数据库迁移都算）。

不使用 `update`、`fix bug`、`WIP` 等没有信息量的消息，不批量加入无关改动。旧提交不回写，不自动 squash 他人历史。Agent 不在没有明确授权时创建或推送提交。

## 提交不等于发版

Conventional Commits 只规定消息结构，不自动计算或推进本项目的发布版本。分支模型（`main`/`stage`/`task/<issue>/<slug>`/`dev/<username>`）、人工验收与版本展示的唯一约定见 [BRANCHING](BRANCHING.md) 与 [RELEASES](RELEASES.md)。禁止为了自动 changelog 或 semantic-release 越过人工试用与批准，也禁止把 `feat`/`fix` 当作自动升号或自动部署的依据。

依据：Conventional Commits 1.0.0 的消息结构；中文简述和 scope 词表是本项目的约定，不是该标准的语言要求。官方来源：https://www.conventionalcommits.org/en/v1.0.0/
