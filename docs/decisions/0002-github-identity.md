# ADR-0002：机器人身份用 OAuth App 用户令牌；默认「登录即成为机器人」

> 机器人以部署者绑定的那个 GitHub 账号本人的身份工作：OAuth App 用户令牌、device flow、scope `repo read:org`；令牌加密存放在 control，只有 publisher 和 GitHub 读取层能解密。

状态：`accepted` · 更新：2026-09-26 · 适用：control 的首次认领、登录、会话、机器人账号绑定与令牌生命周期（由 #5 实现；仓库发现与组织访问限制的识别由 #6 实现）

## 背景

- [ADR-0001](0001-standalone-product.md) 定下产品形态：部署者在后台用一个 GitHub 账号（一般是小号）登录，这个账号就成为机器人，在它能访问的全部仓库里工作：自己的、所在组织的、作为协作者参与的。
- 所有者的要求：机器人的动作以这个账号本人的身份发出；「分给机器人的 issue 优先接」要成立，机器人账号就必须能被分配 issue。不再要求部署者手工生成令牌放进文件。
- control 可能部署在只有私有组网能访问、没有公网入站的机器上：浏览器能到控制面，GitHub 的回调却到不了。
- 免费计划的私有仓库没有分支保护和 rulesets，OAuth 的 `repo` scope 也不能按仓库收窄（[SECURITY](../architecture/SECURITY.md) S-07）。令牌本身能做的事比机器人应该做的多，只能靠 scope 最小化和 publisher 白名单兜住。
- GitHub 的相关行为（官方文档，2026-09-26 核对）：
  - OAuth App 用 device flow 之前，要先在 App 设置里开启；web flow 支持 PKCE，方法只能是 `S256`（[Authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)）。
  - 同一用户、同一 App、同一组 scope 最多保留 10 枚令牌，每小时最多新建 10 枚；超出时 GitHub 先吊销「从没用过、创建超过一分钟的最旧一枚」，没有这样的就吊销最久没用的一枚。用户给这个 App 授权过的 scope，再次授权时不再显示授权页，直接按已授权的 scope 完成（同上）。
  - 一年没有使用的 OAuth 令牌会被自动吊销（[Token expiration and revocation](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/token-expiration-and-revocation)）。
  - `DELETE /applications/{client_id}/token` 只吊销一枚令牌；`DELETE /applications/{client_id}/grant` 删除该用户对这个 App 的授权，连同它的全部令牌（[OAuth authorizations REST API](https://docs.github.com/en/rest/apps/oauth-applications)）。
  - 新建的组织默认开启 OAuth App 访问限制，未批准的 App 拿不到组织的私有资源（[About OAuth app access restrictions](https://docs.github.com/en/organizations/managing-oauth-access-to-your-organizations-data/about-oauth-app-access-restrictions)）。
  - 服务条款规定一个人只能有一个免费账号，另外可以再控制一个只用于运行机器的机器账号（[GitHub Terms of Service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service) B.3）。

## 决策

### 授权方式

- 机器人身份用 **OAuth App 用户令牌**。部署者为每个环境（preview、production）各注册一个 OAuth App，并在 App 设置里开启 Device Flow。client secret 以 `*_FILE` 文件只挂给 control。
- 默认登录方式是 **device flow**：不需要回调地址，控制面只在私有组网可达时也能用。部署者配置的公开地址是 https 时，另外提供 web flow + PKCE（`S256`）。非回环地址的 http 回调 GitHub 是否接受，未验证，由 #5 实测；验证之前不作为支持的方式。
- web flow 只用于登录，不用于重新认证；重新认证只走 device flow。web flow 用 POST 发起；回调先完成流程核对，再签发会话；流程 cookie `gb_flow` 用 `SameSite=Lax`，会话 cookie 仍是 `SameSite=Strict`。端点与 cookie 的细节以 [API](../architecture/API.md) 和 [SECURITY](../architecture/SECURITY.md) S-09 为准。

### 首次认领

- 新部署的实例在被认领之前不接受登录。部署者在目标机对 control 容器运行认领命令（`bootstrap-code`），得到一个一次性认领码：熵不低于 100 位，15 分钟有效，只打印到终端，不写日志（S-10）。浏览器打开后台，先输入认领码，再登录。
- 目的：公网可达的实例在认领之前，不会被路过的人抢先登录成为 owner。

### 默认主路径：登录即成为机器人

- 认领后，部署者点「用 GitHub 登录并设为机器人账号」，走 device flow，申请 scope `repo read:org`。这个账号同时成为 owner 和机器人账号。
- 后台常驻提示「机器人以你的身份发言」。
- 绑定时拿到的这一枚令牌就是机器人令牌，是 control 保存的唯一一枚 GitHub 令牌。

### 可选路径：另设管理员

- owner 在后台按 GitHub **数字 id** 邀请 operator 或 viewer。不按登录名判定：登录名可以改，改掉的名字也可能被别人注册。
- 登录后台（被邀请的管理员，以及机器人账号本人之后为开会话或重新认证而登录）一律申请**空 scope**：不带 scope 的令牌只能读公开信息，足够用 `GET /user` 取到数字 id（[Scopes for OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)）。control 取到数字 id 后，随即调 `DELETE /applications/{client_id}/token` 吊销**这一枚**令牌，不保存。
- 数字 id 不在管理员名单里的账号登录，拿到的令牌同样立即吊销，不建会话。
- control 只保留绑定时拿到的那一枚令牌。
- 任何时候都不调删除授权（grant）的接口：它会让同一用户在这个 App 下的全部令牌失效，机器人令牌也在其中。
- 原因：同一 App 下已授权的 scope 会沿用，机器人账号本人登录拿到的令牌即使申请的是空 scope，也可能带着 `repo read:org`，和机器人令牌落在同一组 scope 里；不吊销的话，攒到 10 枚就可能挤掉机器人令牌。

### 绑定校验

- scope 用**允许名单**核对：绑定时读响应头 `X-OAuth-Scopes`，它必须是 {`repo`, `read:org`} 的子集，多出任何一个 scope 都拒绝绑定。`workflow`、`admin:org`、`delete_repo`、`write:packages`、`admin:repo_hook` 这 5 个保留为拒绝测试的样例，不是完整的拒绝范围。这条规则与 [CODE-REVIEW](../conventions/CODE-REVIEW.md) 第 12 项一致，改动要按那一项取得所有者批准。
- 已授权的 scope 会沿用：账号以前给同一个 App 授过更大的 scope 时，绑定会被拒绝。部署者要先在 GitHub 的账号设置里撤销这个 App 的授权，再重新绑定；后台照这个意思提示。

### 令牌存放与生命周期

- 机器人令牌只以 AES-256-GCM 密文存在 control 的库里；master key 以 `*_FILE` 文件只挂给 control，不进备份。只有 publisher 和 GitHub 读取层能解密（S-01）。
- 浏览器只拿到一个随机会话 id，库里存它的哈希；令牌不下发到浏览器，也不进日志、审计、事件、备份明文和发往节点的数据。
- 后台里一切写 GitHub 的操作都走 publisher 白名单（S-06），会话本身不能直接写 GitHub。
- 每天用 `GET /user` 校验一次机器人令牌；这次调用同时让令牌保持「有使用」，避免一年未用被自动吊销。
- 校验或任何调用收到 401，或者 `X-OAuth-Scopes` 与绑定时不同，control 自动进入「暂停全部写入」并告警；恢复要重新绑定。
- 轮换：在后台重新授权拿到新令牌后，用 `DELETE /applications/{client_id}/token` 吊销旧令牌。master key 用 control 的 `rotate-master-key` 命令轮换，重新加密库里的密文。

### 会话

- 空闲 2 小时过期，最长 12 小时。写请求校验 `Origin` 和 `Sec-Fetch-Site`。
- 高危操作只归 owner，并要求 10 分钟内重新认证过；清单只在 [SECURITY](../architecture/SECURITY.md) S-09 维护，本篇不另列。重新认证只走 device flow。

### 组织与环境

- 组织开启了 OAuth App 访问限制、又没有批准本 App 时，这个组织的私有仓库不会出现在发现结果里。#6 的识别办法：账号是该组织的成员，但发现结果里没有这个组织的私有仓库，就提示「需要组织 owner 在组织设置的 Third-party access 里批准本 OAuth App」。
- 推荐的组织角色：机器人账号以组织成员身份加入；只审查的仓库给 Read 或 Triage，需要自己修的仓库给 Write，不给 Admin。
- classic PAT 只作为兜底，给禁用了 OAuth App 的组织用，默认关闭。是否实现、怎样录入由 #5 决定；实现时同样按上面的允许名单核对 `X-OAuth-Scopes`，启用前需要所有者批准。
- preview 和 production 可以共用同一个机器人账号（服务条款只允许一个免费机器账号），但各用自己的 OAuth App 和各自的授权，两边的令牌互不通用；preview 的 publisher 只写沙盒仓库（[RELEASES](../conventions/RELEASES.md)「环境与入口绑定」，部署侧见 [ADR-0007](0007-ghcr-pull-deploy.md)）。

## 替代方案

- **GitHub App**：
  - 用户令牌只能访问装了这个 App 的账号下的资源（[官方文档](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user)），每个组织都要由组织 owner 安装；作为协作者参与的仓库属于别人，部署者装不了，覆盖不到。
  - 安装令牌以 `[bot]` 身份行动。官方列出的可分配对象都是人：本人、在 issue 里评论过的人、有写权限的人、有读权限的组织成员（[Assigning issues and pull requests](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/assigning-issues-and-pull-requests-to-other-github-users)），第三方 App 的 `[bot]` 没有被分配的途径；Copilot 和它的编码代理是 GitHub 自己的特例。这是推断，未验证，由 #6 实测。照这个推断，「分给机器人优先接」不成立，写入也不是「以这个账号本人的身份」。
- **fine-grained PAT**：一枚令牌只能访问一个资源所有者（一个用户或一个组织）的资源，不能用于作为外部协作者或仓库协作者参与的仓库，也不能同时访问多个组织（[官方文档](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)）。它还要部署者手工生成、放进文件，和「登录即成为机器人」不符。
- **classic PAT 作为主路径**：scope 和 OAuth 令牌一样宽，却要手工生成、放文件，也没有登录流程顺带确认身份。保留为兜底，默认关闭。
- **默认要求管理员与机器人分开**（管理员用主号登录，小号在另一个浏览器用 device flow 绑定）：与所有者「登录我们自己的账号，让它用这个账号作为机器人」的说法不符，降为可选路径（邀请管理员）。
- **只允许单账号**：多人维护时没法只给别人查看或操作的权限。单账号仍是默认形态，另加邀请。
- **按登录名识别管理员**：登录名可以改，也可能被别人重新注册。
- **只列拒绝的 scope**（原设计的 5 项拒绝名单）：GitHub 以后新增、或名单漏列的 scope 都会被默认放行；改用允许名单，拒绝名单留作测试样例。
- **登录后台时申请 `read:user`**（原设计）：取数字 id 用不着它，空 scope 就够。
- **登录后删除授权（grant）而不是吊销单枚令牌**：会把同一用户在这个 App 下的机器人令牌一起删掉。

## 后果

- 机器人在 GitHub 上就是一个真人账号在说话，后台和文档都要直说这一点（[DESIGN](../design/DESIGN.md)「文案」）。
- `repo` scope 覆盖账号能访问的全部仓库，不能按仓库收窄；免费计划又没有分支保护，令牌在技术上能推主干、打 tag、合并。「不做这些事」完全依赖 publisher 白名单（[write-whitelist](../services/control/write-whitelist.md)）和它的拒绝测试。
- 不申请 `workflow` 也挡不住全部 workflow 修改：同路径同内容的文件已在其它分支存在时，GitHub 不要求这个 scope（[SECURITY](../architecture/SECURITY.md) 残余风险），只能靠 publisher 拒绝触及 `.github/workflows/**` 的推送。
- control 保存机器人令牌和 master key；control 主机被攻陷就等于机器人账号被接管。
- 部署者要为每个环境注册 OAuth App、开启 Device Flow、准备 client secret 文件；这些步骤写进部署文档 DEPLOY 与 ENVIRONMENTS（#7 写入）。
- 每小时最多新建 10 枚令牌：短时间内频繁登录或重新认证可能被 GitHub 拒绝。后台把这种失败原样提示，不反复重试。
- 组织没有批准本 App 时，该组织的私有仓库看不到。这要组织 owner 操作，产品只能提示。
- 同一个机器人账号被两个环境共用：沙盒仓库配置一旦出错，就会在真实仓库重复写入。由「preview 只写沙盒仓库、production 自动排除沙盒仓库」两条规则防住（#9）。

## 实施状态

本篇只是设计，还没有代码。

- #5：认领码、device flow 与 web flow、机器人账号绑定与 scope 校验、管理员邀请与令牌吊销、令牌加密、每日校验、会话与重新认证、`rotate-master-key`。
- #3：master key 从 `*_FILE` 读取，control 的运维命令入口。
- #6：仓库发现、组织访问限制的识别与提示、可分配性检查。
- #9：「暂停全部写入」在 publisher 里的强制执行；preview 与 production 的仓库互斥。
- #7：每个环境的 OAuth App 与密钥文件写进部署文档。

## 重新评估条件

- GitHub App 不安装也能覆盖协作者仓库，或者 `[bot]` 身份可以被分配 issue；
- OAuth scope 可以按仓库收窄，或 fine-grained PAT 能覆盖多个资源所有者和协作者仓库；
- 要支持的组织普遍禁用 OAuth App，classic PAT 兜底成为主路径；
- 所有者要求默认把管理员和机器人分开。

## 所有者结论

接受：所有者 2026-09-26 答复「ADR 全部接受」，记在 #25。按本 ADR 执行（对应 #22 第 1、2 项；组织访问限制的处理对应第 13 项）。

- #22 约定各项默认按推荐推进；所有者 2026-09-25 回复时只改了第 4 项，对第 1、2、13 项没有提出修改（记在 #22 的第二条评论里）。
- 第 13 项里「确认所在组织是否开启了 OAuth App 访问限制，开启时批准本 App」要所有者本人在 #6 开工前完成。
