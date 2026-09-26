import { describe, expect, it } from "vitest";
import { forbiddenGlyphsIn } from "../e2e/glyphs.js";

describe("浏览器回归的被禁符号扫描", () => {
  it("每一类被禁符号都能扫出来", () => {
    const samples = {
      emoji: "😀🚀✅❤️",
      箭头: "←→↔↗↵⇒",
      技术符号: "⏎⏵⏩⏸",
      几何图形: "▶▲▼▾●◉■◀",
      装饰符号: "✓✔✗✘❯➔",
      长箭头: "⟶⟹",
      补充箭头: "⤳⤴",
      杂项箭头: "⬅⮐",
      圆点: "•‣⁃∙・･",
      半角箭头: "￩￫￭",
    };
    for (const [kind, text] of Object.entries(samples)) {
      const found = forbiddenGlyphsIn(text);
      // 变体选择符 U+FE0F 也算一个命中，所以只要求每个可见字符都被扫到。
      for (const glyph of Array.from(text.replace(/️/gu, ""))) expect(found, `${kind}：${glyph}`).toContain(glyph);
    }
  });

  it("允许的符号、中文、数字与常见标点不报", () => {
    expect(forbiddenGlyphsIn("⌘K · 加载中… 关闭 × HTTP 500 · internal_error · sample-req-0001")).toEqual([]);
    expect(forbiddenGlyphsIn("样板数据模式：页面上的数据全部虚构（不连控制面）。「重试」、example-owner · owner / 50%")).toEqual([]);
  });
});
