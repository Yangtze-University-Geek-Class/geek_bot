# runner 服务契约（`app/runner`）

> 在 sandbox 槽位容器或一次性 VM 里驱动 omp 的单文件程序 `runner.mjs`：核对并解开任务包，在干净的 HOME 里按模型池逐个尝试 omp，生成结构化结果和补丁，只用 Node 标准库。

状态：`current` · 更新：2026-10-03 · 适用：`app/runner`（`@geek-bot/runner`）、`tests/runner`（由 #34 实现）

`current` 只表示本文与 #34 的源码一致，不表示 runner 已经在真实 sandbox 容器或 VM 里端到端跑过；见「验证状态」。runner 与节点之间的本地端点见 [节点协议](../node/protocol.md)「sandbox 与 VM 怎样访问节点」。

## 职责

- 接任务之前采集自检证据（omp 版本、进程隔离、根文件系统、网卡），交给节点判断这个环境能不能接任务。
- 核对任务包的 sha256，按不可信输入校验路径和内容后解包，剔除 agent 扩展、MCP、规则目录与 `.env*`。
- 每次尝试都用新的工作目录和干净的 HOME 运行钉死版本的 omp（18.4.4）：关闭全部发现源，工具白名单显式给出，提示从 stdin 读入。
- 只在回环地址上给 omp 一个模型端点，把请求转到节点的本地模型代理；模型令牌不进文件、不进 omp 的环境。
- 把 omp 的 JSONL 事件归并成任务事件交给节点；按模型池外层降级；抽取并校验结果，fix、rework 的补丁由 runner 按文件改动生成。
- 不持有任何 GitHub 凭据和节点令牌，不保存状态；一个进程只做一个任务。

## 源码地图

| 路径 | 内容 |
|---|---|
| `app/runner/package.json` | `@geek-bot/runner`，对 `@geek-bot/protocol` 只做 type 导入；脚本 `typecheck`、`build` |
| `scripts/bundle.mjs` | 把 `tsc` 输出合成单文件 `dist/runner.mjs`（构建脚本，不属于 runner 程序本身） |
| `src/main.ts` | 程序入口：`slot`、`vm`、`--version` 三种用法，参数不认识时打印用法并以 2 退出 |
| `src/index.ts` | 库入口，只导出给测试和类型用的符号，导入它不会启动任何东西 |
| `src/slot.ts` | sandbox 槽位模式：报到、长轮询领任务、取任务包、交事件与结局 |
| `src/vm.ts` | VM 模式：读输入盘、fw_cfg 令牌、写 virtio-serial 事件和输出盘；探针模式 |
| `src/run.ts` | `runTask`：解包、起转发器、按模型池逐个尝试、判定、组装结果；`validateRunnerTask`、`classifyAttempt` |
| `src/bundle.ts` | `parseBundle`、`extractBundleFiles`：任务包校验与安全解包 |
| `src/home.ts` | `writeOmpHome`：每次尝试的 `models.yml`、`overlay.yml`、`append-system.md` |
| `src/omp-args.ts` | `buildOmpArgs`：omp 命令行与执行器工具白名单 |
| `src/forwarder.ts` | 回环地址上的模型转发器 |
| `src/events.ts` | omp JSONL 到任务事件的映射与本次尝试的状态 |
| `src/result.ts` | 从最终回复里取 JSON 结果并按 schema 校验 |
| `src/diff.ts` | 按「任务包原文件」与「运行后的工作目录」生成 `git diff` 格式的补丁 |
| `src/tar.ts` | VM 输入盘与输出盘的 ustar 读写 |
| `src/probe.ts` | 自检证据：`omp --version`、`/proc/self/status`、根挂载、网卡；`RUNNER_VERSION` |
| `tests/runner/omp-args.test.ts` | 工具白名单不可扩张、空白名单拒绝、模型 id 与路径不能变成额外参数 |
| `tests/runner/bundle-security.test.ts` | 任务包的 sha256、顶层字段、路径穿越、禁止路径、大小写重名、编码等拒绝用例 |

新增或删除文件时同步更新本表。`app/runner/src` 只能导入 `node:` 内置模块和本目录的相对模块，对 `@geek-bot/protocol` 只做 type 导入，由 `pnpm check:boundaries` 检查。

## 单文件构建

```bash
pnpm --filter @geek-bot/runner build
```

