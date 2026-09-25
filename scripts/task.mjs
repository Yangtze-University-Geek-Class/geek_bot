#!/usr/bin/env node
// 一个 issue = 一个 task 分支 = 一个 git worktree = 一个 PR（docs/conventions/TRACKING.md §1、BRANCHING.md「task worktree」）。
//
//   node scripts/task.mjs start <issue> <slug>   从最新 origin/stage 建 task/<issue>/<slug> 与 worktree，issue 上留一条 progress 记录，
//                                                worktree 的 notes/ 里写链路第一条「开工」，并入暂存的执行记录
//   node scripts/task.mjs list                   列出每个 task worktree：分支、issue 状态、PR 状态、能否清理
//   node scripts/task.mjs finish <issue>         PR 已合并（或 issue 已关闭）且工作区干净时，删 worktree 与本地分支，暂存链路的「收尾」记录
//   node scripts/task.mjs prune                  对所有能清理的 task worktree 执行 finish
//
// 只动本机的 worktree 与本地分支；远端分支由 branch-hygiene.yml、issue 由 issue-lifecycle.yml 在合并时处理。
// 有未提交改动、或 PR 没合并且 issue 还开着的 worktree 一律不删，只报告原因。纯判断逻辑见 decideCleanup，有单测。
// start、finish、prune 都要知道是谁在干活（docs/conventions/NOTES.md）：--user <GitHub 用户名> --by <执行者>，
// 或环境变量 GEEK_NOTES_USER / GEEK_NOTES_BY；缺了就不开工、不收尾。
//
// gh 一律在主工作区里运行（cwd: mainRoot()），由 gh 按那里的 git remote 解析仓库，仓库地址不写死。
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectRun, parseFlags, runCli, UsageError } from "./lib/cli.mjs";
import { activeTaskSlugs, addNote, branchSlug, BY_RE, collectChains, flushPending, PENDING_DIR, USER_RE, writeIndex } from "./note.mjs";

/** task/<issue>/<slug>：与 check-branch-invariants.mjs、pr-contract.mjs 同一条规则 */
export const TASK_BRANCH_RE = /^task\/([0-9]+)\/[a-z0-9]+(?:_[a-z0-9]+)*$/;
export const SLUG_RE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
/** worktree 统一放在主工作区的 .claude/worktrees/task-<issue>（已被 .gitignore 忽略） */
export const WORKTREE_DIR = ".claude/worktrees";

export function taskBranch(issue, slug) {
  if (!/^[0-9]+$/.test(String(issue))) throw new Error(`issue 编号必须是数字：${issue}`);
  if (!SLUG_RE.test(String(slug))) throw new Error(`slug 只能用小写字母、数字和下划线（不用 -）：${slug}`);
  return `task/${Number(issue)}/${slug}`;
}

export function worktreePath(mainRoot, issue) {
  return join(mainRoot, WORKTREE_DIR, `task-${Number(issue)}`);
}

export function issueOfBranch(branch) {
  const match = TASK_BRANCH_RE.exec(String(branch ?? ""));
  return match ? Number(match[1]) : null;
}

/** 解析 `git worktree list --porcelain` */
export function parseWorktrees(porcelain) {
  const list = [];
  let current = null;
  for (const line of String(porcelain).split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice(9), branch: null, head: null, detached: false };
      list.push(current);
    } else if (current && line.startsWith("HEAD ")) current.head = line.slice(5);
    else if (current && line.startsWith("branch ")) current.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (current && line === "detached") current.detached = true;
  }
  return list;
}

/**
 * 这个 task worktree 能不能清理。
 * @param {{ dirty: boolean, issueState: string | null, prState: string | null }} input
 *   dirty：worktree 里有未提交或未跟踪的改动；issueState：OPEN / CLOSED / null（查不到）；
 *   prState：这条分支最近一个 PR 的状态 MERGED / OPEN / CLOSED / null（没有 PR）
 * @returns {{ ok: boolean, reason: string }}
 */
