import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { REQUIRED_SECTIONS, checkPullRequest, closingIssues, issueFromBranch, sections } from "../../scripts/pr-contract.mjs";

const template = readFileSync(new URL("../../.github/pull_request_template.md", import.meta.url), "utf8");
const script = fileURLToPath(new URL("../../scripts/pr-contract.mjs", import.meta.url));
const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 把正文写进临时文件，返回路径（给 --body-file 用） */
function bodyFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pr-contract-"));
  temporary.push(dir);
  const path = join(dir, "body.md");
  writeFileSync(path, body);
  return path;
}

const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

/** 一份填好的正文：模板的每个段落都写了内容 */
function filled(overrides: Record<string, string> = {}): string {
  const text: Record<string, string> = {
    目的: "维护者反馈：审查队列在静默窗口内重复入队。",
    关联: "Closes #32",
    变更范围: "app/control/src/scheduler/queue.ts",
    解决链路: "1. 复现：同一个 PR 连推两次提交。\n2. 定位：入队前没有按 head SHA 去重。\n3. 修复：入队时按仓库、PR 号与 head SHA 去重。",
    验证命令与结果: "pnpm verify 通过",
    验收证据: "改前 ![before](https://github.com/o/r/assets/1/before.png) 改后 ![after](https://github.com/o/r/assets/1/after.png)",
    人工验收步骤: "1. 打开 https://geek-bot.example.com 的「任务」页\n2. 在测试仓库的 PR 上连推两次提交\n3. 应看到队列里只有一条审查任务",
    审查结论: "审查人：Claude\n\n**结论：通过**",
    风险与回滚: "revert 合并提交",
    ...overrides,
  };
  return REQUIRED_SECTIONS.map((name: string) => `### ${name}\n${text[name] ?? ""}\n`).join("\n");
}

