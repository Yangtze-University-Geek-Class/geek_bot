# 按开发任务选择 Tuffex

> 从管理后台的页面和任务出发定位组件，再查询准确 API。

状态：`current` · 更新：2026-09-25 · 适用：`app/console`

下表是选型导航，不是新的组件 API 定义；具体参数、事件、插槽和导出以链接文档及源码为准。页面清单是计划中的（见 [console 服务文档](../../services/console/README.md)），各页面随对应 issue 落地。

| 任务 | 阅读路径 |
|---|---|
| 安装与组合开发 | [安装](reference/installation.md)、[组合教程](reference/tuffex-composition.md)、[开发工具](reference/tuffex-tooling.md) |
| 主题令牌、图标和无障碍 | [设计基础](reference/foundations.md)、[主题](reference/theming.md)、[图标](reference/icons.md)、[无障碍](reference/accessibility.md) |
| 后台外壳与导航（窄屏抽屉） | [SidebarNav](reference/sidebar-nav.md)、[Drawer](reference/drawer.md)、[NavBar](reference/nav-bar.md)、[Breadcrumb](reference/breadcrumb.md) |
| 概览指标 | [StatCard](reference/stat-card.md)、[SparkChart](reference/spark-chart.md)、[StatusBadge](reference/status-badge.md) |
| 队列与任务列表 | [Tabs](reference/tabs.md)、[DataTable](reference/data-table.md)、[FilterChips](reference/filter-chips.md)、[Tag](reference/tag.md)、[Pagination](reference/pagination.md) |
| 任务实时详情与模型降级 | [AgentTrace](reference/agent-trace.md)、[ToolCallCard](reference/tool-call-card.md)、[VirtualList](reference/virtual-list.md)、[Timeline](reference/timeline.md) |
| 审查预览与差异 | [MarkdownView](reference/markdown-view.md)、[DiffTable](reference/diff-table.md)、[CodeEditor](reference/code-editor.md) |
| 仓库列表与逐仓库开关 | [DataTable](reference/data-table.md)、[Switch](reference/switch.md)、[Tooltip](reference/tooltip.md)、[Alert](reference/alert.md) |
| 节点状态与槽位 | [AllocationBar](reference/allocation-bar.md)、[ProgressBar](reference/progress-bar.md)、[SignalMeter](reference/signal-meter.md)、[StatusBadge](reference/status-badge.md) |
| 模型池排序与思考档位 | [SortableList](reference/sortable-list.md)、[Select](reference/select.md) |
| 设置与表单 | [Form](reference/form.md)、[Input](reference/input.md)、[Textarea](reference/textarea.md)、[NumberInput](reference/number-input.md)、[Select](reference/select.md)、[Checkbox](reference/checkbox.md)、[Radio](reference/radio.md)、[Switch](reference/switch.md)、[Button](reference/button.md) |
| 确认操作与反馈 | [Modal](reference/modal.md)、[Dialog](reference/dialog.md)、[Toast](reference/toast.md)、[Alert](reference/alert.md) |
| 加载、空态、错误、无权限、离线 | [LoadingState](reference/loading-state.md)、[Skeleton](reference/skeleton.md)、[EmptyState](reference/empty-state.md)、[ErrorState](reference/error-state.md)、[PermissionState](reference/permission-state.md)、[OfflineState](reference/offline-state.md) |

## 业务边界

后台的访问控制在 control 的服务端完成，不能只靠界面隐藏按钮或卡片遮挡。Markdown、权限和危险操作仍要执行项目安全策略；组件本身不会完成这些约束。来自 GitHub、omp、节点的文本一律按纯文本渲染，只有审查预览用 MarkdownView，并显式净化。

缺少对应组件时，先用中文名、英文名或 Tx 名称查询，再评估用已有组件组合；不要从菜单分类名推导不存在的包入口。
