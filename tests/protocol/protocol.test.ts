import { describe, expect, it } from "vitest";
import {
  CHANNEL_EXECUTOR,
  CHANNELS,
  EXECUTORS,
  NODE_PROTOCOL_VERSION,
  PR_CHANNEL_PRIORITY,
  TASK_CHANNEL,
  TASK_KINDS,
} from "../../packages/protocol/src/index.js";

describe("protocol 常量", () => {
  it("节点协议版本是整数 1", () => {
    expect(NODE_PROTOCOL_VERSION).toBe(1);
    expect(Number.isInteger(NODE_PROTOCOL_VERSION)).toBe(true);
  });

  it("任务类型、通道和执行器的取值固定", () => {
    expect([...TASK_KINDS]).toEqual(["review", "triage", "followup", "fix", "rework"]);
    expect([...CHANNELS]).toEqual(["issue", "pr"]);
    expect([...EXECUTORS]).toEqual(["sandbox", "vm"]);
  });

  it("每个任务类型都恰好映射到一个已知通道", () => {
    expect(Object.keys(TASK_CHANNEL).sort()).toEqual([...TASK_KINDS].sort());
    for (const kind of TASK_KINDS) expect(CHANNELS).toContain(TASK_CHANNEL[kind]);
  });

  it("triage、followup 走 issue 通道，review、fix、rework 走 pr 通道", () => {
    expect(TASK_KINDS.filter(kind => TASK_CHANNEL[kind] === "issue")).toEqual(["triage", "followup"]);
    expect(TASK_KINDS.filter(kind => TASK_CHANNEL[kind] === "pr")).toEqual(["review", "fix", "rework"]);
  });

  it("issue 通道用 sandbox 不开 VM，pr 通道每个任务一台 VM", () => {
    expect(Object.keys(CHANNEL_EXECUTOR).sort()).toEqual([...CHANNELS].sort());
    expect(CHANNEL_EXECUTOR.issue).toBe("sandbox");
    expect(CHANNEL_EXECUTOR.pr).toBe("vm");
    for (const kind of TASK_KINDS) {
      const executor = CHANNEL_EXECUTOR[TASK_CHANNEL[kind]];
      expect(executor).toBe(TASK_CHANNEL[kind] === "issue" ? "sandbox" : "vm");
    }
  });

  it("PR 通道优先级：审查别人的 PR > 自己 PR 的返工 > 修分给机器人的 issue > 机器人自己决定修的", () => {
    expect(PR_CHANNEL_PRIORITY.map(entry => entry.reason)).toEqual([
      "review_others_pr",
      "rework_own_pr",
      "fix_assigned_issue",
      "fix_self_chosen_issue",
    ]);
    expect(PR_CHANNEL_PRIORITY.map(entry => entry.kind)).toEqual(["review", "rework", "fix", "fix"]);
    const priorities = PR_CHANNEL_PRIORITY.map(entry => entry.priority);
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
    expect(new Set(priorities).size).toBe(priorities.length);
  });

  it("PR 通道优先级表里的任务类型都走 pr 通道，且覆盖全部 pr 通道类型", () => {
    for (const entry of PR_CHANNEL_PRIORITY) expect(TASK_CHANNEL[entry.kind]).toBe("pr");
    const covered = new Set(PR_CHANNEL_PRIORITY.map(entry => entry.kind));
    expect(TASK_KINDS.filter(kind => TASK_CHANNEL[kind] === "pr").every(kind => covered.has(kind))).toBe(true);
  });

  it("共享常量在运行时不可修改", () => {
    for (const list of [TASK_KINDS, CHANNELS, EXECUTORS]) expect(Object.isFrozen(list)).toBe(true);
    expect(Object.isFrozen(TASK_CHANNEL)).toBe(true);
    expect(Object.isFrozen(CHANNEL_EXECUTOR)).toBe(true);
    expect(Object.isFrozen(PR_CHANNEL_PRIORITY)).toBe(true);
    for (const entry of PR_CHANNEL_PRIORITY) expect(Object.isFrozen(entry)).toBe(true);
  });
});