export function decideCleanup({ dirty, issueState, prState }) {
  if (dirty) return { ok: false, reason: "有未提交的改动：先提交或自己处理，脚本不替你丢弃" };
  if (prState === "MERGED") return { ok: true, reason: "PR 已合并" };
  if (prState === "OPEN") return { ok: false, reason: "PR 还开着：合并后再清理" };
  if (issueState === "CLOSED") return { ok: true, reason: prState === "CLOSED" ? "PR 已关闭且 issue 已关闭（放弃）" : "issue 已关闭，没有 PR（放弃）" };
  if (issueState === "OPEN") return { ok: false, reason: prState === "CLOSED" ? "PR 被关了但 issue 还开着：要么重开 PR，要么在 issue 上写明放弃并关闭" : "issue 还开着，还在做" };
  return { ok: false, reason: "查不到 issue 状态（离线或没有 gh 权限）：不清理" };
}

/**
 * cwd 是否就是 worktree 目录或在它里面。按路径段比较：task-3 不会误匹配 task-35。
 * @param {string} cwd
 * @param {string} worktree
 */
export function isInside(cwd, worktree) {
  const dir = resolve(cwd);
  const root = resolve(worktree);
  return dir === root || dir.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * 开工记录（docs/conventions/TRACKING.md 的 track v1 记录头）。纯函数，便于测试。
 * 评论里提到提交一律写完整 SHA（TRACKING §2），所以 base 必须是 40 位，短 SHA 直接拒绝。
 * @param {{ issue: number | string, branch: string, base: string, worktree: string }} input
 *   base 是 worktree 拉出时 origin/stage 的完整 SHA；worktree 是相对主工作区的路径
 */
export function startNote({ issue, branch, base, worktree }) {
  if (!/^[0-9a-f]{40}$/.test(String(base))) throw new Error(`开工记录要写基线提交的完整 40 位 SHA（docs/conventions/TRACKING.md §2），收到 ${base}`);
  return [
    "<!-- track v1 kind=progress stage=dev -->",
    `**进展**｜开工：分支 \`${branch}\`，独立 worktree`,
    "",
    `**现状**：从 \`origin/stage\`（${base}）拉出，worktree 在主工作区的 \`${worktree}\`；PR 合并后由 \`node scripts/task.mjs finish ${Number(issue)}\` 清理。`,
    `**引用**：#${Number(issue)} · ${base}`,
  ].join("\n");
}

/**
 * 执行记录的身份：替谁干活（GitHub 用户名）与执行者。命令行参数优先，其次环境变量；缺了或格式不对就失败。
 * @param {{ user?: string, by?: string }} flags
 * @param {Record<string, string | undefined>} [env]
 */
export function notesIdentity(flags, env = process.env) {
  const user = flags.user ?? env.GEEK_NOTES_USER;
  const by = flags.by ?? env.GEEK_NOTES_BY;
  if (!USER_RE.test(user ?? "") || !BY_RE.test(by ?? "")) {
    throw new Error("先说明是谁在干活（docs/conventions/NOTES.md）：--user <GitHub 用户名> --by <执行者，如 agent-claude-geek-bot-01（Claude Code，<模型>）或 human-alice>，或设置 GEEK_NOTES_USER / GEEK_NOTES_BY。");
  }
  return { user, by };
}

/** 收尾记录的标题：按 PR 的实际状态写，不把放弃写成合并。 */
export function finishTitle(pr) {
  if (pr?.state === "MERGED") return `PR #${pr.number} 已合并，清理 worktree`;
  if (pr?.state === "CLOSED") return `PR #${pr.number} 已关闭未合并，放弃，清理 worktree`;
  return "放弃，清理 worktree";
}

/**
 * 解读一次 `gh issue view <n> --json state --jq .state` 的结果（纯函数）。
 * gh 明确回答「没有这个编号」才算查不到；网络、TLS、认证、gh 不存在这些失败都算「查询失败」，不能当成 issue 不存在。
 * @param {{ ok: boolean, stdout?: string, stderr?: string }} result
 * @returns {{ state: string } | { notFound: true } | { error: string }}
 */
export function readIssueLookup({ ok, stdout = "", stderr = "" }) {
  if (ok) {
    const state = String(stdout).trim();
    return state ? { state } : { error: "gh 没有返回 issue 状态" };
  }
  const message = String(stderr).trim();
  if (/Could not resolve to an issue or pull request with the number of/i.test(message)) return { notFound: true };
  return { error: message || "gh 以非 0 退出，没有输出错误信息" };
}

/**
 * start 的前置判断：issue 开着才能开工。返回 null 表示可以开工，否则是要报的错误。
 * @param {number | string} issue
 * @param {{ state?: string, notFound?: true, error?: string }} lookup readIssueLookup 的结果
 */
export function startBlocker(issue, lookup) {
  if (lookup.error !== undefined) return `查 issue #${issue} 状态失败：${lookup.error}\n先确认 gh 能连上 GitHub（gh auth status），再重新运行；issue 本身不一定有问题。`;
  if (lookup.notFound) return `issue #${issue} 查不到：先开 issue（docs/conventions/ISSUES.md），再建 task。`;
  if (lookup.state !== "OPEN") return `issue #${issue} 状态是 ${lookup.state}：先开 issue（docs/conventions/ISSUES.md），再建 task。`;
  return null;
}

// ── 带副作用的部分 ────────────────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
}

