/**
 * console 入口。正式构建调用同源的 control；`--mode sample` 时换成页面内的样板数据，不发任何网络请求，写操作一律被拒绝。
 * 样板数据的代码只在 sample 模式下被动态导入，正式构建里整段去掉，真实模式不可能落到样板数据上。
 */
import "@talex-touch/tuffex/base.css";
import "virtual:uno.css";
import "./styles/console.css";
import { createApp } from "vue";
import App from "./App.vue";
import { CONSOLE_CONTEXT, createSession } from "./components/context.js";
import { createApiClient, type FetchLike } from "./lib/api.js";
import { createConsoleRouter } from "./router.js";

async function resolveFetch(): Promise<{ fetchImpl: FetchLike; sampleMode: boolean }> {
  if (import.meta.env.MODE === "sample") {
    const { createSampleFetch, readScenario } = await import("./mocks/index.js");
    return { fetchImpl: createSampleFetch({ scenario: readScenario(window.location.search) }), sampleMode: true };
  }
  return { fetchImpl: (input, init) => window.fetch(input, init), sampleMode: false };
}

async function bootstrap() {
  const { fetchImpl, sampleMode } = await resolveFetch();
  const api = createApiClient(fetchImpl);
  const session = createSession(api);
  const app = createApp(App);
  app.provide(CONSOLE_CONTEXT, { api, sampleMode, session });
  app.use(createConsoleRouter(session));
  app.mount("#app");
}

void bootstrap();
