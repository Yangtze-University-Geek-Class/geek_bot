import { describe, expect, it } from "vitest";
import { CONTROL_DEFAULTS, CONTROL_ENV, ControlConfigError, createControlConfig } from "../../app/control/src/index.js";

function errorOf(run: () => unknown): ControlConfigError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ControlConfigError);
    return error as ControlConfigError;
  }
  throw new Error("预期抛出 ControlConfigError，实际没有抛出");
}

describe("control 配置", () => {
  it("产品默认值：轮询 60 秒、静默 300 秒、第 5 天提醒、第 7 天关闭、最多追问 2 轮、VM 1 vCPU / 2 GiB", () => {
    expect(createControlConfig({})).toEqual({
      pollIntervalSeconds: 60,
      quietWindowSeconds: 300,
      remindAfterDays: 5,
      closeAfterDays: 7,
      maxFollowUpRounds: 2,
      vmVcpus: 1,
      vmMemoryMiB: 2048,
    });
    expect(createControlConfig()).toEqual(CONTROL_DEFAULTS);
    expect(Object.isFrozen(CONTROL_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(createControlConfig({}))).toBe(true);
  });

  it("环境变量名都带 GEEK_BOT_ 前缀，且与配置项一一对应", () => {
    expect(Object.keys(CONTROL_ENV).sort()).toEqual(Object.keys(CONTROL_DEFAULTS).sort());
    const names = Object.values(CONTROL_ENV);
    for (const name of names) expect(name).toMatch(/^GEEK_BOT_[A-Z0-9_]+$/);
    expect(new Set(names).size).toBe(names.length);
  });

  it("从环境变量覆盖默认值，首尾空白忽略，留空按未设置处理", () => {
    const config = createControlConfig({
      GEEK_BOT_POLL_INTERVAL_SECONDS: "120",
      GEEK_BOT_QUIET_WINDOW_SECONDS: "0",
      GEEK_BOT_REMIND_AFTER_DAYS: " 3 ",
      GEEK_BOT_CLOSE_AFTER_DAYS: "10",
      GEEK_BOT_MAX_FOLLOWUP_ROUNDS: "0",
      GEEK_BOT_VM_VCPUS: "2",
      GEEK_BOT_VM_MEMORY_MIB: "",
    });
    expect(config).toEqual({
      pollIntervalSeconds: 120,
      quietWindowSeconds: 0,
      remindAfterDays: 3,
      closeAfterDays: 10,
      maxFollowUpRounds: 0,
      vmVcpus: 2,
      vmMemoryMiB: 2048,
    });
  });

  it("非整数、负数、小数、带单位和低于下限的值都拒绝，并给出中文原因", () => {
    for (const value of ["abc", "-1", "1.5", "60s", "1e3", "0x10"]) {
      const error = errorOf(() => createControlConfig({ GEEK_BOT_POLL_INTERVAL_SECONDS: value }));
      expect(error.problems).toHaveLength(1);
      expect(error.problems[0]).toContain("GEEK_BOT_POLL_INTERVAL_SECONDS 必须是不小于 1 的整数");
    }
    expect(() => createControlConfig({ GEEK_BOT_POLL_INTERVAL_SECONDS: "0" })).toThrow("不小于 1 的整数");
    expect(() => createControlConfig({ GEEK_BOT_VM_VCPUS: "0" })).toThrow("GEEK_BOT_VM_VCPUS");
    expect(() => createControlConfig({ GEEK_BOT_VM_MEMORY_MIB: "2" })).toThrow("不小于 512 的整数");
    expect(() => createControlConfig({ GEEK_BOT_QUIET_WINDOW_SECONDS: "-5" })).toThrow("必须是非负整数");
    expect(() => createControlConfig({ GEEK_BOT_MAX_FOLLOWUP_ROUNDS: "two" })).toThrow("必须是非负整数");
  });

  it("关闭天数必须大于提醒天数", () => {
    expect(() => createControlConfig({ GEEK_BOT_CLOSE_AFTER_DAYS: "5" })).toThrow("关闭天数必须大于提醒天数");
    expect(() => createControlConfig({ GEEK_BOT_REMIND_AFTER_DAYS: "8" })).toThrow("关闭天数必须大于提醒天数");
    expect(createControlConfig({ GEEK_BOT_REMIND_AFTER_DAYS: "6" }).closeAfterDays).toBe(7);
  });

  it("一次列出全部问题；单项不合法时不再追加误导的先后比较", () => {
    const error = errorOf(() =>
      createControlConfig({ GEEK_BOT_POLL_INTERVAL_SECONDS: "x", GEEK_BOT_VM_VCPUS: "0", GEEK_BOT_REMIND_AFTER_DAYS: "soon", GEEK_BOT_CLOSE_AFTER_DAYS: "3" }),
    );
    expect(error.problems).toHaveLength(3);
    expect(error.message).toContain("control 配置不合法");
    expect(error.problems.some(problem => problem.includes("关闭天数必须大于提醒天数"))).toBe(false);
  });
});
