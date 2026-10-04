/** Read scenarios retain distinct accessible states and actionable diagnostics. */
import { NARROW, WIDE, expect, expectPageRules, test } from "./fixtures.js";

for (const viewport of [WIDE, NARROW]) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ viewport });

    test("空列表是 status，不是失败，也不显示任务记录", async ({ page }) => {
      await page.goto("/tasks?sample=empty");
      const view = page.locator(".state-view");
      await expect(view).toHaveAttribute("data-state", "empty");
      await expect(view.getByRole("status")).toBeVisible();
      await expect(view.getByRole("alert")).toHaveCount(0);
      await expect(page.locator('#main-content a[href^="/tasks/"]')).toHaveCount(0);
      await expectPageRules(page);
    });

    test("加载播报 busy；响应后以实际记录替换加载视图", async ({ page }) => {
      await page.goto("/tasks?sample=slow");
      const view = page.locator(".state-view");
      await expect(view).toHaveAttribute("data-state", "loading");
      await expect(view.getByRole("status")).toHaveAttribute("aria-busy", "true");
      await expect(view.getByRole("alert")).toHaveCount(0);
      await expectPageRules(page);
      await expect(page.locator('#main-content a[href="/tasks/task-sample-1"]')).toBeVisible();
      await expect(view).toHaveCount(0);
      await expectPageRules(page);
    });

    test("500 保留诊断；重试发起新读取，不伪装成功", async ({ page }) => {
      await page.goto("/tasks?sample=error");
      const view = page.locator(".state-view");
      const detail = view.locator(".state-view__detail");
      await expect(view).toHaveAttribute("data-state", "error");
      await expect(view.getByRole("alert")).toBeVisible();
      await expect(detail).toHaveText(/HTTP 500 · internal_error · sample-req-\d{4}/);
      await expectPageRules(page);
      await page.screenshot({ path: `test-results/evidence/console-error-state-${viewport.width}x${viewport.height}.png` });
      const before = (await detail.textContent())!.match(/sample-req-\d{4}/)![0];
      await view.getByRole("button", { name: "重试", exact: true }).click();
      await expect(view).toHaveAttribute("data-state", "error");
      await expect(detail).toHaveText(/HTTP 500 · internal_error · sample-req-\d{4}/);
      await expect(detail).not.toContainText(before);
      await expect(page.locator('#main-content a[href^="/tasks/"]')).toHaveCount(0);
      await expectPageRules(page);
    });

    for (const scenario of [
      { query: "forbidden", state: "forbidden", diagnostic: /HTTP 403 · forbidden · sample-req-\d{4}/ },
      { query: "unauthenticated", state: "unauthenticated", diagnostic: /HTTP 401 · unauthenticated · sample-req-\d{4}/ },
      { query: "offline", state: "offline", diagnostic: /网络错误 · 没有响应/ },
    ]) {
      test(`${scenario.query}：独立错误分类与可访问诊断，不冒充空或成功`, async ({ page }) => {
        await page.goto(`/tasks?sample=${scenario.query}`);
        const view = page.locator(".state-view");
        await expect(view).toHaveAttribute("data-state", scenario.state);
        await expect(view.getByRole("alert")).toBeVisible();
        await expect(view.getByRole("status")).toHaveCount(0);
        await expect(view.locator(".state-view__detail")).toHaveText(scenario.diagnostic);
        await expect(page.locator('#main-content a[href^="/tasks/"]')).toHaveCount(0);
        if (scenario.state === "offline") {
          await expect(view.getByRole("button", { name: "重试", exact: true })).toBeVisible();
        } else if (scenario.state === "forbidden") {
          await expect(view.getByRole("button", { name: "重试", exact: true })).toHaveCount(0);
          await expect(view.getByRole("button", { name: "去登录", exact: true })).toHaveCount(0);
        }
        await expectPageRules(page);
        if (scenario.state === "unauthenticated") {
          await view.getByRole("button", { name: "去登录", exact: true }).click();
          await expect.poll(() => new URL(page.url()).pathname).toBe("/login");
          expect(new URL(page.url()).searchParams.get("redirect")).toBe("/tasks?sample=unauthenticated");
          await expect(page.getByRole("navigation", { name: "主导航" })).toHaveCount(0);
          await expect(page.getByRole("button", { name: "导航", exact: true })).toHaveCount(0);
          await expectPageRules(page);
        }
      });
    }
  });
}
