#!/usr/bin/env node
// PR 正文契约（docs/conventions/PULL-REQUESTS.md「正文契约」）：一件事 = 一个 issue = 一个 task 分支 = 一个 PR。
//
//   node scripts/pr-contract.mjs check  --branch <head ref> --body-file <path> [--issue-state-file <path>]
//   node scripts/pr-contract.mjs issue  --branch <head ref>      # 只打印分支对应的 issue 号
//
// check 只做文本判断（纯函数 checkPullRequest，tests/tooling/pr-contract.test.ts 覆盖），不联网；
// 工作流先用 gh 取 issue 状态写成 JSON，再用 --issue-state-file 交给它，这样本地与 CI 结论一致。
//
// issue-lifecycle.yml 只稀疏检出本文件与 scripts/lib/，所以这里除了 ./lib/cli.mjs 不导入别的脚本。
import { readFileSync } from "node:fs";
import { isDirectRun, parseFlags, runCli, UsageError } from "./lib/cli.mjs";

/** task/<issue>/<slug>：slug 小写字母数字与下划线（与 check-branch-invariants.mjs 的 TASK_BRANCH_RE 一致） */
export const TASK_BRANCH_RE = /^task\/([0-9]+)\/[a-z0-9]+(?:_[a-z0-9]+)*$/;

/**
 * PR 正文必须有的段落（三级标题 `### <名字>`）。顺序不限；名字逐字匹配，后面可以跟括号说明，
 * 例如 `### 验证命令与结果（HEAD abc123）`。
 */
export const REQUIRED_SECTIONS = ["目的", "关联", "变更范围", "解决链路", "验证命令与结果", "验收证据", "人工验收步骤", "审查结论", "风险与回滚"];

/** 验收证据里算作「证据」的东西：图片、视频、GitHub 附件链接、或明确写出的「无界面变化」理由 */
const EVIDENCE_RE = /!\[[^\]]*\]\([^)]+\)|<img\s[^>]*src=|<video\s|https:\/\/github\.com\/[^\s)]+\/(?:assets|files)\/|https:\/\/user-images\.githubusercontent\.com\/|\.(?:png|jpe?g|webp|gif|mp4|webm|mov)\b|无界面变化[:：]/i;

/** 审查结论行：独占一行，三种结论之一，逐字匹配。 */
const CONCLUSION_LINE_RE = /^[ \t]*\*\*结论：(?:通过|有条件通过|阻塞)\*\*[ \t]*$/m;

/**
 * 去掉 HTML 注释：GitHub 渲染后看不到，也不据此关闭 issue。没闭合的 `<!--` 一直隐藏到正文末尾。
 * 模板的注释里自带结论行与 Closes 写法，不去掉注释就等于没检查。
 */
export function stripComments(text) {
  return String(text ?? "").replace(/<!--[\s\S]*?(?:-->|$)/g, "");
}

