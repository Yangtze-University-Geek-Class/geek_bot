/**
 * 后台外壳：宽屏侧栏、390px 窄屏抽屉、键盘可达、样板数据标识、断网提示与验收截图（#4）。
 */
import { CONSOLE_PAGES } from "../../app/console/src/shell/pages.js";
import type { Page } from "@playwright/test";
import { NARROW, WIDE, expect, expectPageRules, settledState, test } from "./fixtures.js";

/** 抽屉打开后：焦点已经在抽屉里，连按 Tab 也出不去（W3C APG modal dialog）。 */
async function expectFocusTrappedIn(page: Page): Promise<void> {
  const insideDialog = () => page.evaluate(() => Boolean(document.activeElement?.closest("[role=dialog]")));
  await expect.poll(insideDialog, { message: "打开后焦点进入抽屉" }).toBe(true);
  for (let step = 0; step < 14; step += 1) {
    await page.keyboard.press("Tab");
    expect(await insideDialog(), `第 ${step + 1} 次 Tab 后焦点仍在抽屉里`).toBe(true);
  }
}

test.describe("宽屏（1280px）", () => {
  test.use({ viewport: WIDE });

  for (const consolePage of CONSOLE_PAGES) {
    test(`${consolePage.label}：侧栏导航、页面标题与页面检查`, async ({ page }) => {
      await page.goto(consolePage.path);
      const nav = page.getByRole("navigation", { name: "主导航" });
      await expect(nav).toBeVisible();
      await expect(nav.getByRole("button", { name: consolePage.label })).toHaveAttribute("aria-current", "page");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(consolePage.label);
      await expect(page).toHaveTitle(`${consolePage.label} · geek_bot 后台`);
      // 样板数据里告警是空列表，其余页面有数据；两种都不能是失败类状态。
      expect(["ready", "empty"]).toContain(await settledState(page));
      await expect(page.getByRole("button", { name: "导航", exact: true })).toHaveCount(0);
      await expectPageRules(page);
    });
  }

  test("点侧栏切换页面，地址与标题跟着变", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/overview$/);
    await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "节点" }).click();
    await expect(page).toHaveURL(/\/nodes$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("节点");
  });

  test("键盘：第一个 Tab 到「跳到主要内容」，之后能用 Tab 和 Enter 切换页面", async ({ page }) => {
    await page.goto("/overview");
    await settledState(page);
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "跳到主要内容" });
    await expect(skip).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main-content")).toBeFocused();

    await page.goto("/overview");
    await settledState(page);
    const target = page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "审计" });
    let reached = false;
    for (let step = 0; step < 30 && !reached; step += 1) {
      await page.keyboard.press("Tab");
      reached = await target.evaluate(element => element === document.activeElement);
    }
    expect(reached, "Tab 能到达侧栏里的「审计」").toBe(true);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/audit$/);
  });

  test("样板数据模式在顶栏和页脚标明，页脚显示版本", async ({ page }) => {
    await page.goto("/overview");
    await expect(page.locator("header").getByText("样板数据", { exact: true })).toBeVisible();
    await expect(page.locator("footer")).toContainText("样板数据模式：页面上的数据全部虚构");
    await expect(page.locator("footer")).toContainText("版本 本地开发 · 未发布");
    await expect(page.locator("header")).toContainText("example-owner · 所有者");
  });

  test("断网时顶部出现提示，恢复后消失", async ({ page, context }) => {
    await page.goto("/overview");
    await settledState(page);
    await context.setOffline(true);
    const alert = page.getByRole("alert").filter({ hasText: "网络已断开" });
    await expect(alert).toBeVisible();
    await context.setOffline(false);
    await expect(alert).toHaveCount(0);
  });

  test("未知地址显示「页面不存在」，能回到概览", async ({ page }) => {
    await page.goto("/no-such-page");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("页面不存在");
    await expectPageRules(page);
    await page.getByRole("button", { name: "回到概览" }).click();
    await expect(page).toHaveURL(/\/overview$/);
  });

  test("验收截图：宽屏概览", async ({ page }) => {
    await page.goto("/overview");
    await settledState(page);
    // 侧栏的高亮块会滑到选中行上；等它与选中行对齐再截图。
    const sidebar = page.locator(".shell__sidebar");
    const top = async (selector: string) => (await sidebar.locator(selector).first().boundingBox())?.y;
    await expect.poll(async () => (await top(".tx-bui-sidebar-nav__indicator")) === (await top("[aria-current=page]"))).toBe(true);
    await page.screenshot({ path: "test-results/evidence/console-wide-1280x800.png", fullPage: true });
  });
});