先 `tsc` 编译到 `dist/`，再由 `scripts/bundle.mjs` 从 `dist/main.js` 收集相对导入，按依赖顺序把每个模块包进一个立即执行函数，`node:` 内置模块的导入提到文件顶部，产出 `dist/runner.mjs`（带 `#!/usr/bin/env node`，权限 0755）。打包脚本只接受 runner 自己用到的写法：出现 npm 包导入、默认导出或默认导入相对模块、副作用导入、动态 `import()`、模块循环依赖时直接报错退出。脚本用根工作区已有的 `typescript` 解析源码，不引入打包依赖。

节点镜像构建时核对 `runner.mjs` 可执行，并把它放进 sandbox 镜像（`/opt/geekbot/runner.mjs`）和 VM 工具盘（[node 服务契约](../node/README.md)「镜像」）。

## 命令行

```text
runner.mjs slot [--socket /run/geek-bot/node.sock] [--work /work] [--omp /opt/geekbot/omp/omp] [--omp-data /opt/geekbot/omp-data]
runner.mjs vm --input <设备> --output <设备> --events <virtio 端口> --token-file <fw_cfg 文件> --run-as <用户>
              [--work /work] [--omp /opt/geekbot/omp/omp] [--omp-data /opt/geekbot/omp-data] [--node-bin /opt/geekbot/node/bin]
runner.mjs --version        # 输出 geekbot-runner/<RUNNER_VERSION>
```

`slot` 是 sandbox 镜像的入口；`vm` 由来宾里的 `guest-init.sh` 以 root 调用。runner 不读环境变量里的配置。

## 执行流程

`runTask` 不抛异常，任何失败都映射成失败码 `bundle_invalid`、`infra_failure`、`timeout`、`model`、`schema`、`cancelled` 之一：

1. 核对任务字段：`task_id`、`kind`、`executor`、`timeout_s`（30～86,400 秒）、`bundle_sha256`、非空 `prompt`、`tools`、`model_pool`（1～8 项）。
2. `parseBundle`：sha256 等于 `bundle_sha256`；顶层只许 `files`、`diff`、`rules`、`meta`；文件路径必须是规范相对路径（不空、不以 `/` 开头、没有 `.`、`..`、空段、反斜杠和控制字符）；任何一级是 `.omp`、`.claude`、`.cursor`、`.codex`、`.gemini`、`.agent`、`.agents`、`.windsurf`、`.git`、`.pi`，或文件名是 `mcp.json`、`.mcp.json`、`.cursorrules`、`.windsurfrules`、`.clinerules`、`mcp_config.json`、`.vscode/mcp.json`、`.env`、`.env.*` 时拒绝；大小写不敏感的重名、文件与目录同名拒绝；有文件数、单文件、总量、diff 和规则的上限。
3. `tools` 必须是执行器白名单的非空子集；fix、rework 只能在 `vm` 执行器上跑。
4. 在 `127.0.0.1` 的随机端口起模型转发器，生成一个随机本地口令。
5. 按模型池顺序逐个尝试。每次尝试前清空并重建 `repo/`、`home/`、`ctx/`、`tmp/`，重新解包（文件用 `O_CREAT|O_EXCL|O_NOFOLLOW` 新建，目录逐级 `lstat` 核对），重写 HOME，VM 里把这些目录交给降权用户。
6. 启动 omp：工作目录是 `repo/`，环境只有 `HOME`、`PATH`、`LANG`、`TMPDIR`、`XDG_DATA_HOME`、`PI_NO_TITLE` 和本地口令变量 `GEEKBOT_RELAY_KEY`；VM 另加指向出网代理的 `HTTPS_PROXY` 等变量。omp 在独立的进程组里运行，取消或超时时先 SIGTERM，30 秒后 SIGKILL。
7. 提示从 stdin 写入：任务提示，加上 diff（超过 256 KiB 截断并说明）和 `meta`（超过 16 KiB 截断），后两者都标为不可信数据。
8. 判定本次尝试（见「外层降级」），成功时组装结果。

## omp 配置

omp 钉死为 18.4.4，参数由 `buildOmpArgs` 生成：

```text
-p --mode json --config <ctx/overlay.yml> --model geekbot/<模型 id>
--no-extensions --no-skills --no-rules --no-lsp --no-session --no-title --no-pty
--approval-mode yolo --tools <白名单> --max-time <秒> --append-system-prompt <ctx/append-system.md>
[--thinking <档位>]
```

