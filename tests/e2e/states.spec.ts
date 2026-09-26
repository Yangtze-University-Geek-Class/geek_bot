/**
 * 页面数据状态（DESIGN「状态、表单和导航」）：加载、空、失败、未登录、无权限、离线分开显示，
 * 失败类状态带 `HTTP 状态 · 机器码 · request id`。用样板数据的 `?sample=<场景>` 切换响应。
 */
import { NARROW, WIDE, expect, expectPageRules, settledState, test } from "./fixtures.js";

for (const viewport of [WIDE, NARROW]) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ viewport });

    test("空：列表没有条目时显示空状态，不冒充失败", async ({ page }) => {
      await page.goto("/queue?sample=empty");
      expect(await settledState(page)).toBe("empty");
      await expect(page.locator(".state-view").getByRole("status")).toContainText("队列里没有任务");
      await expectPageRules(page);
    });

    test("加载：数据回来之前显示加载状态", async ({ page }) => {
      await page.goto("/queue?sample=slow");
      await expect(page.locator(".state-view")).toHaveAttribute("data-state", "loading");
      await expect(page.locator(".state-view").getByRole("status")).toContainText("正在加载");
      await expectPageRules(page);
      expect(await settledState(page)).toBe("ready");
    });

    test("失败：显示原因、HTTP 状态 · 机器码 · request id，可以重试", async ({ page }) => {
      await page.goto("/queue?sample=error");
      expect(await settledState(page)).toBe("error");
      const alert = page.locator(".state-view").getByRole("alert");
      await expect(alert).toContainText("加载失败");
      await expect(alert).toContainText(/HTTP 500 · internal_error · sample-req-\d{4}/);
      await expectPageRules(page);
      await page.screenshot({ path: `test-results/evidence/console-error-state-${viewport.width}x${viewport.height}.png` });
      const before = await alert.textContent();
      await alert.getByRole("button", { name: "重试" }).click();
      await expect(alert).toContainText(/HTTP 500 · internal_error · sample-req-\d{4}/);
      expect(await alert.textContent()).not.toBe(before);
    });

    test("无权限：403 显示无权限，不冒充失败", async ({ page }) => {
      await page.goto("/repos?sample=forbidden");
      expect(await settledState(page)).toBe("forbidden");
      await expect(page.locator(".state-view").getByRole("alert")).toContainText("没有权限查看这一页");
      await expect(page.locator(".state-view").getByRole("alert")).toContainText(/HTTP 403 · forbidden · sample-req-\d{4}/);
      await expectPageRules(page);
    });

    test("未登录：401 显示需要登录", async ({ page }) => {
      await page.goto("/nodes?sample=unauthenticated");
      expect(await settledState(page)).toBe("unauthenticated");
      await expect(page.locator(".state-view").getByRole("alert")).toContainText("需要登录");
      await expect(page.locator(".state-view").getByRole("alert")).toContainText(/HTTP 401 · unauthenticated · sample-req-\d{4}/);
      await expectPageRules(page);
    });

    test("离线：没有响应时显示连不上控制面，不冒充空数据", async ({ page }) => {
      await page.goto("/alerts?sample=offline");
      expect(await settledState(page)).toBe("offline");
      await expect(page.locator(".state-view").getByRole("alert")).toContainText("连不上控制面");
      await expect(page.locator(".state-view").getByRole("alert")).toContainText("网络错误 · 没有响应");
      await expectPageRules(page);
    });
  });
}
