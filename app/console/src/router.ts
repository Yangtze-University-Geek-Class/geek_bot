/** 路由：每个后台页面一条，由 shell/pages.ts 生成；未知地址显示「页面不存在」。 */
import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";
import ResourcePage from "./components/ResourcePage.vue";
import NotFoundPage from "./pages/NotFoundPage.vue";
import { CONSOLE_PAGES, DEFAULT_PAGE } from "./shell/pages.js";

const TITLE_SUFFIX = "geek_bot 后台";

const routes: RouteRecordRaw[] = [
  { path: "/", redirect: DEFAULT_PAGE.path },
  ...CONSOLE_PAGES.map(page => ({
    path: page.path,
    name: page.name,
    component: ResourcePage,
    props: { page },
    meta: { title: page.label },
  })),
  { path: "/:pathMatch(.*)*", name: "not-found", component: NotFoundPage, meta: { title: "页面不存在" } },
];

export function createConsoleRouter() {
  const router = createRouter({ history: createWebHistory(), routes });
  router.afterEach(to => {
    const title = typeof to.meta.title === "string" ? to.meta.title : "";
    document.title = title ? `${title} · ${TITLE_SUFFIX}` : TITLE_SUFFIX;
  });
  return router;
}