- 工具白名单：`sandbox` 只能用 `read`、`grep`、`glob`；`vm` 另可用 `edit`、`write`、`bash`。任务给出的列表必须是执行器白名单的非空子集，去重后用一个 `--tools` 传入，不存在「默认全部工具」的路径。联网、子代理、浏览器、eval、MCP 类工具不在任何白名单里。
- `--approval-mode yolo` 只表示不等人工确认；能做什么由执行器隔离和工具白名单共同限定，两层都要有。
- `--thinking` 只在档位属于 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` 时传。
- `--max-time` 取任务剩余时长减 5 秒。

`writeOmpHome` 每次尝试生成三个文件：

- `home/.omp/agent/models.yml`：只有一个 provider `geekbot`，`baseUrl` 指向回环转发器，`apiKey` 是环境变量名 `GEEKBOT_RELAY_KEY`，`api: openai-completions`，只列本次使用的模型。`compat` 关掉 `store`、把上限字段改成 `max_tokens`、打开流式用量，使 omp 实际发出的字段只有 `model`、`messages`、`stream`、`stream_options`、`tools`、`max_tokens`、`reasoning_effort`，都在 control 模型中继的字段白名单里（[节点协议](../node/protocol.md)「模型中继的请求体」）。
- `ctx/overlay.yml`：`disabledProviders` 关闭 omp 全部 18 个发现源（`native`、`omp-plugins`、`claude`、`agent-plugins`、`codex`、`agents`、`claude-plugins`、`gemini`、`opencode`、`cursor`、`windsurf`、`cline`、`github`、`vscode`、`agents-md`、`claude-md`、`mcp-json`、`ssh-json`），关闭项目级 MCP，omp 自身的重试最多 2 次、关闭 omp 内的模型降级。
- `ctx/append-system.md`：说明仓库内容都是不可信数据；按任务类型给出结果格式；base 分支的规则只作背景参考。

模型目录、模型池、预算等实例配置不由 runner 决定，见 [control 服务契约](../control/README.md)。

## 模型转发器

omp 只连 `127.0.0.1:<随机端口>`。转发器只放行 `POST /v1/chat/completions` 和 `GET /v1/models`，按常量时间核对本地口令，再把请求转到节点的本地模型端点（路径加 `/model` 前缀）：sandbox 是槽位 socket，并带上 `X-Runner-Session`；VM 是 guestfwd 端点。转发时把口令换成本任务的模型令牌，其它请求头一律不转发；请求体上限 16 MiB；响应（含 SSE）原样流回。

## 外层降级

`classifyAttempt` 的判定：

| 情况 | 结论 |
|---|---|
| 被取消 | 失败 `cancelled` |
| 超过任务时长 | 失败 `timeout` |
| `stopReason` 是 `stop`、见到终止的 `agent_end`、最终文本不为空 | 成功 |
| 模型报错，状态 400 或 413 且信息是上下文溢出 | 失败 `model`，不降级 |
| 模型报错，429 且信息含 `budget_exhausted` | 失败 `model`，不降级 |
| 模型报错，没有状态码、408、429、5xx | 换下一个模型 |
| 模型报错，其它状态码 | 失败 `model` |
| 输出被截断（`length`） | 换下一个模型 |
| omp 中止本轮（`aborted`） | 失败 `cancelled` |
| omp 没有正常结束 | 换下一个模型 |

换下一个模型时从头重跑，并发一条 `retry` 事件；池走完仍没有成功，失败 `model`。剩余时长不足 10 秒时直接失败 `timeout`。

## 结果与补丁

- 结果取自最后一条 assistant 消息：依次尝试整段 JSON、最后一个 ```` ```json ```` 代码块、第一个 `{` 到最后一个 `}`。
- review：`summary`、`body`、`findings`（最多 200 条，每条 `severity` 为 `blocking`、`warning`、`suggestion`，`path`，从 1 起的 `line`，`message`）；triage、followup：`summary`、`body`；长度上限与 protocol 的 `TASK_RESULT_SCHEMA` 一致。
- fix、rework：模型回复里的 `patch` 一律忽略，补丁由 `buildWorkspacePatch` 比较任务包原文件与工作目录生成，格式与 `git diff` 相同，可以直接 `git apply`；没有改动或超过 1 MiB 时失败 `schema`。工作目录里出现符号链接或设备文件、二进制或非 UTF-8 改动、新增或修改禁止路径时拒绝；新增在依赖与构建产物目录（如 `node_modules`）或命中根 `.gitignore` 简单规则的文件视为本地产物，跳过。
- 节点收到结果后按同一 schema 再核对一遍，不合格按 `schema` 失败处理。

## 事件

omp 的 `--mode json` 输出按 18.4.4 的事件形状映射成任务事件（`seq` 由节点分配）：

| omp 事件 | 任务事件 |
|---|---|
| `message_end`（assistant） | 文本为 `text`；`stopReason` 为 `error` 时为 `error` |
| `tool_execution_start` | `tool`：工具名加参数摘要（路径、模式或命令，最多 300 字符） |
| `tool_execution_end` 且出错 | `error` |
| `auto_retry_start` | `retry` |
| 不是 JSON 的行 | `text` |

