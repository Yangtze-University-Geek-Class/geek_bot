# geek_bot 安全不变量

> 任何实现都不能打破的安全约束清单：令牌怎么存、密钥在哪、执行环境里没有什么、谁能写 GitHub、规则从哪读。

状态：`proposed` · 更新：2026-09-25 · 适用：全部 `app/*`、`packages/protocol` 与部署文件 · 由 #2 定稿

本文列的是设计要求，还没有任何一条被代码实现。#2 补齐信任边界、密钥表（放在哪、谁能读、泄露后果、如何轮换）和残余风险并定稿；每条不变量由括号里的 issue 实现，并用测试证明。改动涉及 GitHub 令牌、写入白名单、VM 或 sandbox 隔离时，必须先读本文。

架构背景见 [ARCHITECTURE](ARCHITECTURE.md)；密钥扫描与公开安全检查见 [TESTING](../conventions/TESTING.md)。

## 不变量

**S-01 机器人令牌加密存放。** 机器人的 GitHub 令牌只以 AES-256-GCM 密文存在 control 的库里；只有 publisher 和 GitHub 读取层能解密。令牌永远不下发到浏览器，也不写进日志、审计、事件、备份明文和任何发往节点的数据。master key 以文件挂载，只给 control，不进备份。（#5、#3）

**S-02 模型网关密钥只在 control。** 网关密钥以 `*_FILE` 文件只挂给 control。节点、sandbox、VM 都拿不到它；它们只拿到每任务模型令牌，令牌限定池内模型、请求与 token 预算和租约期，租约结束即失效，库里只存哈希。（#13）

**S-03 执行环境里没有 GitHub 令牌。** node、sandbox 容器和 VM 里都没有任何 GitHub 凭据；任务包由 control 从镜像克隆打好，节点不需要访问 GitHub。修复结果以补丁带回，由 control 提交和推送。出网代理默认不放 GitHub 的域名，防止外传私有代码。（#11、#14、#17、#18）

**S-04 VM 干净 HOME，omp 不加载仓库扩展。** VM 与 sandbox 里是干净的 HOME，宿主的用户级规则不能漏进去；omp 用 `--no-extensions`、`--no-lsp` 和工具白名单，关闭项目级 MCP 配置；任务包剔除仓库里的 `.omp/`、`.claude/`、`.cursor/`、`mcp.json`、`.env*`。（#14、#17）

**S-05 仓库内容是不可信输入。** 目标仓库的代码、issue、PR、评论，以及模型据此生成的输出，都视为可能带提示注入的不可信输入：

- 从不在 control 里执行仓库代码；issue 通道不执行任何代码，PR 通道只在一次性 VM 里执行；
- VM 访问不到宿主和内网，只能经白名单代理访问包源，域名解析后拒绝私网、CGNAT、链路本地和回环地址；
- 发布前对模型输出做中和：去掉 HTML 注释、中和机器可解析的结论行和 `Closes #n`、转义 @ 提及、按密钥形态打码；
- 后台按纯文本渲染来自 GitHub、omp、节点的文本，只有审查预览走显式净化。

（#9、#14、#17）

**S-06 publisher 是唯一写出口。** 对 GitHub 的每一次写入都只经 control 里的 publisher，默认拒绝、逐项白名单：

- review event 只能是字面量 `COMMENT`，不批准、不请求修改、不合并；
- 只关 issue，不关 PR；人重开过的 issue 不关；
- git push 只推机器人分支、只快进、带 `--no-tags`，不推默认分支和 base 分支，不改 `.github/workflows/**`；
- 不在白名单里的写入一律拒绝并写审计；
- outbox 保证同一件事不重复写，结果未知的写入先核对再决定是否重发；
- preview 实例只能写配置的沙盒仓库。

后台会话本身不能直接写 GitHub。白名单的编号清单由 #2 写入，每一条都要有拒绝测试。（#9）

**S-07 免费计划没有服务端护栏。** 免费计划的私有仓库没有分支保护和 rulesets，OAuth `repo` scope 也不能按仓库收窄，所以令牌理论上能推主干、打 tag、合并。S-06 是唯一的防线，不能假设 GitHub 会拦住越权写入；任何放宽 publisher 白名单或申请更大 scope 的改动都要所有者批准。（#5、#9）

**S-08 规则只读 base 分支。** 仓库规则文件一律从默认分支或配置的 base 分支按 blob sha 读取，从不从 PR head 读取；打任务包时，head 上的 `AGENTS.md`、`CLAUDE.md`、`CONTRIBUTING*`、`.github/*template*`、`.github/geek-bot.yml` 用 base 版本覆盖，PR 不能借修改规则文件放松审查。机器可执行的字段只取自结构化配置；能力开关和安全限制按「两边取更严」合并，后台只能收紧、不能放宽。（#10）

## 其他约束

- 所有密钥一律以 `*_FILE` 文件引用，不写进 env 模板、镜像、日志、URL、issue、PR；仓库里的 env 模板只放占位符。`pnpm check:secrets` 检查密钥名与密钥形态。
- 代码、文档、测试、夹具里不写组织名、真实仓库名、内部主机名、私网或组网地址、网关地址、真实账号名；`pnpm check:public-safety` 检查。
- 节点令牌只显示一次，库里存哈希；节点不开入站端口，control 从不连节点。（#11）
- 绑定机器人账号时拒绝 `workflow`、`admin:org`、`delete_repo`、`write:packages`、`admin:repo_hook` 这些 scope；令牌失效或 scope 变化时自动暂停全部写入。（#5）
- node 容器非 root，只挂 `/dev/kvm`，不挂 docker.sock，不用 privileged；sandbox 容器无网络、根只读、不挂任何令牌文件。（#11、#14）

## 残余风险

- 修改 workflow 的防线不完整：同路径同内容的文件已在其它分支存在时，GitHub 不要求 `workflow` scope，所以只能靠 publisher 拒绝触及 `.github/workflows/**` 的补丁。
- 提示注入可能产生误导性的审查评论；中和只能去掉可解析的机器指令，不能保证评论内容正确。
- qemu 或 KVM 逃逸。
- 控制面是单点，并且持有全部密钥。
- 私网明文 HTTP 模式的保密性依赖组网本身的加密。

## 验证（计划中）

每条不变量在实现它的 issue 里至少有一个反例测试：越权写入被拒（#9，至少 30 个样例）、容器里搜不到网关密钥和 GitHub 令牌（#11、#13、#14）、恶意夹具仓库的 hooks 和 MCP 没有执行（#12、#14）、VM 访问私网和宿主端口全部失败（#12、#17）、PR 修改规则文件后画像不变（#10）。