test.describe("窄屏（390px）", () => {
  test.use({ viewport: NARROW });

  for (const consolePage of CONSOLE_PAGES) {
    test(`${consolePage.label}：侧栏收起、没有页面级横向溢出`, async ({ page }) => {
      await page.goto(consolePage.path);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(consolePage.label);
      await settledState(page);
      await expect(page.getByRole("navigation", { name: "主导航" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "导航", exact: true })).toBeVisible();
      await expectPageRules(page);
    });
  }

  test("抽屉导航：打开、切换页面后关闭；Esc 关闭后焦点回到「导航」按钮", async ({ page }) => {
    await page.goto("/overview");
    await settledState(page);
    const opener = page.getByRole("button", { name: "导航", exact: true });
    await opener.click();
    const drawer = page.getByRole("dialog", { name: "导航" });
    await expect(drawer).toBeVisible();
    await expect(opener).toHaveAttribute("aria-expanded", "true");
    await expectFocusTrappedIn(page);
    await expectPageRules(page);

    await drawer.getByRole("button", { name: "队列" }).click();
    await expect(page).toHaveURL(/\/queue$/);
    await expect(drawer).toBeHidden();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("队列");

    await opener.click();
    await expect(drawer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(opener).toBeFocused();

    await opener.click();
    await drawer.getByRole("button", { name: "关闭导航" }).click();
    await expect(drawer).toBeHidden();
  });

  test("纯键盘：Tab 到「导航」按 Enter 打开抽屉，焦点进入并圈在抽屉里，Esc 关闭后回到按钮", async ({ page }) => {
    await page.goto("/overview");
    await settledState(page);
    const opener = page.getByRole("button", { name: "导航", exact: true });
    let reached = false;
    for (let step = 0; step < 5 && !reached; step += 1) {
      await page.keyboard.press("Tab");
      reached = await opener.evaluate(element => element === document.activeElement);
    }
    expect(reached, "Tab 能到达「导航」按钮").toBe(true);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "导航" })).toBeVisible();
    await expectFocusTrappedIn(page);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "导航" })).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test("抽屉关闭时键盘进不去，面板完全在视口外、不漏阴影", async ({ page }) => {
    await page.goto("/overview");
    await settledState(page);
    for (let step = 0; step < 8; step += 1) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => Boolean(document.activeElement?.closest(".tx-drawer")))).toBe(false);
    }
    const panel = page.locator(".tx-drawer__panel");
    const box = await panel.boundingBox();
    expect(box && box.x + box.width).toBeLessThanOrEqual(0);
    await expect(panel).toHaveCSS("box-shadow", "none");
  });

  test("验收截图：窄屏概览与打开的抽屉", async ({ page }) => {
    await page.goto("/overview");
    await settledState(page);
    await page.screenshot({ path: "test-results/evidence/console-narrow-390x844.png", fullPage: true });
    await page.getByRole("button", { name: "导航", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "导航" })).toBeVisible();
    // 等滑入动画结束：面板左边缘回到 0 再截图。
    await expect.poll(async () => (await page.locator(".tx-drawer__panel").boundingBox())?.x).toBe(0);
    await page.screenshot({ path: "test-results/evidence/console-narrow-390x844-drawer.png" });
  });
});
