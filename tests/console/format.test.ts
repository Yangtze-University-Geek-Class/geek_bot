import { describe, expect, it } from "vitest";
import { formatDuration } from "../../app/console/src/index.js";

describe("formatDuration", () => {
  it("按例子输出：45 秒、3 分钟、2 小时 5 分钟", () => {
    expect(formatDuration(45_000)).toBe("45 秒");
    expect(formatDuration(180_000)).toBe("3 分钟");
    expect(formatDuration(7_500_000)).toBe("2 小时 5 分钟");
  });

  it("最多显示相邻两级单位，零头向下取整", () => {
    expect(formatDuration(200_000)).toBe("3 分钟 20 秒");
    expect(formatDuration(59_999)).toBe("59 秒");
    expect(formatDuration(7_530_000)).toBe("2 小时 5 分钟");
    expect(formatDuration(7_200_000)).toBe("2 小时");
    expect(formatDuration(3_600_000 + 30_000)).toBe("1 小时");
    expect(formatDuration(5 * 86_400_000)).toBe("5 天");
    expect(formatDuration(7 * 86_400_000 + 3 * 3_600_000)).toBe("7 天 3 小时");
  });

  it("0 和不足 1 秒的时长", () => {
    expect(formatDuration(0)).toBe("0 秒");
    expect(formatDuration(1)).toBe("不到 1 秒");
    expect(formatDuration(999)).toBe("不到 1 秒");
    expect(formatDuration(1_000)).toBe("1 秒");
  });

  it("负数、NaN 和无穷大抛 RangeError", () => {
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => formatDuration(value)).toThrow(RangeError);
    }
  });
});