/** 去掉围栏代码块与行内代码：代码里的 Closes #n、结论行都只是示例文字。 */
export function stripCode(text) {
  const out = [];
  let fence = null;
  for (const line of String(text ?? "").replace(/\r\n/g, "\n").split("\n")) {
    const mark = /^[ ]{0,3}(`{3,}|~{3,})/.exec(line);
    if (mark) {
      if (!fence) fence = mark[1];
      else if (mark[1][0] === fence[0] && mark[1].length >= fence.length) fence = null;
      continue;
    }
    if (!fence) out.push(line.replace(/(`+)[^`]*?\1/g, ""));
  }
  return out.join("\n");
}

/** 把正文按 `### 标题` 切成段落；标题里括号及之后的说明去掉，只留名字 */
export function sections(body) {
  const out = new Map();
  let current = null;
  for (const line of String(body ?? "").replace(/\r\n/g, "\n").split("\n")) {
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = heading[1].replace(/[（(].*$/, "").trim();
      out.set(current, "");
      continue;
    }
    if (current !== null) out.set(current, `${out.get(current)}${line}\n`);
  }
  return out;
}

/** 正文里 closes/fixes/resolves #n（大小写不敏感，GitHub 的关闭关键字）；注释与代码里的不算 */
export function closingIssues(body) {
  const found = new Set();
  for (const match of stripCode(stripComments(body)).matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#([0-9]+)\b/gi)) found.add(Number(match[1]));
  return [...found];
}

export function issueFromBranch(branch) {
  const match = TASK_BRANCH_RE.exec(String(branch ?? ""));
  return match ? Number(match[1]) : null;
}

/**
 * 检查一个 PR。issue 是 gh 取回的 `{ number, state, title }`（state: OPEN / CLOSED）；拿不到时传 null，
 * 只做文本检查。返回 { ok, errors[], issue }；errors 是给人看的中文句子，每条说清怎么改。
 * @param {{ branch: string, body: string, issue?: { number: number, state: string, title?: string } | null }} input
 */
export function checkPullRequest({ branch, body, issue = null }) {
  const errors = [];
  const number = issueFromBranch(branch);
  if (number === null) {
    errors.push(`分支名 ${branch} 不是 task/<issue>/<slug>：进入 stage 的 PR 只能来自对应 issue 的 task 分支（docs/conventions/BRANCHING.md）。`);
  }
  const closes = closingIssues(body);
  if (number !== null) {
    if (!closes.includes(number)) errors.push(`正文没有 \`Closes #${number}\`：分支 ${branch} 对应 issue #${number}，「关联」段要写 Closes #${number}。`);
    const extra = closes.filter((n) => n !== number);
    if (extra.length) errors.push(`正文关闭了分支以外的 issue（${extra.map((n) => `#${n}`).join("、")}）：一个 PR 只处理一个 issue，其它 issue 用「Refs #n」引用，不要用 Closes。`);
  }
  // 段落只看渲染后看得见的文字：先整体去掉 HTML 注释，注释里的标题、结论、证据都不算。
  const parts = sections(stripComments(body));
  for (const name of REQUIRED_SECTIONS) {
    const text = parts.get(name);
    if (text === undefined) errors.push(`缺少段落「### ${name}」（PR 模板 .github/pull_request_template.md）。`);
    else if (!text.trim()) errors.push(`段落「### ${name}」是空的：删掉模板里的注释后要写实际内容。`);
  }
  const evidence = parts.get("验收证据");
  if (evidence !== undefined && evidence.trim() && !EVIDENCE_RE.test(evidence)) {
    errors.push("「验收证据」里没有截图、录屏或附件链接：界面改动要放改前改后截图（或逐帧图、录屏）；确实没有界面变化时写「无界面变化：<理由>」。");
  }
  const review = parts.get("审查结论") ?? "";
  if (review.trim() && !CONCLUSION_LINE_RE.test(stripCode(review))) errors.push("「审查结论」没有独占一行的 `**结论：通过**`／`**结论：有条件通过**`／`**结论：阻塞**`（注释和代码块里的不算，docs/conventions/CODE-REVIEW.md）。");
  if (issue) {
    if (number !== null && issue.number !== number) errors.push(`取回的 issue 是 #${issue.number}，与分支里的 #${number} 不一致。`);
    else if (String(issue.state).toUpperCase() !== "OPEN") errors.push(`issue #${issue.number} 已经关闭：先重新打开它（或新开一个 issue 并改分支名），再提 PR。`);
  }
  return { ok: errors.length === 0, errors, issue: number };
}

const USAGE = [
  "用法：node scripts/pr-contract.mjs check --branch <head ref> --body-file <path> [--issue-state-file <path>]",
  "      node scripts/pr-contract.mjs issue --branch <head ref>   # 只打印分支对应的 issue 号，不是 task 分支则以 1 退出",
].join("\n");

export function main(argv) {
  const { flags, values, positionals } = parseFlags(argv, {
    flags: ["--help", "-h"],
    values: ["--branch", "--body-file", "--issue-state-file"],
    positionals: 1,
  });
  if (flags.has("--help") || flags.has("-h")) {
    console.log(USAGE);
    return;
  }
  const [command] = positionals;
  if (!command) throw new UsageError("缺少子命令：check 或 issue");
  const branch = values["--branch"];
  if (command === "issue") {
    if (!branch) throw new UsageError("issue 需要 --branch");
    if (values["--body-file"] || values["--issue-state-file"]) throw new UsageError("issue 只接受 --branch");
    const number = issueFromBranch(branch);
    if (number === null) process.exitCode = 1;
    else console.log(number);
    return;
  }
  if (command !== "check") throw new UsageError(`未知子命令：${command}`);
  if (!branch) throw new UsageError("check 需要 --branch");
  const bodyFile = values["--body-file"];
  if (!bodyFile) throw new UsageError("check 需要 --body-file");
  const body = readFileSync(bodyFile, "utf8");
  const stateFile = values["--issue-state-file"];
  const issue = stateFile ? JSON.parse(readFileSync(stateFile, "utf8")) : null;
  const result = checkPullRequest({ branch, body, issue });
  if (result.ok) {
    console.log(`PR 正文契约通过：分支 ${branch} ↔ issue #${result.issue}，${REQUIRED_SECTIONS.length} 个段落齐全，有验收证据。`);
    return;
  }
  for (const error of result.errors) console.log(`::error title=PR 正文契约::${error}`);
  console.error(`PR 正文契约未通过（${result.errors.length} 项），按上面逐条改 PR 描述后会自动重跑。`);
  process.exitCode = 1;
}

// 入口判定走 isDirectRun（比较 realpath）：经符号链接路径启动时不会静默退出 0。
if (isDirectRun(import.meta.url)) runCli(main, USAGE);
