/**
 * 界面里不许出现的字符（docs/design/DESIGN.md「硬性规则」）：emoji，以及当图标用的 unicode 箭头、对勾、播放三角、实心圆点之类。
 * 允许 `⌘ · … ×`。浏览器回归在页面里用它扫描；tests/console/glyphs.test.ts 逐类自测，防止正则漏字符。
 */

/** 按 Unicode 区块列出；改动时同步补自测里的样例。 */
export const FORBIDDEN_GLYPH_SOURCE = [
  "\\p{Extended_Pictographic}", // emoji 与大部分象形符号
  "\\u{1F000}-\\u{1FAFF}", // emoji 所在的补充区块
  "\\uFE0F", // emoji 变体选择符
  "\\u2190-\\u21FF", // 箭头（← → ↔ ↗ ↵）
  "\\u24B6-\\u24FF", // 圈字母（ⓘ Ⓐ ⓐ）
  "\\u2600-\\u26FF", // 杂项符号（☐ ☒ ★ ☆ ☑），☐ ☒ 可能被拿来冒充复选框
  "\\u2300-\\u2317\\u2319-\\u23FF", // 技术符号（⏎ ⏵ ⏩ ⏸），⌘ U+2318 除外
  "\\u25A0-\\u25FF", // 几何图形（▶ ▲ ▼ ▾ ● ◉ ■）
  "\\u2700-\\u27BF", // 装饰符号（✓ ✔ ✗ ❯ ➔）
  "\\u27F0-\\u27FF", // 补充箭头 A（⟶ ⟹）
  "\\u2900-\\u297F", // 补充箭头 B（⤳ ⤴）
  "\\u2B00-\\u2BFF", // 杂项符号与箭头（⬅ ⮐）
  "\\u2022\\u2023\\u2043\\u2219\\u30FB\\uFF65", // 各种圆点（• ‣ ⁃ ∙ ・ ･）
  "\\uFFE9-\\uFFEE", // 半角箭头与图形（￩ ￫ ￭ ￮）
].join("");

/** DESIGN 明确允许的符号：扫描前先去掉。 */
export const ALLOWED_GLYPHS = "⌘·…×";

export function forbiddenGlyphsIn(text: string): string[] {
  const forbidden = new RegExp(`[${FORBIDDEN_GLYPH_SOURCE}]`, "gu");
  const allowed = new RegExp(`[${ALLOWED_GLYPHS}]`, "gu");
  return text.replace(allowed, "").match(forbidden) ?? [];
}
