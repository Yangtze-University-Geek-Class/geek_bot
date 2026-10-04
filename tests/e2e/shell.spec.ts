/** Canonical console routes, keyboard access, modal navigation and sample isolation. */
import { CONSOLE_PAGES } from "../../app/console/src/shell/pages.js";
import type { Page } from "@playwright/test";
import { NARROW, WIDE, clippedElements, expect, expectPageRules, test } from "./fixtures.js";

/** Ready content replaces StateView; there is no data-state=ready element. */
async function readPage(page: Page, path: string): Promise<void> {
  await page.goto(`${path}?sample=slow`);
  await expect(page.locator('.state-view[data-state="loading"]').first()).toBeVisible();
  await expect(page.locator('.state-view[data-state="loading"]')).toHaveCount(0);
  await expect(page.locator('.state-view')).toHaveCount(0);
}

async function drawerSettled(page: Page): Promise<void> {
  const panel = page.locator(".tx-drawer__panel");
  let lastWidth = -1;
  await expect.poll(async () => {
    const box = await panel.boundingBox();
    const settled = box !== null && box.x === 0 && box.width === lastWidth;
    lastWidth = box?.width ?? -1;
    return settled;
  }, { message: "抽屉滑入完成" }).toBe(true);
}

async function expectFocusTrappedIn(page: Page): Promise<void> {
  const inside = () => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')));
  await expect.poll(inside).toBe(true);
  for (const key of ["Tab", "Shift+Tab"] as const) {
    for (let step = 0; step < 16; step += 1) {
      await page.keyboard.press(key);
      expect(await inside(), `${key} 第 ${step + 1} 次后焦点仍在抽屉里`).toBe(true);
    }
  }
}

