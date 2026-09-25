import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TASK_BRANCH_RE as INVARIANTS_RE } from "../../scripts/check-branch-invariants.mjs";
import { TASK_BRANCH_RE as PR_CONTRACT_RE } from "../../scripts/pr-contract.mjs";
import { TASK_BRANCH_RE as TASK_RE } from "../../scripts/task.mjs";

// task 分支正则有三份：check-branch-invariants 判定命名（无捕获组），task.mjs 与 pr-contract.mjs 取 issue 号（带一个捕获组）。
// 三份必须描述同一个语言：去掉唯一的捕获组后与 check-branch-invariants 的 source 逐字相同。
const CAPTURE = "([0-9]+)";

describe("task 分支正则三份一致", () => {
  it("task.mjs 与 pr-contract.mjs 去掉捕获组后与 check-branch-invariants 逐字相同", () => {
    expect(INVARIANTS_RE.source).not.toMatch(/\((?!\?)/); // 只有非捕获组
    for (const copy of [TASK_RE, PR_CONTRACT_RE]) {
      expect(copy.source.split(CAPTURE)).toHaveLength(2);
      expect(copy.source.replace(CAPTURE, "[0-9]+")).toBe(INVARIANTS_RE.source);
      expect(copy.flags).toBe(INVARIANTS_RE.flags);
    }
  });

  it("两份带捕获组的副本都取出 issue 号", () => {
    expect(TASK_RE.exec("task/12/review_queue")?.[1]).toBe("12");
    expect(PR_CONTRACT_RE.exec("task/12/review_queue")?.[1]).toBe("12");
  });

  it("issue-lifecycle 合并后关闭 issue 时仍按 task/<数字>/ 取号", () => {
    const workflow = readFileSync(new URL("../../.github/workflows/issue-lifecycle.yml", import.meta.url), "utf8");
    expect(workflow).toContain("sed -nE 's#^task/([0-9]+)/.*#\\1#p'");
  });
});
