import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  decideCleanup,
  finishTitle,
  isInside,
  issueOfBranch,
  lookupIssue,
  notesIdentity,
  parseWorktrees,
  readIssueLookup,
  startBlocker,
  startNote,
  taskBranch,
  worktreePath,
} from "../../scripts/task.mjs";

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

  it("start 查 issue：gh 因网络失败时报「查 issue 状态失败」并附上 gh 的错误，不再提示先开 issue", () => {
    const tls = 'Post "https://api.github.com/graphql": tls: failed to verify certificate: x509: certificate signed by unknown authority';
    const calls: string[][] = [];
    const failing = (args: string[]) => {
      calls.push(args);
      return { ok: false, stdout: "", stderr: `${tls}\n` };
    };
    const lookup = lookupIssue(26, failing);
    expect(calls).toEqual([["issue", "view", "26", "--json", "state", "--jq", ".state"]]);
    expect(lookup).toEqual({ error: tls });
    const message = startBlocker(26, lookup);
    expect(message).toContain("查 issue #26 状态失败");
    expect(message).toContain(tls);
    expect(message).not.toContain("先开 issue");
    // gh 本身不存在、失败但没有输出：同样是查询失败
    expect(startBlocker(26, readIssueLookup({ ok: false, stderr: "gh 不可用：spawn gh ENOENT" }))).toContain("查 issue #26 状态失败：gh 不可用");
    expect(readIssueLookup({ ok: false, stderr: "" })).toEqual({ error: expect.stringContaining("非 0 退出") });
    expect(readIssueLookup({ ok: true, stdout: "" })).toEqual({ error: expect.stringContaining("没有返回") });
  });

  it("start 查 issue：gh 明确回答没有这个编号才算查不到；关着的 issue 照旧提示先开 issue；开着的放行", () => {
    const notFound = lookupIssue(999, () => ({ ok: false, stderr: "GraphQL: Could not resolve to an issue or pull request with the number of 999. (repository.issue)\n" }));
    expect(notFound).toEqual({ notFound: true });
    expect(startBlocker(999, notFound)).toBe("issue #999 查不到：先开 issue（docs/conventions/ISSUES.md），再建 task。");
    expect(startBlocker(12, lookupIssue(12, () => ({ ok: true, stdout: "CLOSED\n" })))).toContain("状态是 CLOSED：先开 issue");
    expect(startBlocker(12, lookupIssue(12, () => ({ ok: true, stdout: "OPEN\n" })))).toBeNull();
  });

  it("执行记录身份：参数优先于环境变量，缺了或格式不对就失败", () => {
    const env = { GEEK_NOTES_USER: "alice", GEEK_NOTES_BY: "agent-claude-geek-bot-01（Claude Code，example-model）" };
    expect(notesIdentity({}, env)).toEqual({ user: "alice", by: env.GEEK_NOTES_BY });
    expect(notesIdentity({ user: "bob", by: "human-bob" }, env)).toEqual({ user: "bob", by: "human-bob" });
    expect(() => notesIdentity({}, {})).toThrow(/GEEK_NOTES_USER/);
    expect(() => notesIdentity({}, { GEEK_NOTES_USER: "alice" })).toThrow(/GEEK_NOTES_BY/);
    expect(() => notesIdentity({ user: "Alice" }, env)).toThrow(/GEEK_NOTES_USER/);
  });

  it("start 缺身份：以 1 退出并说明要带身份，在查 issue、建分支之前就停下", () => {
    const env = { ...process.env, GEEK_NOTES_USER: "", GEEK_NOTES_BY: "", PATH: "" };
    const result = spawnSync(process.execPath, [script, "start", "26", "no_identity"], { encoding: "utf8", env });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("GEEK_NOTES_USER / GEEK_NOTES_BY");
    expect(result.stdout).toBe("");
    // 身份参数只属于 start、finish、prune：list 带上它就是不认识的参数
    const list = spawnSync(process.execPath, [script, "list", "--user", "alice"], { encoding: "utf8", env });
    expect(list.status).toBe(2);
    expect(list.stderr).toContain("未知参数：--user");
  });

  it("收尾记录的标题按 PR 的实际状态写", () => {
    expect(finishTitle({ state: "MERGED", number: 42 })).toBe("PR #42 已合并，清理 worktree");
    expect(finishTitle({ state: "CLOSED", number: 42 })).toBe("PR #42 已关闭未合并，放弃，清理 worktree");
    expect(finishTitle({ state: null, number: null })).toBe("放弃，清理 worktree");
  });
});