async function tabTo(page: Page, target: ReturnType<Page["getByRole"]>): Promise<void> {
  let reached = false;
  for (let step = 0; step < 40 && !reached; step += 1) {
    await page.keyboard.press("Tab");
    reached = await target.evaluate(element => element === document.activeElement);
  }
  expect(reached, "目标可通过 Tab 到达").toBe(true);
  await expect(target).toBeFocused();
}

 test.describe("宽屏（1280px）", () => {
  test.use({ viewport: WIDE });

  for (const consolePage of CONSOLE_PAGES) {
    test(`${consolePage.path}：读取成功、路由选中与页面规则`, async ({ page }) => {
      await readPage(page, consolePage.path);
      const nav = page.getByRole("navigation", { name: "主导航" });
      await expect(nav).toBeVisible();
      await expect(nav.getByRole("button", { name: consolePage.label, exact: true })).toHaveAttribute("aria-current", "page");
      await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
      await expect(page).toHaveURL(new RegExp(`${consolePage.path}\\?sample=slow$`));
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByRole("button", { name: "导航", exact: true })).toHaveCount(0);
      await expectPageRules(page);
    });
  }

  test("侧栏切换到明确选择的路由", async ({ page }) => {
    await readPage(page, "/projects");
    const nav = page.getByRole("navigation", { name: "主导航" });
    const target = nav.getByRole("button", { name: "机器", exact: true });
    await target.click();
    await expect(page).toHaveURL(/\/machines$/);
    await expect(target).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("button", { name: "项目", exact: true })).not.toHaveAttribute("aria-current", "page");
  });

  test("跳过导航将焦点交给正文；Tab 和 Enter 能选择侧栏路由", async ({ page }) => {
    await readPage(page, "/projects");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "跳到主要内容" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main-content")).toBeFocused();

    await readPage(page, "/projects");
    const target = page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "管理员", exact: true });
    await tabTo(page, target);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/admins$/);
    await expect(target).toHaveAttribute("aria-current", "page");
  });

  test("项目列表链接选择详情，侧栏仍选择父列表", async ({ page }) => {
    await readPage(page, "/projects");
    await page.locator('#main-content a[href="/projects/project-sample-1"]').click();
    await expect(page).toHaveURL(/\/projects\/project-sample-1$/);
    const nav = page.getByRole("navigation", { name: "主导航" });
    await expect(nav.getByRole("button", { name: "项目", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
  });

  test("样板模式有实际标识与警告；请求隔离由自动夹具断言", async ({ page }) => {
    await readPage(page, "/projects");
    await expect(page.locator("header").getByText("样板数据", { exact: true })).toBeVisible();
    await expect(page.locator(".shell__notice").getByRole("alert").filter({ hasText: "样板数据模式" })).toBeVisible();
    await expectPageRules(page);
  });

  test("断网提示不替换已有数据，恢复后撤销提示", async ({ page, context }) => {
    await readPage(page, "/projects");
    const record = page.locator('#main-content a[href="/projects/project-sample-1"]');
    const alert = page.getByRole("alert").filter({ hasText: "网络已断开" });
    try {
      await context.setOffline(true);
      await expect(alert).toBeVisible();
      await expect(record).toBeVisible();
      await expectPageRules(page);
    } finally {
      await context.setOffline(false);
    }
    await expect(alert).toHaveCount(0);
    await expect(record).toBeVisible();
  });

  for (const path of ["/no-such-page", "/overview", "/queue", "/nodes", "/repos", "/alerts", "/audit"]) {
    test(`${path} 不作为旧路由别名，未知页提供有效返回操作`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(page.locator(".not-found").getByRole("status")).toBeVisible();
      await expect(page.getByRole("navigation", { name: "主导航" }).locator('[aria-current="page"]')).toHaveCount(0);
      await expectPageRules(page);
      await page.getByRole("button", { name: "回到项目", exact: true }).click();
      await expect(page).toHaveURL(/\/projects$/);
      await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "项目", exact: true })).toHaveAttribute("aria-current", "page");
    });
  }

  test("验收截图：宽屏项目", async ({ page }) => {
    await readPage(page, "/projects");
    await expectPageRules(page);
    await page.screenshot({ path: "test-results/evidence/console-wide-1280x800.png", fullPage: true });
  });
});

 test.describe("窄屏（390px）", () => {
  test.use({ viewport: NARROW });

  for (const consolePage of CONSOLE_PAGES) {
    test(`${consolePage.path}：导航收起、读取成功且内容不溢出或裁切`, async ({ page }) => {
      await readPage(page, consolePage.path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByRole("navigation", { name: "主导航" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "导航", exact: true })).toBeVisible();
      await expectPageRules(page);
    });
  }

  test("抽屉选择路由后关闭；Escape 和关闭按钮都恢复焦点", async ({ page }) => {
    await readPage(page, "/projects");
    const opener = page.getByRole("button", { name: "导航", exact: true });
    const drawer = page.getByRole("dialog", { name: "导航" });
    await opener.click();
    await expect(drawer).toBeVisible();
    await expect(opener).toHaveAttribute("aria-expanded", "true");
    await drawerSettled(page);
    await expectFocusTrappedIn(page);
    await expectPageRules(page);
    await drawer.getByRole("button", { name: "任务", exact: true }).click();
    await expect(page).toHaveURL(/\/tasks$/);
    await expect(drawer).toBeHidden();
    await expect(opener).toHaveAttribute("aria-expanded", "false");

    for (const close of ["escape", "button"] as const) {
      await opener.click();
      await expect(drawer).toBeVisible();
      await expect(drawer.getByRole("button", { name: "任务", exact: true })).toHaveAttribute("aria-current", "page");
      if (close === "escape") await page.keyboard.press("Escape");
      else await drawer.getByRole("button", { name: "关闭导航", exact: true }).click();
      await expect(drawer).toBeHidden();
      await expect(opener).toHaveAttribute("aria-expanded", "false");
      await expect(opener).toBeFocused();
    }
  });

  test("纯键盘打开抽屉、双向焦点圈定、Escape 恢复焦点", async ({ page }) => {
    await readPage(page, "/projects");
    const opener = page.getByRole("button", { name: "导航", exact: true });
    await tabTo(page, opener);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "导航" })).toBeVisible();
    await drawerSettled(page);
    await expectFocusTrappedIn(page);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "导航" })).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test("关闭抽屉不出现在可见内容中，也不能通过键盘进入", async ({ page }) => {
    await readPage(page, "/projects");
    await expect(page.getByRole("dialog", { name: "导航" })).toBeHidden();
    for (let step = 0; step < 30; step += 1) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => Boolean(document.activeElement?.closest(".tx-drawer")))).toBe(false);
    }
    await expectPageRules(page);
  });

  test("裁切检查按实际读屏几何豁免，仍识别真实裁切与同名伪装", async ({ page }) => {
    await readPage(page, "/projects");
    expect(await clippedElements(page)).toEqual([]);
    await page.evaluate(() => {
      const host = document.createElement("div");
      host.id = "clipping-probes";
      host.style.position = "relative";
      const wide = () => {
        const inner = document.createElement("div");
        inner.style.width = "900px";
        inner.textContent = "wide";
        return inner;
      };
      const ripple = document.createElement("div");
      ripple.setAttribute("data-v-wave-container-internal", "");
      ripple.style.cssText = "width: 64px; overflow: hidden";
      ripple.append(wide());
      const clipped = document.createElement("div");
      clipped.className = "probe-clipped";
      clipped.style.cssText = "width: 64px; overflow: hidden";
      clipped.append(wide());
      const clippedByClip = document.createElement("div");
      clippedByClip.className = "probe-overflow-clip";
      clippedByClip.style.cssText = "width: 64px; overflow: clip";
      clippedByClip.append(wide());
      const srOnly = (className: string) => {
        const span = document.createElement("span");
        span.className = className;
        span.style.cssText = "position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0";
        span.textContent = "Screen reader label with overflowing text";
        return span;
      };
      const namedLabel = srOnly("visually-hidden");
      const unnamedLabel = srOnly("probe-sr-only");
      const impostor = srOnly("visually-hidden probe-impostor");
      impostor.style.cssText = "display: block; width: 64px; height: 20px; overflow: hidden; white-space: nowrap";
      const missingClip = srOnly("probe-missing-clip");
      missingClip.style.clip = "auto";
      const partialClip = srOnly("probe-partial-clip");
      partialClip.style.clip = "rect(0 1px 1px 0)";
      const oversized = srOnly("probe-oversized");
      oversized.style.width = "64px";
      oversized.style.height = "20px";
      oversized.style.clip = "rect(0 64px 20px 0)";
      const inFlow = srOnly("probe-in-flow");
      inFlow.style.position = "static";
      inFlow.style.display = "inline-block";
      host.append(ripple, namedLabel, unnamedLabel, clipped, clippedByClip, impostor, missingClip, partialClip, oversized, inFlow);
      document.querySelector(".shell__main")!.append(host);
    });
    try {
      expect(await clippedElements(page)).toEqual([
        "div.probe-clipped",
        "div.probe-overflow-clip",
        "span.visually-hidden.probe-impostor",
        "span.probe-missing-clip",
        "span.probe-partial-clip",
        "span.probe-oversized",
        "span.probe-in-flow",
      ]);
    } finally {
      await page.locator("#clipping-probes").evaluate(element => element.remove());
    }
  });

  test("验收截图：窄屏项目与抽屉", async ({ page }) => {
    await readPage(page, "/projects");
    await expectPageRules(page);
    await page.screenshot({ path: "test-results/evidence/console-narrow-390x844.png", fullPage: true });
    await page.getByRole("button", { name: "导航", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "导航" })).toBeVisible();
    await drawerSettled(page);
    await expectPageRules(page);
    await page.screenshot({ path: "test-results/evidence/console-narrow-390x844-drawer.png" });
  });
});