describe("PR 正文契约", () => {
  it("分支号与 issue：只认 task/<n>/<slug>", () => {
    expect(issueFromBranch("task/32/review_queue")).toBe(32);
    expect(issueFromBranch("task/32-review")).toBeNull();
    expect(issueFromBranch("dev/alice")).toBeNull();
    expect(issueFromBranch("stage")).toBeNull();
  });

  it("识别 GitHub 的关闭关键字，Refs 不算", () => {
    expect(closingIssues("Closes #3\nfixes #4, Resolved #5\nRefs #6").sort()).toEqual([3, 4, 5]);
  });

  it("段落按三级标题切分，标题里的括号说明不影响名字", () => {
    const parts = sections("### 验证命令与结果（HEAD abc）\npnpm verify\n### 关联\nCloses #1");
    expect(parts.get("验证命令与结果")).toContain("pnpm verify");
    expect(parts.get("关联")).toContain("Closes #1");
  });

  it("填好的正文 + 开着的 issue：通过", () => {
    const result = checkPullRequest({ branch: "task/32/review_queue", body: filled(), issue: { number: 32, state: "OPEN" } });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("没写 Closes、关了别的 issue、issue 已关闭：各自报错", () => {
    expect(checkPullRequest({ branch: "task/32/x", body: filled({ 关联: "Refs #32" }) }).errors.join()).toContain("Closes #32");
    expect(checkPullRequest({ branch: "task/32/x", body: filled({ 关联: "Closes #32\nCloses #9" }) }).errors.join()).toContain("#9");
    expect(checkPullRequest({ branch: "task/32/x", body: filled(), issue: { number: 32, state: "CLOSED" } }).errors.join()).toContain("已经关闭");
  });

  it("Closes 的 issue 号与分支号不一致：失败，并指出分支对应的号", () => {
    const result = checkPullRequest({ branch: "task/32/review_queue", body: filled({ 关联: "Closes #31" }) });
    expect(result.ok).toBe(false);
    const errors = result.errors.join("\n");
    expect(errors).toContain("Closes #32");
    expect(errors).toContain("#31");
    const fetched = checkPullRequest({ branch: "task/32/review_queue", body: filled(), issue: { number: 31, state: "OPEN" } });
    expect(fetched.errors.join()).toContain("不一致");
  });

  it("不是 task 分支的 PR 进不了 stage", () => {
    expect(checkPullRequest({ branch: "dev/alice", body: filled() }).ok).toBe(false);
  });

  it("缺段落、空段落（只剩模板注释）都报错", () => {
    const missing = filled().replace(/### 人工验收步骤[\s\S]*?(?=### )/, "");
    expect(checkPullRequest({ branch: "task/32/x", body: missing }).errors.join()).toContain("人工验收步骤");
    const empty = filled({ 解决链路: "<!-- 复现 → 定位 → 修复 → 验证 -->" });
    expect(checkPullRequest({ branch: "task/32/x", body: empty }).errors.join()).toContain("是空的");
  });

  it("验收证据要有截图、录屏或附件；没有界面变化时要写明理由", () => {
    expect(checkPullRequest({ branch: "task/32/x", body: filled({ 验收证据: "看过了，没问题" }) }).errors.join()).toContain("截图");
    expect(checkPullRequest({ branch: "task/32/x", body: filled({ 验收证据: "无界面变化：只改了调度器的去重键" }) }).ok).toBe(true);
    expect(checkPullRequest({ branch: "task/32/x", body: filled({ 验收证据: '<img src="https://github.com/o/r/assets/1/a.png" width="600">' }) }).ok).toBe(true);
  });

  it("审查结论要有三种结论之一", () => {
    expect(checkPullRequest({ branch: "task/32/x", body: filled({ 审查结论: "看起来可以" }) }).errors.join()).toContain("结论：通过");
  });

  it("结论只出现在注释、代码块或句子中间：都不算结论行", () => {
    for (const 审查结论 of [
      "审查人：甲，commit abc\n<!-- **结论：通过** -->",
      "审查人：甲，commit abc\n```md\n**结论：通过**\n```",
      "审查人：甲，commit abc；我觉得 **结论：通过** 没问题",
    ]) {
      expect(checkPullRequest({ branch: "task/32/x", body: filled({ 审查结论 }) }).errors.join(), 审查结论).toContain("独占一行");
    }
    expect(checkPullRequest({ branch: "task/32/x", body: filled({ 审查结论: "审查人：甲\n\n  **结论：有条件通过**  " }) }).ok).toBe(true);
  });

  it("保留模板注释、只补一行审查人：注释里的结论行不算，失败", () => {
    // 模板「审查结论」段的注释里自带三种结论的写法；作者不删注释也不写结论，必须被拦下。
    const body = template
      .replace(/Closes #<!--[^\n]*-->/, "Closes #32")
      .replace(/(### (?:目的|变更范围|解决链路|验证命令与结果|人工验收步骤|风险与回滚)\n)/g, "$1已填写。\n")
      .replace(/(### 验收证据\n)/, "$1无界面变化：只改脚本。\n")
      .replace(/(### 审查结论\n)/, "$1审查人：甲，commit abc\n");
    const result = checkPullRequest({ branch: "task/32/x", body });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("「审查结论」没有独占一行");
    expect(checkPullRequest({ branch: "task/32/x", body: body.replace("审查人：甲，commit abc\n", "审查人：甲，commit abc\n**结论：通过**\n") }).ok).toBe(true);
  });

  it("Closes #n 只写在注释或代码里：不算关联，失败", () => {
    for (const 关联 of ["<!-- Closes #32 --> Refs #9", "`Closes #32` Refs #9", "```\nCloses #32\n```\nRefs #9"]) {
      const result = checkPullRequest({ branch: "task/32/x", body: filled({ 关联 }) });
      expect(result.ok, 关联).toBe(false);
      expect(result.errors.join(), 关联).toContain("正文没有 `Closes #32`");
    }
    expect(closingIssues("<!-- Closes #1 -->\nCloses #2\n<!-- 没闭合的注释 Closes #3")).toEqual([2]);
  });

  it("仓库里的 PR 模板本身带齐所有必需段落，且原样提交会因为空段落被拦下", () => {
    const parts = sections(template);
    for (const name of REQUIRED_SECTIONS) expect(parts.has(name), name).toBe(true);
    expect(checkPullRequest({ branch: "task/32/x", body: template }).ok).toBe(false);
  });

  it("命令行：填好的正文通过；缺段落或 Closes 号不一致以 1 退出并逐条报错", () => {
    const ok = run("check", "--branch", "task/32/review_queue", "--body-file", bodyFile(filled()));
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("PR 正文契约通过");
    const missing = run("check", "--branch", "task/32/review_queue", "--body-file", bodyFile(filled().replace(/### 风险与回滚[\s\S]*$/, "")));
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain("缺少段落「### 风险与回滚」");
    const mismatch = run("check", "--branch", "task/33/review_queue", "--body-file", bodyFile(filled()));
    expect(mismatch.status).toBe(1);
    expect(mismatch.stdout).toContain("Closes #33");
  });

  it("命令行：issue 子命令只认 task 分支；不认识的参数打印用法并以非 0 退出", () => {
    const issue = run("issue", "--branch", "task/32/review_queue");
    expect(issue.status).toBe(0);
    expect(issue.stdout.trim()).toBe("32");
    const personal = run("issue", "--branch", "dev/alice");
    expect(personal.status).toBe(1);
    expect(personal.stdout).toBe("");
    const unknown = run("check", "--branch", "task/32/review_queue", "--body", "x");
    expect(unknown.status).not.toBe(0);
    expect(unknown.stderr).toContain("未知参数：--body");
    expect(unknown.stderr).toContain("用法：node scripts/pr-contract.mjs");
  });
});
