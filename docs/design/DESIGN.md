# 管理后台界面与可访问性规范

> 管理后台只用 Tuffex，浅色、平静、先求扫读；加载、空、失败、无权限分开显示，标准要求和项目偏好分开写。

状态：`current` · 更新：2026-09-25 · 适用：`app/console` 与一切界面改动（后台本身由 #4 起实现）

## 现状

仓库里还没有任何界面：`app/console` 现在只是最小的 TypeScript 入口，Vue、vue-router、Tuffex 和 Vite 由 #4 引入。本文的规则现在就有效，任何界面改动都按它做；页面清单和计划见 [console 服务文档](../services/console/README.md)。主题令牌的具体取值、图标集和窄屏断点由 #4 定下后写进 console 服务文档，本文不预先编造数值。

## 组件体系

管理后台（`app/console`）全部用 Tuffex 0.6.0（Vue 3.5），Tuffex 的引入、封装与版本规则见 [Tuffex 使用政策](../components/tuffex/USAGE-POLICY.md)。写页面之前先读 [AI 阅读指南](../components/tuffex/AI-GUIDE.md)，按 [任务映射](../components/tuffex/TASK-MAP.md) 找组件，用 `node scripts/tuffex-docs.mjs read <组件> --section Props` 查准确的参数，不凭记忆写 props。

| 用途 | 组件 |
|---|---|
| 导航 | TxSidebarNav；窄屏收进 TxDrawer |
| 列表 | TxDataTable（窄屏在自己的容器里横向滚动） |
| 分区与筛选 | TxTabs、TxFilterChips |
| 表单 | TxForm + TxInput、TxTextarea、TxNumberInput、TxSelect、TxCheckbox、TxRadio、TxSwitch |
| 确认与反馈 | TxModal、TxToastHost、TxAlert |
| 状态 | TxLoadingState 或 TxSkeleton、TxEmptyState、TxErrorState、TxPermissionState、TxOfflineState |
| 指标 | TxStatCard、TxSparkChart |
| 排序 | TxSortableList（传入中文的 labels 与 itemLabel，支持纯键盘重排） |
| 任务实时详情 | TxAgentTrace、TxToolCallCard、TxVirtualList、TxTimeline |
| 审查预览 | TxMarkdownView（显式净化） |

Tuffex 里有的就不自己写。库里确实没有的，按使用政策「引入、封装与主题」一节处理。

## 硬性规则

- 不用浏览器原生下拉框（`select`）和复选框（`input[type=checkbox]`）：选择用 TxSelect，开关用 TxSwitch，多选用 TxCheckbox。
- 界面里不出现 emoji，也不用当图标使用的 unicode 箭头和符号（回车箭头、斜向箭头、对勾、播放三角、左右箭头、实心圆点之类）；图标只用 Tuffex 自带的图标和 #4 选定的图标集。允许 `⌘`、`·`、`…`、`×`。
- 来自 GitHub、omp、节点的文本（issue 标题、评论、日志、模型输出）一律按纯文本渲染；只有审查预览用 TxMarkdownView，并显式净化。
- 危险操作（取消任务、禁用节点、解绑机器人账号、重置令牌）先经 TxModal 确认，初始焦点在「取消」上；不全局监听 Enter 直接确认。
- 界面能不能操作只是提示，授权只在 control 的服务端判断（见 [SECURITY](../architecture/SECURITY.md)）。按钮隐藏或置灰不算权限控制。
- 不把样板数据、缓存或预演结果写成实时数据：样板数据模式、dry-run 的「将要发布」内容都要在界面上标明。
- 不把会过期或编造的数字写死在页面里（仓库数、节点数、审查次数、准确率，以及「今年」这类会过期的词）；数字都来自 control 的接口。

## 视觉

- 只有浅色一套，第一版不做深色主题。
- 只经 Tuffex 官方的 `--tx-*` 令牌和组件变量换肤；组件里不写颜色值，自写 CSS 只管版式和页面底色。令牌清单由 #4 写进 console 服务文档。
- 一套无衬线字体（系统中文字体栈）；等宽字体只给 GitHub 登录名、仓库名、编号、提交号、digest 和代码。
- 间距用 4/8px 体系，正文 14–16px；字号用 rem，支持浏览器放大。
- 长文本单行省略并提供完整值的查看方式；grid 子项设 `min-width: 0`；任何宽度下内容不溢出卡片。390px 宽度下没有页面级横向溢出，二维表格在自己的容器里滚动，不为了不滚动而截断内容。

## 文案

- 短、具体、从使用者这边说。标签写名字，按钮写动作（「取消任务」「重新排队」），不写「确定」「提交」这类不说明后果的词。
- 空状态说现在是什么情况、下一步做什么；失败状态写发生了什么、能不能重试，并带上 `HTTP 状态 · 机器码 · request id`。
- 机器人会以绑定账号的身份在 GitHub 上发言，相关页面要直说这一点，不用委婉说法。
- 不写口号，不用「赋能」「打造」「一站式」「沉浸式」「全方位」「无缝」这类词。

## 状态、表单和导航

- 加载、空、失败、无权限、离线、成功分开显示。网络错误不冒充空数据；重要失败持续可见，直到恢复或被处理。
- 实时数据断线时只在页面顶部显示 TxAlert 并退回轮询，不把整页换成错误页。
- 用 `role=status` / `role=alert` 播报状态变化，轻提示不抢焦点。
- 每个控件都有准确的名称或关联的 label；错误提示同时用图标和文字，不只靠颜色。密码和令牌输入框允许密码管理器和粘贴；令牌只显示一次时要明确写出来。
- 列表的分页、筛选写进 URL，刷新和分享后状态不丢。
- 窄屏下侧栏收进抽屉，导航仍然可达。

## 无障碍目标

以 WCAG 2.2 AA 为验收目标，不宣称已经达标。普通文本对比度至少 4.5:1，大文本至少 3:1；关键的非文本控件按适用条款验证。焦点始终可见，键盘能完成主要流程，弹层关闭后焦点回到触发它的元素。

触控目标优先 44px；WCAG 的 24px 下限有间距等例外，图标的视觉尺寸不等于热区。支持文字放大和 `prefers-reduced-motion`：减少动态效果时不做过渡动画，直接给最终状态。

弹层有名称和适当的描述，焦点进入、在弹层内循环、关闭后恢复，背景不可操作；做法按 [W3C APG modal dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)（登记在 [REFERENCES](../conventions/REFERENCES.md)）。

## 验收

- 组件层：取消、焦点目标、异步参数和错误分支有单测（`tests/console/`）。
- 浏览器层（随 #4 加入 `test:e2e`）：页面上原生 select 与 checkbox 的数量为 0，emoji 扫描为 0，390px 宽度下没有页面级横向溢出，窄屏抽屉可用，Tab/Esc 与弹层焦点正确。
- 对比度、屏幕阅读器、多浏览器和放大测试单独记录；不能从源码或组件库文档推断整个后台通过 WCAG。

依据：[WCAG 2.2](https://www.w3.org/TR/WCAG22/)、[W3C APG modal dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)。视觉数值和组件取舍是本项目的决定，不冒充标准的强制条款。
