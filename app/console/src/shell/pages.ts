/**
 * 侧栏导航的页面清单：侧栏、窄屏抽屉与列表页路由都从这里生成，不另写一份。
 * 主导航是项目、需求、机器；运行里是任务；设置里是渠道连接、模型池与管理员。详情页挂在对应列表页下，不进侧栏。
 * 本文件不导入 Vue。
 */

export type PageGroup = "main" | "operations" | "settings";

export interface ConsolePage {
  /** 路由名与侧栏导航项的 value。 */
  readonly name: string;
  readonly path: string;
  readonly label: string;
  readonly group: PageGroup;
  /** Carbon 图标类名（UnoCSS 图标预设）。 */
  readonly icon: string;
  /** 这一页的主列表读取的后台 API。 */
  readonly endpoint: string;
}

export const PAGE_GROUPS: readonly { readonly key: PageGroup; readonly label: string }[] = Object.freeze([
  { key: "main", label: "项目与需求" },
  { key: "operations", label: "运行" },
  { key: "settings", label: "设置" },
]);

export const CONSOLE_PAGES: readonly ConsolePage[] = Object.freeze([
  { name: "projects", path: "/projects", label: "项目", group: "main", icon: "i-carbon-folders", endpoint: "/api/v1/projects" },
  { name: "demands", path: "/demands", label: "需求", group: "main", icon: "i-carbon-request-quote", endpoint: "/api/v1/demands" },
  { name: "machines", path: "/machines", label: "机器", group: "main", icon: "i-carbon-bare-metal-server", endpoint: "/api/v1/machines" },
  { name: "tasks", path: "/tasks", label: "任务", group: "operations", icon: "i-carbon-task", endpoint: "/api/v1/tasks" },
  { name: "connections", path: "/connections", label: "渠道连接", group: "settings", icon: "i-carbon-plug", endpoint: "/api/v1/connections" },
  { name: "model-pools", path: "/model-pools", label: "模型池", group: "settings", icon: "i-carbon-machine-learning-model", endpoint: "/api/v1/model-pools" },
  { name: "admins", path: "/admins", label: "管理员", group: "settings", icon: "i-carbon-user-admin", endpoint: "/api/v1/admins" },
] satisfies ConsolePage[]);

export const DEFAULT_PAGE = CONSOLE_PAGES[0];

/** 详情页在侧栏里高亮它所属的列表页。 */
export const DETAIL_PARENT: Readonly<Record<string, string>> = {
  "project-detail": "projects",
  "demand-detail": "demands",
  "machine-detail": "machines",
  "task-detail": "tasks",
  "connection-detail": "connections",
};