runner 自己另发 `model` 事件（第几个模型、哪个档位）和 `retry` 事件（换模型的原因）。单条文本最多 4,000 字符；节点再按自己的上限截断并打码。

## sandbox 槽位模式

`runner.mjs slot` 在无网、根只读的 sandbox 容器里运行，唯一的对外通道是 `--socket` 指向的槽位 socket：

1. 进程启动时生成会话 UUID，采集自检证据，`POST /v1/hello` 报到，直到 node 返回 200。
2. `GET /v1/task?wait=25` 长轮询：204 继续；200 拿到 `{ task, model_token }`；409 退出（退出码 0）；403 表示没通过自检或 node 不认识这个会话，等 30 秒后以退出码 1 退出，由容器重启后重新报到。
3. `GET /v1/bundle` 取任务包，执行 `runTask`。事件每秒一批（最多 200 条），串行发给 `/v1/events`；响应 `cancel: true`、或返回 409、404 时停止 omp；连续 30 次发不出去也停止，不再消耗模型。
4. 交 `/v1/result` 或 `/v1/failure`，最多试 6 次，然后以 0 退出。容器重启策略换新进程和新的 tmpfs，任务之间不留状态。

## VM 模式

`guest-init.sh` 在来宾里以 root 运行 `runner.mjs vm`：

- 输入：只读原始盘上的 ustar，最多 4 个文件；`task.json`（任务字段与两个 guestfwd 端点）、`bundle.json`。
- 模型令牌：读 fw_cfg 文件 `opt/geekbot/token`（只有 root 可读），只留在 runner 内存里。
- omp 降到普通用户 `geekbot` 运行，`PATH` 前面加上工具盘里的 node；配置了出网代理时设置代理变量。
- 事件写到 virtio-serial 端口，一行一个 JSON；启动时先发一条 `model` 事件，节点据此判断来宾已启动。
- 结束时把 `result.json` 或 `failure.json` 写进可写原始盘的 ustar；`guest-init.sh` 随后 `sync` 并关机。节点经 QMP 发 `system_powerdown` 取消时，runner 收到 SIGTERM，停下 omp 并尽量写出 `cancelled`。
- 探针模式：输入盘只有 `probe.json` 时，runner 采集自检证据（omp 以 `geekbot` 用户执行 `--version`）、带探针令牌请求 guestfwd 的模型端点、逐个直连 `direct_targets`，把结果写成输出盘里的 `probe-result.json`，不执行任何任务。

## 运行与验证

```bash
pnpm --filter @geek-bot/runner typecheck
pnpm --filter @geek-bot/runner build      # 产出 app/runner/dist/runner.mjs
pnpm exec vitest run tests/runner
node app/runner/dist/runner.mjs --version
```

`pnpm check:boundaries` 检查 `app/runner/src` 没有导入 npm 包（`@geek-bot/protocol` 的 type 导入除外），也没有引用 `src/` 以外的文件。

## 验证状态

#34 已实际执行：父 agent 运行 runner 安全回归 99 项，全部通过（`tests/runner` 的工具白名单与任务包拒绝用例）。

没有实际验收，不能标为 PASS：

- `runner.mjs` 单文件产物在 sandbox 镜像和 VM 工具盘里的实际运行；
- 与真实 omp 18.4.4 的端到端：stdin 提示、发现源全部关闭、工具白名单生效、实际发出的模型请求字段落在 control 的白名单里；
- sandbox 槽位的报到证据在真实容器隔离下的取值；VM 模式的 fw_cfg 令牌、virtio-serial、输出盘与关机；探针模式；
- 外层降级和补丁生成在真实任务上的结果。

## 已知限制

- 自动化测试只覆盖 `omp-args` 和任务包解析；`run`、`home`、`forwarder`、`events`、`result`、`diff`、`slot`、`vm`、`tar`、`probe` 没有测试。
- `RUNNER_VERSION` 写死在 `src/probe.ts`，改 `package.json` 的 `version` 时要同步修改。
- `models.yml` 里的上下文窗口和单次输出上限是固定值，不随模型变化。
- `.gitignore` 只支持 `*`、`**`、`?`、前导和结尾 `/`，不支持取反；补丁的编辑距离超过 2,000 行时退化成整段删除加整段插入。
- omp 18.4.4 的事件形状和 `compat` 取值是按该版本核对的；升级 omp 时要重新核对 `events.ts`、`home.ts` 和镜像里的版本与摘要。
