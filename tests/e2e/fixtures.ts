/**
 * console 浏览器回归的共用夹具与断言（docs/design/DESIGN.md「硬性规则」「验收」）。
 *
 * - 每个用例自动记录浏览器发出的全部请求，结束时断言：没有发往预览地址以外的请求，也没有任何 `/api/` 请求
 *   （样板数据模式在页面内打桩，数据请求不出浏览器）。
 * - 页面检查：原生 select 与 checkbox 数量为 0；emoji 与被禁的 unicode 符号扫描为 0；图标类都有图形；没有页面级横向溢出。
 */
import { expect, test as base, type Page } from "@playwright/test";

export const test = base.extend<{ requestLog: string[] }>({
  requestLog: [
    async ({ page, baseURL }, use) => {
      const log: string[] = [];
      page.on("request", request => log.push(request.url()));
      await use(log);
      const origin = new URL(baseURL ?? "http://127.0.0.1").origin;
      const external = log.filter(url => !url.startsWith("data:") && new URL(url).origin !== origin);
      const api = log.filter(url => url.startsWith(origin) && new URL(url).pathname.startsWith("/api/"));
      expect(external, "样板数据模式下不应有发往外部的请求").toEqual([]);
      expect(api, "样板数据模式下数据请求应在页面内打桩，不出浏览器").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

export const WIDE = { width: 1280, height: 800 } as const;
export const NARROW = { width: 390, height: 844 } as const;

/** 等页面数据状态离开「加载中」，返回最终状态。 */
export async function settledState(page: Page): Promise<string> {
  const view = page.locator(".state-view");
  await expect(view).toHaveAttribute("data-state", /^(?!loading$).+/);
  return (await view.getAttribute("data-state")) ?? "";
}

export async function nativeControlCount(page: Page): Promise<number> {
  return page.locator("select, input[type=checkbox]").count();
}

/**
 * 页面上出现的 emoji 与被禁的 unicode 符号（DESIGN：允许 ⌘ · … ×）。
 * 扫可见文字、标题、常见的文字属性，以及每个元素 ::before / ::after 的 content。
 */
export async function forbiddenGlyphs(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const banned =
      /[\p{Extended_Pictographic}\u{1F000}-\u{1FAFF}←-⇿➔-➿⬀-⯿✓-✘▶-▻◀-◄●•⏎️]/gu;
    const allowed = /[⌘·…×]/g;
    const texts = [document.title, document.body.innerText];
    for (const element of Array.from(document.querySelectorAll("*"))) {
      for (const name of ["aria-label", "title", "placeholder", "alt", "value"]) {
        const value = element.getAttribute(name);
        if (value) texts.push(value);
      }
      for (const pseudo of ["::before", "::after"]) {
        const content = getComputedStyle(element, pseudo).content;
        if (content && content !== "none" && content !== "normal") texts.push(content);
      }
    }
    return texts.flatMap(text => text.replace(allowed, "").match(banned) ?? []);
  });
}

/** 页面上 Carbon 图标类（i-carbon-*）的元素里，没有生成图形（mask-image 为 none）的类名。 */
export async function iconsWithoutGlyph(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>("[class*='i-carbon-']"))
      .filter(element => {
        const style = getComputedStyle(element);
        const mask = style.maskImage || style.getPropertyValue("-webkit-mask-image");
        return !mask || mask === "none";
      })
      .map(element => Array.from(element.classList).find(name => name.startsWith("i-carbon-")) ?? element.className),
  );
}

export async function pageOverflow(page: Page): Promise<{ scrollWidth: number; innerWidth: number }> {
  return page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
}

/** 一页的通用检查：没有原生控件、没有 emoji、图标都有图形、没有页面级横向溢出。 */
export async function expectPageRules(page: Page): Promise<void> {
  expect(await nativeControlCount(page), "原生 select / checkbox 数量").toBe(0);
  expect(await forbiddenGlyphs(page), "emoji 与被禁符号").toEqual([]);
  expect(await iconsWithoutGlyph(page), "没有图形的图标类").toEqual([]);
  const { scrollWidth, innerWidth } = await pageOverflow(page);
  expect(scrollWidth, "页面级横向溢出").toBeLessThanOrEqual(innerWidth);
}
