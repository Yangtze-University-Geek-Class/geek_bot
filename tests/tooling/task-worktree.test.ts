import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decideCleanup, isInside, issueOfBranch, parseWorktrees, startNote, taskBranch, worktreePath } from "../../scripts/task.mjs";

const script = fileURLToPath(new URL("../../scripts/task.mjs", import.meta.url));

describe("task worktree", () => {
  it("分支名与 worktree 路径：一个 issue 一个", () => {
    expect(taskBranch(35, "review_queue")).toBe("task/35/review_queue");
    expect(() => taskBranch(35, "review-queue")).toThrow(/不用 -/);
    expect(() => taskBranch("abc", "x")).toThrow(/数字/);
    expect(worktreePath("/repo", 35)).toBe("/repo/.claude/worktrees/task-35");
    expect(issueOfBranch("task/35/review_queue")).toBe(35);
    expect(issueOfBranch("dev/alice")).toBeNull();
  });

  it("解析 git worktree list --porcelain，含 detached 与主工作区", () => {
    const porcelain = [
      "worktree /repo",
      "HEAD 882435e",
      "branch refs/heads/dev/alice",
      "",
      "worktree /repo/.claude/worktrees/task-35",
      "HEAD 77160aa",
      "branch refs/heads/task/35/review_queue",
      "",
      "worktree /repo/.claude/worktrees/scratch",
      "HEAD b979f9c",
      "detached",
      "",
    ].join("\n");
    const list = parseWorktrees(porcelain);
    expect(list.map((wt: { branch: string | null }) => wt.branch)).toEqual(["dev/alice", "task/35/review_queue", null]);
    expect(list[2].detached).toBe(true);
  });

  it("能不能清理：只有 PR 已合并或 issue 已放弃、且工作区干净时才清", () => {
    expect(decideCleanup({ dirty: false, issueState: "CLOSED", prState: "MERGED" }).ok).toBe(true);
    expect(decideCleanup({ dirty: false, issueState: "OPEN", prState: "MERGED" }).ok).toBe(true); // 合并了但 issue 没关：清 worktree，issue 交给巡检
    expect(decideCleanup({ dirty: true, issueState: "CLOSED", prState: "MERGED" })).toMatchObject({ ok: false, reason: expect.stringContaining("未提交") });
    expect(decideCleanup({ dirty: false, issueState: "OPEN", prState: "OPEN" }).ok).toBe(false);
    expect(decideCleanup({ dirty: false, issueState: "OPEN", prState: null }).ok).toBe(false);
    expect(decideCleanup({ dirty: false, issueState: "CLOSED", prState: null })).toMatchObject({ ok: true, reason: expect.stringContaining("放弃") });
    expect(decideCleanup({ dirty: false, issueState: "OPEN", prState: "CLOSED" }).ok).toBe(false);
    expect(decideCleanup({ dirty: false, issueState: null, prState: null }).ok).toBe(false); // 查不到就不删
  });

  it("finish 判断当前目录是否在要删的 worktree 里：按路径段比较，task-3 不误匹配 task-35", () => {
    const task3 = join("/repo", ".claude", "worktrees", "task-3");
    expect(isInside(task3, task3)).toBe(true);
    expect(isInside(join(task3, "app", "control"), task3)).toBe(true);
    expect(isInside(`${task3}/`, task3)).toBe(true);
    expect(isInside(join("/repo", ".claude", "worktrees", "task-35"), task3)).toBe(false);
    expect(isInside(join("/repo", ".claude", "worktrees", "task-35", "src"), task3)).toBe(false);
    expect(isInside("/repo", task3)).toBe(false);
  });

  it("start、finish 的 issue 号不是数字：打印用法并以 2 退出，不会报「不需要清理」", () => {
    for (const args of [["finish", "abc"], ["finish", "1x"], ["start", "abc", "review_queue"]]) {
      const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
      expect(result.status, args.join(" ")).toBe(2);
      expect(result.stderr, args.join(" ")).toContain(`${args[0]} 需要数字 issue 号，收到 ${args[1]}`);
      expect(result.stderr).toContain("用法：node scripts/task.mjs");
      expect(result.stdout).not.toContain("不需要清理");
    }
  });

  it("开工记录用 track v1 记录头，只写分支、基线与清理命令；提到提交写完整 SHA", () => {
    const base = "a620ea49d90c3f5e8b17c2d4a6e9f0b1c3d5e7f9";
    const note = startNote({ issue: "12", branch: "task/12/review_queue", base, worktree: ".claude/worktrees/task-12" });
    const [header] = note.split("\n");
    expect(header).toBe("<!-- track v1 kind=progress stage=dev -->");
    expect(header).toMatch(/^<!-- track v1 kind=[a-z]+ stage=[a-z]+ -->$/);
    expect(note).toContain("`task/12/review_queue`");
    expect(note).toContain(`\`origin/stage\`（${base}）`);
    expect(note).toContain("`node scripts/task.mjs finish 12`");
    const reference = note.split("\n").find((line) => line.startsWith("**引用**："));
    expect(reference).toBe(`**引用**：#12 · ${base}`);
    expect(reference).toMatch(/ [0-9a-f]{40}$/);
  });

  it("开工记录收到短 SHA：拒绝，不会把短 SHA 写进 issue", () => {
    for (const base of ["a620ea49d90c", "a620ea4", "", "A620EA49D90C3F5E8B17C2D4A6E9F0B1C3D5E7F9"]) {
      expect(() => startNote({ issue: 12, branch: "task/12/review_queue", base, worktree: ".claude/worktrees/task-12" }), base).toThrow(/完整 40 位 SHA/);
    }
  });
});
