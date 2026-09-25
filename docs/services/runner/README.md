# runner 服务契约（`app/runner`）

> 在 sandbox 容器或一次性 VM 里驱动 omp 的单文件程序，只用 Node 标准库。

状态：`proposed` · 更新：2026-09-25 · 适用：`app/runner`（`@geek-bot/runner`）、`tests/runner`

## 职责

- 解开任务包，剔除仓库里的 `.omp/`、`.claude/`、`.cursor/`、`mcp.json`、`.env*`，准备干净的 HOME 和 overlay 配置。
- 用钉死的 omp 版本运行任务：`--no-extensions`、`--no-lsp`、工具白名单；issue 通道只给 read、grep、glob。
- 把 omp 的 JSONL 输出原样转发给节点；本轮已有输出后失败时，按模型池换下一个模型从头重跑（外层降级）。
- 抽取并校验结构化结果（审查、分诊、补丁），交回节点。
- 只用 Node 标准库，产物是单文件 `dist/runner.mjs`；不持有任何 GitHub 凭据，只有本任务的模型令牌。

## 现在有什么

#1 只建最小源码，不调用 omp，只有 omp 参数的拼装：

| 路径 | 内容 |
|---|---|
| `app/runner/package.json` | 包名 `@geek-bot/runner`，依赖 `@geek-bot/protocol: workspace:*`（只做 type 导入）；脚本 `typecheck`（`tsc --noEmit`）、`build` |
| `app/runner/tsconfig.json` | 继承根 `tsconfig.base.json`，`src/` 编译到 `dist/` |
| `app/runner/src/omp-args.ts` | `buildOmpArgs({ channel, prompt })`：两条通道都返回 `-p <prompt> --mode json --no-extensions --no-lsp --approval-mode yolo`；issue 通道另加 `--tools read,grep,glob`（常量 `ISSUE_CHANNEL_TOOLS`）；pr 通道目前不带 `--tools`，这是已知差距，见「已知限制」。提示为空或以 `-` 开头时拒绝。对 `@geek-bot/protocol` 只 type 导入 `Channel` |
| `app/runner/src/index.ts` | 包入口，只导出上面的函数和常量 |
| `tests/runner/omp-args.test.ts` | 两条通道的共同参数、issue 通道的工具白名单、pr 通道目前不带 `--tools`、每次返回新数组、非法输入 |

新增或删除文件时同步更新本表。

## 计划中的模块与对应 issue

| 模块（计划路径） | 内容 | issue |
|---|---|---|
| `src/{bundle,overlay,models-yml,omp-args}.ts` | 解包与剔除、干净 HOME、overlay、models.yml、omp 参数 | #14 |
| `src/{events,fallback}.ts` | JSONL 转发、外层降级分类（429、5xx、超时降级；上下文溢出和取消不降级） | #14 |
| `src/result.ts`、`prompts/review.md` | 审查结果抽取与校验 | #15 |
| `prompts/{triage,followup}.md` | issue 分诊与跟进 | #16 |
| 在 VM 内运行 | 与 VM 执行器对接，运行仓库画像里声明的校验命令；PR 通道的工具白名单（清单来自 TaskSpec 的 omp 参数） | #17 |
| `prompts/{fix,rework}.md` | 修复与返工，产出补丁 | #18 |
| `prompts/profile.md` | 规则画像提取 | #10、#14 |
| 单文件打包 | 产物 `dist/runner.mjs`，打进节点镜像和 VM 基础镜像 | #14、#17 |

## 接口与数据归属（计划中）

- 输入：节点准备好的任务包（`repo/`、`diff.patch`、`rules/`、提示词、overlay、models.yml 模板、meta.json）和本任务的模型令牌。
- 输出：事件流（JSONL，按行）和一份结构化结果；结果的 schema（review.v1、triage.v1、patch.v1）定义在 `@geek-bot/protocol`。
- runner 不保存任何状态；任务结束后工作目录随 sandbox 容器或 VM 一起删除。

## 验证

```bash
pnpm --filter @geek-bot/runner typecheck
pnpm exec vitest run tests/runner
```

`pnpm check:boundaries` 检查 runner 没有导入任何 npm 包（`@geek-bot/protocol` 的 type 导入除外）。

## 已知限制

- #1 没有实现任何 omp 调用；上文的模块和接口都是计划。
- pr 通道还没有工具白名单：`buildOmpArgs` 在 pr 通道不带 `--tools`，不符合 [SECURITY](../../architecture/SECURITY.md) S-04 和 [ARCHITECTURE](../../architecture/ARCHITECTURE.md)「执行隔离」一节对 VM 里 omp 使用工具白名单的要求；一次性 VM 和工具白名单两层都要有，VM 不能代替白名单。白名单由 #17 加入，工具清单来自 TaskSpec 的 omp 参数（TaskSpec 由 #11 定义）；在那之前，真实任务不能使用 pr 通道这组不带 `--tools` 的参数。#15 的审查过渡期在只读 sandbox 里执行，同样不能沿用这组参数：实现 #15 时要么给审查任务单独配只读工具白名单，要么把 #17 的白名单提前到 #15。
- omp 在本轮已有输出后失败时以退出码 1 结束、不会自己降级，这是外层降级存在的原因；具体分类以 #14 的夹具测试为准。
- 宿主的用户级规则曾经漏进 omp 的回复；干净 HOME 是必须的，由 #14 的探针测试证明。
