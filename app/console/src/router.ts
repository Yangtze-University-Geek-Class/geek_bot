/**
 * 路由：列表页来自 shell/pages.ts，详情页挂在对应列表下；`/login` 是认领与登录。未知地址显示「页面不存在」。
 * 进入后台页面前先读一次会话：没有会话（401）或实例未认领时转到登录页，并带上原地址以便登录后返回。
 * 这只是导航；每个请求的授权仍由 control 判断。
 */
import { createRouter, createWebHistory, type RouteComponent, type RouteRecordRaw } from "vue-router";
import type { Session } from "./components/context.js";
import AdminsPage from "./pages/AdminsPage.vue";
import ConnectionDetailPage from "./pages/ConnectionDetailPage.vue";
import ConnectionsPage from "./pages/ConnectionsPage.vue";
import DemandDetailPage from "./pages/DemandDetailPage.vue";
import DemandsPage from "./pages/DemandsPage.vue";
import LoginPage from "./pages/LoginPage.vue";
import MachineDetailPage from "./pages/MachineDetailPage.vue";
import MachinesPage from "./pages/MachinesPage.vue";
import ModelPoolsPage from "./pages/ModelPoolsPage.vue";
import NotFoundPage from "./pages/NotFoundPage.vue";
import ProjectDetailPage from "./pages/ProjectDetailPage.vue";
import ProjectsPage from "./pages/ProjectsPage.vue";
import TaskDetailPage from "./pages/TaskDetailPage.vue";
import TasksPage from "./pages/TasksPage.vue";
import { CONSOLE_PAGES, DEFAULT_PAGE } from "./shell/pages.js";

const TITLE_SUFFIX = "geek_bot 后台";

const LIST_COMPONENTS: Readonly<Record<string, RouteComponent>> = {
  projects: ProjectsPage,
  demands: DemandsPage,
  machines: MachinesPage,
  tasks: TasksPage,
  connections: ConnectionsPage,
  "model-pools": ModelPoolsPage,
  admins: AdminsPage,
};

const routes: RouteRecordRaw[] = [
  { path: "/", redirect: DEFAULT_PAGE.path },
  { path: "/login", name: "login", component: LoginPage, meta: { title: "登录", public: true } },
  ...CONSOLE_PAGES.map(page => ({ path: page.path, name: page.name, component: LIST_COMPONENTS[page.name], meta: { title: page.label } })),
  { path: "/projects/:id", name: "project-detail", component: ProjectDetailPage, props: true, meta: { title: "项目详情" } },
  { path: "/demands/:id", name: "demand-detail", component: DemandDetailPage, props: true, meta: { title: "需求详情" } },
  { path: "/machines/:id", name: "machine-detail", component: MachineDetailPage, props: true, meta: { title: "机器详情" } },
  { path: "/tasks/:id", name: "task-detail", component: TaskDetailPage, props: true, meta: { title: "任务详情" } },
  { path: "/connections/:id", name: "connection-detail", component: ConnectionDetailPage, props: true, meta: { title: "连接详情" } },
  { path: "/:pathMatch(.*)*", name: "not-found", component: NotFoundPage, meta: { title: "页面不存在", public: true } },
];

export function createConsoleRouter(session: Session) {
  const router = createRouter({ history: createWebHistory(), routes });
  router.beforeEach(async to => {
    if (session.status.value === "unknown") await session.load();
    if (to.meta.public === true) return true;
    if (session.status.value === "anonymous") return { name: "login", query: { redirect: to.fullPath } };
    return true;
  });
  router.afterEach(to => {
    const title = typeof to.meta.title === "string" ? to.meta.title : "";
    document.title = title ? `${title} · ${TITLE_SUFFIX}` : TITLE_SUFFIX;
  });
  return router;
}
