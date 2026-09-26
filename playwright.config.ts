/**
 * 管理后台的浏览器回归（`pnpm test:e2e`，docs/conventions/TESTING.md）。
 *
 * webServer 先以样板数据模式构建 console，再在回环地址上预览，所以直接运行 `playwright test` 也不会测到旧的构建；
 * 数据全部虚构，不连控制面。
 * Playwright 每次启动自己的临时浏览器 profile，不碰本机已有的浏览器配置与数据；浏览器下载目录在仓库之外。
 */
import { defineConfig, devices } from "@playwright/test";

const PORT = 4174;

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  outputDir: "test-results/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm --filter @geek-bot/console build:sample && pnpm --filter @geek-bot/console preview:sample",
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
