/**
 * console 入口。正式构建调用同源的 control；`--mode sample` 时换成页面内的样板数据，不发任何网络请求。
 * 样板数据的代码只在 sample 模式下被动态导入，正式构建里整段去掉。
 */
import "@talex-touch/tuffex/base.css";
import "virtual:uno.css";
import { createApp } from "vue";
import App from "./App.vue";
import { CONSOLE_CONTEXT } from "./components/context.js";
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
  const app = createApp(App);
  app.provide(CONSOLE_CONTEXT, { api: createApiClient(fetchImpl), sampleMode });
  app.use(createConsoleRouter());
  app.mount("#app");
}

void bootstrap();
