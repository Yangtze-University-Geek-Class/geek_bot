/**
 * 后台的页面清单：侧栏导航、窄屏抽屉与路由都从这里生成，不另写一份。
 * 每页的具体内容由对应 issue 实现（docs/services/console/README.md「计划中的模块」）；#4 只接好数据端点与各种状态。
 * 本文件不导入 Vue。
 */

export type PageGroup = "run" | "resources" | "admin";

export interface ConsolePage {
  /** 路由名与侧栏导航项的 value。 */
  readonly name: string;
  readonly path: string;
  readonly label: string;
  readonly group: PageGroup;
  /** Carbon 图标类名（UnoCSS 图标预设）。 */
  readonly icon: string;
  /** 这一页读取的后台 API（docs/architecture/API.md 端点表）。 */
  readonly endpoint: string;
  /** 列表为空时显示的标题与说明：说现在是什么情况、下一步做什么。 */
  readonly emptyTitle: string;
  readonly emptyDescription: string;
}

export const PAGE_GROUPS: readonly { readonly key: PageGroup; readonly label: string }[] = Object.freeze([
  { key: "run", label: "运行" },
  { key: "resources", label: "资源" },
  { key: "admin", label: "管理" },
]);

export const CONSOLE_PAGES: readonly ConsolePage[] = Object.freeze([
  {
    name: "overview",
    path: "/overview",
    label: "概览",
    group: "run",
    icon: "i-carbon-dashboard",
    endpoint: "/api/v1/overview",
    emptyTitle: "还没有概览数据",
    emptyDescription: "控制面还没有汇总出计数；稍后刷新即可。",
  },
  {
    name: "queue",
    path: "/queue",
    label: "队列",
    group: "run",
    icon: "i-carbon-task",
    endpoint: "/api/v1/tasks",
    emptyTitle: "队列里没有任务",
    emptyDescription: "已监控的仓库出现要处理的 issue 或 PR 后，任务会出现在这里。",
  },
  {
    name: "items",
    path: "/items",
    label: "未接的条目",
    group: "run",
    icon: "i-carbon-document-view",
    endpoint: "/api/v1/items",
    emptyTitle: "没有未接的条目",
    emptyDescription: "机器人决定不接的 issue 和 PR 会列在这里，并写明原因。",
  },
  {
    name: "repos",
    path: "/repos",
    label: "仓库",
    group: "resources",
    icon: "i-carbon-repo-source-code",
    endpoint: "/api/v1/repos",
    emptyTitle: "还没有发现仓库",
    emptyDescription: "绑定机器人账号后，它能访问的仓库会自动列在这里。",
  },
  {
    name: "nodes",
    path: "/nodes",
    label: "节点",
    group: "resources",
    icon: "i-carbon-bare-metal-server",
    endpoint: "/api/v1/nodes",
    emptyTitle: "还没有节点",
    emptyDescription: "登记节点并在节点主机上启动 node 栈后，它会出现在这里。",
  },
  {
    name: "models",
    path: "/models",
    label: "模型池",
    group: "resources",
    icon: "i-carbon-machine-learning-model",
    endpoint: "/api/v1/model-pools",
    emptyTitle: "还没有模型池",
    emptyDescription: "配置模型目录后，可以按任务类型排列要用的模型。",
  },
  {
    name: "bot",
    path: "/bot",
    label: "机器人账号",
    group: "admin",
    icon: "i-carbon-bot",
    endpoint: "/api/v1/bot-account",
    emptyTitle: "还没有绑定机器人账号",
    emptyDescription: "机器人会以绑定账号的身份在 GitHub 上发言。",
  },
  {
    name: "settings",
    path: "/settings",
    label: "设置",
    group: "admin",
    icon: "i-carbon-settings",
    endpoint: "/api/v1/settings",
    emptyTitle: "没有可显示的设置项",
    emptyDescription: "设置项随各项功能加入。",
  },
  {
    name: "alerts",
    path: "/alerts",
    label: "告警",
    group: "admin",
    icon: "i-carbon-warning-alt",
    endpoint: "/api/v1/alerts",
    emptyTitle: "没有告警",
    emptyDescription: "出现需要处理的问题时会列在这里。",
  },
  {
    name: "audit",
    path: "/audit",
    label: "审计",
    group: "admin",
    icon: "i-carbon-catalog",
    endpoint: "/api/v1/audit",
    emptyTitle: "还没有审计记录",
    emptyDescription: "管理员和系统的每次操作都会记在这里。",
  },
] satisfies ConsolePage[]);

export const DEFAULT_PAGE = CONSOLE_PAGES[0];
