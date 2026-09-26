import { defineConfig } from "vitest/config";

// 根测试配置：收集 tests/**/*.test.ts，全部在 Node 环境里跑。
// console 的 lib 与样板数据在这里跑单测；Vue 组件由 tests/e2e 的浏览器回归（Playwright，.spec.ts）覆盖，不在这里预设前端依赖。
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    restoreMocks: true,
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
