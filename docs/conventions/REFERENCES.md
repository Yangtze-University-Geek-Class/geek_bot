# 官方参考与本项目采用范围

> 可追溯的工程依据：记录采用了哪些官方说明、用在仓库哪里，不把外部建议、产品选择和已完成验收混为一谈。

状态：`current` · 更新：2026-09-26 · 核对：2026-09-25 · 适用：规范、架构、安全与运维文档引用的外部事实

## 适用范围

规范化所用外部事实优先查官方文档，内部约束仍以本项目 current 文档及实现为准。下表记录采用了哪些原则以及对应的仓库落点，不表示项目已通过 OWASP、WCAG 或其他认证。表中每个链接都在 2026-09-25 实际打开核对过；落点写「计划中」的，由括号里的 issue 实现。

### 协作与工程

| 来源 | 采用范围 | 本项目落点 |
|---|---|---|
| [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) | type、可选 scope、breaking change 的提交结构 | [COMMITS](COMMITS.md)；中文说明和 scope 词表是本项目选择 |
| [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html) | `MAJOR.MINOR.PATCH` 各位的升级含义 | [RELEASES](RELEASES.md) 的版本号一节；`-rc.N` 预发布后缀的形状由本项目的 tag 正则限定 |
| [TypeScript module reference](https://www.typescriptlang.org/docs/handbook/modules/reference.html) | `.js` 对应 TS 源文件、tsconfig `paths` 与 `moduleResolution` 的真实解析 | `scripts/check-boundaries.mjs` 及跨包导入反例，见 [MODULAR-DEVELOPMENT](MODULAR-DEVELOPMENT.md) |
| [Fastify Testing](https://fastify.dev/docs/latest/Guides/Testing/) | 构造与监听分离、inject 注册真实插件与路由、关闭资源 | [TESTING](TESTING.md) 的隔离一节；control 路由测试（计划中，#3） |
| [Fastify Validation and Serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/) | 运行时 HTTP Schema 与类型声明各有职责 | control 各路由模块的 `contracts.ts`（计划中，#3）；[API](../architecture/API.md) |
| [W3C APG modal dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) | 弹层名称、焦点进入/圈定/恢复、危险操作优先聚焦取消 | 管理后台的确认弹层与浏览器回归（计划中，#4），见 [DESIGN](../design/DESIGN.md) |
| [WCAG 2.2](https://www.w3.org/TR/WCAG22/) | AA 级验收目标；文本对比度 4.5:1 与大文本 3:1（1.4.3）、焦点可见（2.4.7）、目标尺寸 24×24 CSS 像素及其间距例外（2.5.8） | [DESIGN](../design/DESIGN.md) 的无障碍目标；管理后台浏览器回归（计划中，#4） |
| [Node.js previous releases](https://nodejs.org/en/about/previous-releases) | 各大版本的代号与支持状态；v22 为 LTS 版本线（代号 Jod） | [STACK](../design/STACK.md) 的环境一致性一节；`.nvmrc`、`.node-version`、`engines` |

### GitHub

| 来源 | 采用范围 | 本项目落点 |
|---|---|---|
| [Authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps) | device flow 需要先在 OAuth App 设置里开启；轮询时的 `authorization_pending`、`slow_down`、`expired_token` 处理；web flow | 机器人账号登录与绑定（计划中，#5）；身份决策 [ADR-0002](../decisions/0002-github-identity.md) |
| [Scopes for OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps) | 各 scope 的含义；响应头 `X-OAuth-Scopes` 列出令牌实际拥有的 scope | [CODE-REVIEW](CODE-REVIEW.md) 第 12 项；绑定时的 scope 校验（计划中，#5） |
| [Repository roles for an organization](https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization) | Read、Triage、Write、Maintain、Admin 各角色能做的操作 | 仓库权限到机器人能力的映射（计划中，#6） |
| [Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) | 主限额与二级限额（含创建内容类请求的限速）、`retry-after` 与重置头的处理 | 轮询预算（计划中，#8）；publisher 写入限速（计划中，#9） |
| [Best practices for using the REST API](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api) | 条件请求（`etag` / `if-none-match`），带认证的 304 响应不计入主限额 | 轮询的 ETag 缓存（计划中，#8） |
| [REST API endpoints for pull request reviews](https://docs.github.com/en/rest/pulls/reviews) | 创建 review 的 `event` 取值为 APPROVE、REQUEST_CHANGES、COMMENT；留空时 review 处于 PENDING | 写入白名单只许字面量 `COMMENT`（[CODE-REVIEW](CODE-REVIEW.md) 第 11 项；实现见 #9） |
| [Working with the Container registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry) | 工作流里用 `GITHUB_TOKEN` 推送、在目标机用令牌登录拉取、按 digest 拉取镜像 | [RELEASES](RELEASES.md)；release.yml 与部署脚本（计划中，#7） |
| [Managing environments for deployment](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments) | Free 计划只能给公开仓库配置 Environments；私有仓库需要 Team 或 Pro | 不依赖 Environments 审批与环境级 secrets 的部署方式，见 [RELEASES](RELEASES.md) 与 [CICD](../ops/CICD.md) |
| [Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows) | 一次推送超过三个 tag 时不产生 tag 事件 | [RELEASES](RELEASES.md) 的「一次只推一个发布 tag」 |
| [Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use) | `GITHUB_TOKEN` 只给最小权限；PR 标题、正文等不可信输入不直接拼进脚本 | `.github/workflows/*` 的 `permissions` 与脚本写法，见 [CICD](../ops/CICD.md) |

### 安全与执行隔离

| 来源 | 采用范围 | 本项目落点 |
|---|---|---|
| [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) | 会话验证、有效期、身份变化后的更新以及 Cookie 范围风险 | [安全模型](../architecture/SECURITY.md)；后台会话（计划中，#5） |
| [OWASP LLM Prompt Injection Prevention](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html) | 仓库、代码注释、文档等外部内容里的间接提示注入 | [CODE-REVIEW](CODE-REVIEW.md) 第 14 项；[安全模型](../architecture/SECURITY.md)；runner 剔除规则文件与输出中和（计划中，#9、#14） |
| [QEMU Invocation](https://www.qemu.org/docs/master/system/invocation.html) | `-netdev user` 的 `restrict=on` 与 `guestfwd`、`-fw_cfg`、`-sandbox`、加速器 `kvm` | PR 通道一次性 VM（计划中，#12 实测，#17 实现） |
| [QEMU Network emulation](https://www.qemu.org/docs/master/system/devices/net.html) | 用户态网络栈的工作方式 | 同上 |
| [QEMU fw_cfg](https://www.qemu.org/docs/master/specs/fw_cfg.html) | `-fw_cfg name=opt/...,file=...` 把文件传给 guest，`opt/` 前缀留给用户 | 每任务令牌传入 VM 的方式（计划中，#17） |

## 使用和维护

采用新的库、升级大版本或改变安全方案时重新核对对应官方说明，并更新核对日期；版本和默认值可能变化，不从旧研究文档推断最新版。打不开或无法核对的链接不写进本表。把已采用的规则同步到唯一规范源，不在本表再定义第二套技术规则。

发生来源冲突时记录适用版本、项目约束和取舍；以测试和环境证据报告实施结果。身份服务模拟、浏览器模拟网络、真实供应商验证、实例发布是四种不同范围，不得互相代替。
