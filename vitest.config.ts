import { defineConfig } from "vitest/config";

// 根测试配置：收集 tests/**/*.test.ts，全部在 Node 环境里跑。
// console 的组件测试（Vue）随 #4 加入时再单独配置，不在这里预设前端依赖。
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    restoreMocks: true,
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