/** 主工作区根目录：在任何一个 worktree 里运行都能找到（git-common-dir 的上一级） */
function mainRoot() {
  const common = run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: here });
  return dirname(common);
}

/** gh 在主工作区里运行：在仓库外（例如从别的目录用绝对路径启动本脚本）也查的是本仓库。 */
function gh(args) {
  try {
    return run("gh", args, { cwd: mainRoot() });
  } catch {
    return null;
  }
}

/**
 * 默认的 gh 调用：返回 { ok, stdout, stderr }，不抛错。gh 不存在时 ok 为 false，stderr 写明原因。
 * @param {string[]} args
 * @returns {{ ok: boolean, stdout: string, stderr: string }}
 */
function runGh(args) {
  const result = spawnSync("gh", args, { cwd: mainRoot(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) return { ok: false, stdout: "", stderr: `gh 不可用：${result.error.message}` };
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * 查 issue 状态，分清三种结果：有状态、查不到、查询失败。runner 可注入（测试用）。
 * @param {number | string} issue
 * @param {(args: string[]) => { ok: boolean, stdout?: string, stderr?: string }} [runner]
 */
export function lookupIssue(issue, runner = runGh) {
  return readIssueLookup(runner(["issue", "view", String(issue), "--json", "state", "--jq", ".state"]));
}

/** 清理判断只关心有没有状态：查不到和查询失败都当作 null，decideCleanup 会保留 worktree。 */
function issueState(issue) {
  const lookup = lookupIssue(issue);
  return lookup.state ?? null;
}

function prState(branch) {
  const out = gh(["pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", "state,number", "--jq", '.[0] | "\\(.state) \\(.number)"']);
  if (!out) return { state: null, number: null };
  const [state, number] = out.split(" ");
  return { state: state || null, number: number ? Number(number) : null };
}

function isDirty(path) {
  return run("git", ["-C", path, "status", "--porcelain"]).length > 0;
}

function taskWorktrees(root) {
  return parseWorktrees(run("git", ["-C", root, "worktree", "list", "--porcelain"]))
    .map((wt) => ({ ...wt, issue: issueOfBranch(wt.branch) }))
    .filter((wt) => wt.issue !== null);
}

function start(issue, slug, flags) {
  const identity = notesIdentity(flags);
  const root = mainRoot();
  const branch = taskBranch(issue, slug);
  const path = worktreePath(root, issue);
  const blocker = startBlocker(issue, lookupIssue(issue));
  if (blocker) throw new Error(blocker);
  if (existsSync(path)) throw new Error(`${relative(root, path)} 已经存在：一个 issue 只有一个 worktree，直接进去继续做。`);
  const existing = taskWorktrees(root).find((wt) => wt.issue === Number(issue));
  if (existing) throw new Error(`issue #${issue} 已经有 worktree：${existing.path}（分支 ${existing.branch}）。`);
  run("git", ["-C", root, "fetch", "--quiet", "origin", "stage"]);
  run("git", ["-C", root, "worktree", "add", "--quiet", "-b", branch, path, "origin/stage"]);
  // issue 上的记录写完整 SHA（TRACKING §2）；终端里只显示前 12 位，方便看。
  const base = run("git", ["-C", path, "rev-parse", "HEAD"]);
  const note = startNote({ issue, branch, base, worktree: relative(root, path) });
  const commented = gh(["issue", "comment", String(issue), "--body", note]) !== null;
  // 执行链路第一条：开工。之前在 task 分支之外暂存的记录（上一个 task 的收尾等）一起并进这个 worktree，随它的提交入库。
  const chainPath = addNote(path, {
    ...identity,
    chain: branch,
    stage: "开工",
    issues: [String(Number(issue))],
    title: `从 origin/stage ${base.slice(0, 12)} 建 ${branch}`,
    did: `node scripts/task.mjs start ${Number(issue)} ${slug}：从 origin/stage ${base} 建分支与 worktree ${relative(root, path)}，在 issue 上留开工记录`,
    result: commented ? "worktree 已建好，issue 上已留开工记录" : "worktree 已建好；gh 没能留言，issue 上的开工记录要手工补",
  });
  const others = activeTaskSlugs(root).filter((other) => other !== branchSlug(branch));
  const flushed = flushPending(join(root, PENDING_DIR), path, { skipSlugs: others });
  writeIndex(path);
  console.log(`已建 task：${branch}`);
  console.log(`worktree：${path}`);
  console.log(`基于：origin/stage ${base.slice(0, 12)}`);
  console.log(commented ? `已在 issue #${issue} 留开工记录` : `没能在 issue #${issue} 留言（gh 不可用），请手工补一条 progress 记录`);
  console.log(`执行链路：${relative(path, chainPath)}（已写「开工」）${flushed.length ? `；并入暂存记录 ${flushed.length} 个文件` : ""}`);
  console.log(`下一步：cd ${path} && pnpm install --frozen-lockfile；之后每一步用 node scripts/note.mjs add 记下来`);
}

function inspect(wt) {
  const pr = prState(wt.branch);
  const iss = issueState(wt.issue);
  const dirty = existsSync(wt.path) ? isDirty(wt.path) : false;
  return { ...wt, pr, issueState: iss, dirty, decision: decideCleanup({ dirty, issueState: iss, prState: pr.state }) };
}

function list() {
  const root = mainRoot();
  const rows = taskWorktrees(root).map((wt) => inspect(wt));
  if (!rows.length) {
    console.log("没有 task worktree。");
    return;
  }
  for (const row of rows) {
    const pr = row.pr.number ? `PR #${row.pr.number} ${row.pr.state}` : "没有 PR";
    console.log(`#${row.issue}\t${row.branch}\tissue ${row.issueState ?? "?"}\t${pr}\t${row.dirty ? "有改动" : "干净"}\t${row.decision.ok ? "可清理" : "保留"}：${row.decision.reason}\t${relative(root, row.path)}`);
  }
}

/**
 * 收尾记录：worktree 马上要删，先把「收尾」暂存到主工作区，下一个 task 开工时随它入库。
 * PR 没合并（放弃）时，worktree 里这条链路的记录还没进 stage，一起复制到暂存，免得只剩一条收尾。
 * 链路里没有「开工」（本规范之前开的 task）就不写，免得凭空出现一条只有收尾的链路。
 */
function stashFinishNote(root, row, identity) {
  const chain = [...collectChains(row.path).values()].find((candidate) => candidate.slug === branchSlug(row.branch));
  if (!chain?.files.some((file) => file.entries.some((entry) => entry.stage === "开工"))) {
    console.log(`链路 ${row.branch} 没有「开工」记录，不写收尾记录。`);
    return;
  }
  const pending = join(root, PENDING_DIR);
  if (row.pr.state !== "MERGED") {
    for (const file of chain.files) {
      const dest = join(pending, file.rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, readFileSync(join(row.path, file.rel), "utf8"));
    }
  }
  addNote(pending, {
    ...identity,
    chain: row.branch,
    stage: "收尾",
    issues: [String(row.issue)],
    title: finishTitle(row.pr),
    did: `node scripts/task.mjs finish ${row.issue}：删 worktree ${relative(root, row.path)} 与本地分支 ${row.branch}`,
    result: row.decision.reason,
  });
  console.log(`已暂存 ${row.branch} 的「收尾」记录：下一个 task 开工时随它入库。`);
}

function finishOne(root, wt, identity) {
  const row = inspect(wt);
  if (!row.decision.ok) {
    console.log(`保留 #${row.issue}（${row.branch}）：${row.decision.reason}`);
    return false;
  }
  if (isInside(process.cwd(), row.path)) throw new Error(`当前目录在要删的 worktree 里（${row.path}）：先 cd 到主工作区再运行。`);
  stashFinishNote(root, row, identity);
  run("git", ["-C", root, "worktree", "remove", row.path]);
  // 合并后本地分支落后于 stage 或已被 squash：-D 删除是预期的；前面已确认 PR 合并或 issue 放弃
  run("git", ["-C", root, "branch", "-D", row.branch]);
  console.log(`已清理 #${row.issue}：删掉 worktree ${relative(root, row.path)} 与本地分支 ${row.branch}（${row.decision.reason}）`);
  return true;
}

function finish(issue, flags) {
  const identity = notesIdentity(flags);
  const root = mainRoot();
  const wt = taskWorktrees(root).find((candidate) => candidate.issue === Number(issue));
  if (!wt) {
    console.log(`issue #${issue} 没有 task worktree，不需要清理。`);
    return;
  }
  if (!finishOne(root, wt, identity)) process.exitCode = 1;
}

function prune(flags) {
  const identity = notesIdentity(flags);
  const root = mainRoot();
  run("git", ["-C", root, "worktree", "prune"]);
  const all = taskWorktrees(root);
  const cleaned = all.filter((wt) => finishOne(root, wt, identity)).length;
  console.log(`共 ${all.length} 个 task worktree，清理 ${cleaned} 个。`);
}

const USAGE = [
  "用法：node scripts/task.mjs start <issue> <slug>   从最新 origin/stage 建 task/<issue>/<slug> 与 worktree，写执行记录「开工」",
  "      node scripts/task.mjs list                   列出每个 task worktree 与能否清理",
  "      node scripts/task.mjs finish <issue>         PR 已合并（或 issue 已放弃）且工作区干净时清理，暂存「收尾」",
  "      node scripts/task.mjs prune                  对所有能清理的 task worktree 执行 finish",
  "  start、finish、prune 要带身份：--user <GitHub 用户名> --by <执行者>，或环境变量 GEEK_NOTES_USER / GEEK_NOTES_BY（docs/conventions/NOTES.md）。",
].join("\n");

/** 每个子命令接受的位置参数个数 */
const ARITY = Object.freeze({ start: 2, list: 0, finish: 1, prune: 0 });

/** 带执行记录身份参数的子命令 */
const WITH_IDENTITY = Object.freeze(["start", "finish", "prune"]);

export function main(argv) {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }
  if (!command) throw new UsageError("缺少子命令");
  if (!Object.hasOwn(ARITY, command)) throw new UsageError(`未知子命令：${command}`);
  const { values, positionals } = parseFlags(rest, { values: WITH_IDENTITY.includes(command) ? ["--user", "--by"] : [], positionals: ARITY[command] });
  if (positionals.length !== ARITY[command]) throw new UsageError(`${command} 需要 ${ARITY[command]} 个参数，收到 ${positionals.length} 个`);
  // issue 号写错时不能走到「没有 worktree，不需要清理」：那会让人以为已经清理干净。
  if ((command === "start" || command === "finish") && !/^[0-9]+$/.test(positionals[0])) throw new UsageError(`${command} 需要数字 issue 号，收到 ${positionals[0]}`);
  const flags = { user: values["--user"], by: values["--by"] };
  if (command === "start") return start(positionals[0], positionals[1], flags);
  if (command === "list") return list();
  if (command === "finish") return finish(positionals[0], flags);
  return prune(flags);
}

// 入口判定走 isDirectRun（比较 realpath）：经符号链接路径启动时不会静默退出 0。
if (isDirectRun(import.meta.url)) runCli(main, USAGE);
