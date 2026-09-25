#!/usr/bin/env node
// 执行记录（notes/）的写入、索引与核对。规则只在 docs/conventions/NOTES.md 定义，这里是它的实现。
//
//   node scripts/note.mjs add --stage <阶段> --issue <n> --title "…" --did "…" --result "…" [--next "…"] [--chain <分支>]
//        身份取 --user / --by，或环境变量 GEEK_NOTES_USER（替谁干活的 GitHub 用户名）/ GEEK_NOTES_BY（执行者）
//   node scripts/note.mjs flush        把暂存的记录（在 task 分支之外写的）并进当前 task worktree
//   node scripts/note.mjs index        重新生成 notes/INDEX.md；--summary 输出全部链路的一览表
//   node scripts/note.mjs check        核对 notes/ 的格式、链路顺序与索引
//   node scripts/note.mjs check --pr --base origin/stage --head task/12/review_queue [--for-review]
//                                      另外要求这个 task 的链路里有引用本 issue 的 开工、提交、PR、审查
//
// 每个子命令都接受 --root <仓库根目录>，默认是本脚本所在仓库（或 worktree）的根目录。
// 时间一律取北京时间（Asia/Shanghai，+08:00），由脚本读系统时钟，不接受手填。
// 纯函数都导出，测试见 tests/tooling/notes.test.ts。
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectRun, parseFlags, runCli, UsageError } from "./lib/cli.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const TIME_ZONE = "Asia/Shanghai";
/** 链路里一条记录的阶段；开工在最前，收尾在最后。 */
export const STAGES = Object.freeze(["开工", "方案", "开发", "提交", "推送", "PR", "审查", "返工", "合并", "发布", "验收", "阻塞", "收尾"]);
/** task 分支进 stage 之前，链路里必须已经有的阶段（都要引用本 issue）。 */
export const REQUIRED_BEFORE_MERGE = Object.freeze(["开工", "提交", "PR", "审查"]);
/** 发生在 PR 合并之后的阶段：task 分支已经不会再有提交，这些记录一律先暂存。 */
export const AFTER_MERGE_STAGES = Object.freeze(["合并", "发布", "验收", "收尾"]);
/** GitHub 用户名（小写）。 */
export const USER_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;
/** 执行者：agent-<工具>-<会话>（说明）或 human-<GitHub 用户名>。 */
export const BY_RE = /^(?:agent|human)-[a-z0-9]+(?:-[a-z0-9]+)*(?:（[^（）\n]+）)?$/;
/** 在 task 分支之外写的记录暂存在主工作区的这个目录（已被 .gitignore 忽略）。 */
export const PENDING_DIR = ".claude/notes-pending";
/** task/<issue>/<slug>：与 check-branch-invariants.mjs 的任务分支规则一致，另取 issue 号。 */
const TASK_RE = /^task\/(\d+)\/[a-z0-9]+(?:_[a-z0-9]+)*$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SLUG_RE = /^[a-z0-9_]+$/;
const ENTRY_RE = new RegExp(`^## (\\d{2}):(\\d{2}):(\\d{2}) \\+08:00 · (${STAGES.join("|")}) · ((?:#\\d+)(?: #\\d+)*|无 issue) · (\\S.*)$`);
const FIELDS = ["执行者", "做了什么", "结果", "下一步"];
const REQUIRED_FIELDS = ["执行者", "做了什么", "结果"];

const USAGE = [
  "用法：node scripts/note.mjs add --stage <阶段> [--issue <n>] --title <一句话> --did <做了什么> --result <结果> [--next <下一步>] [--chain <分支>] [--user <GitHub 用户名>] [--by <执行者>]",
  "      node scripts/note.mjs flush                 把暂存的记录并进当前 task worktree",
  "      node scripts/note.mjs index [--summary]     重新生成 notes/INDEX.md；--summary 只输出全部链路的一览表",
  "      node scripts/note.mjs check [--pr [--base <ref>] [--head <分支>] [--for-review]]",
  "  每个子命令都接受 --root <仓库根目录>。身份也可以用环境变量 GEEK_NOTES_USER / GEEK_NOTES_BY。",
  `  阶段：${STAGES.join("、")}。规则见 docs/conventions/NOTES.md。`,
].join("\n");

// ── 纯函数 ───────────────────────────────────────────────────────────────

/** 北京时间的日期与时刻，`now` 可注入以便测试。 */
export function beijingNow(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TIME_ZONE,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}:${parts.second}` };
}

/** 分支名 → 链路文件名：非字母数字换成 `_`（`task/12/review_queue` → `task_12_review_queue`）。 */
export function branchSlug(branch) {
  return String(branch ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export function chainFile(root, { date, user, chain }) {
  return join(root, "notes", date, user, `${branchSlug(chain)}.md`);
}

function oneLine(value, name) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) throw new Error(`缺少 --${name}`);
  return text;
}

/**
 * 一条记录的 Markdown；`issues` 为空数组时写「无 issue」。
 * @param {{ time: string, stage: string, issues: string[], title: string, by: string, did: string, result: string, next?: string }} entry
 */
export function formatEntry({ time, stage, issues, title, by, did, result, next }) {
  const refs = issues.length ? issues.map((n) => `#${n}`).join(" ") : "无 issue";
  const lines = [
    `## ${time} +08:00 · ${stage} · ${refs} · ${oneLine(title, "title")}`,
    "",
    `- 执行者：${oneLine(by, "by")}`,
    `- 做了什么：${oneLine(did, "did")}`,
    `- 结果：${oneLine(result, "result")}`,
  ];
  if (next !== undefined && String(next).trim()) lines.push(`- 下一步：${oneLine(next, "next")}`);
  return `${lines.join("\n")}\n`;
}

function header({ date, user, chain }) {
  return `# ${chain} · ${user} · ${date}\n\n负责人：${user}\n`;
}

/** 把若干条记录并进一个链路文件：按时间排序，标题行相同的只保留一条。暂存记录并入 task worktree 时用。 */
export function mergeEntries(file, meta, newBlocks) {
  mkdirSync(dirname(file), { recursive: true });
  const currentText = existsSync(file) ? readFileSync(file, "utf8").replace(/\r\n/g, "\n") : header(meta);
  const blocks = currentText.split(/\n(?=## )/).slice(1).map((block) => block.replace(/\n*$/, "\n"));
  const seen = new Set(blocks.map((block) => block.split("\n")[0].trim()));
  for (const block of newBlocks) {
    const trimmed = block.replace(/\n*$/, "\n");
    const heading = trimmed.split("\n")[0].trim();
    if (seen.has(heading)) continue;
    seen.add(heading);
    blocks.push(trimmed);
  }
  const timed = blocks.map((block) => ({ time: /^## (\d{2}:\d{2}:\d{2})/.exec(block)?.[1] ?? "00:00:00", block }));
  // Array.prototype.sort 是稳定排序：同一时刻的记录保持原来的先后
  timed.sort((a, b) => a.time.localeCompare(b.time));
  writeFileSync(file, `${header(meta)}\n${timed.map((item) => item.block.trimEnd()).join("\n\n")}\n`);
}

/** 在文件末尾追加一条记录；文件不存在时先写标题。 */
function appendEntry(file, meta, entry) {
  mkdirSync(dirname(file), { recursive: true });
  const current = existsSync(file) ? readFileSync(file, "utf8").replace(/\n*$/, "\n") : header(meta);
  writeFileSync(file, `${current}\n${entry.replace(/\n*$/, "\n")}`);
}

/**
 * 在 root/notes/<北京日期>/<user>/<链路>.md 末尾追加一条；返回文件路径。
 * @param {string} root
 * @param {{ user?: string, by?: string, chain: string, stage?: string, issues: string[], title?: string, did?: string, result?: string, next?: string, now?: Date }} options
 */
export function addNote(root, { user, by, chain, stage, issues, title, did, result, next, now }) {
  if (!USER_RE.test(user ?? "")) throw new Error(`--user（或 GEEK_NOTES_USER）要写替谁干活的 GitHub 用户名（小写），收到 ${JSON.stringify(user)}`);
  if (!BY_RE.test(by ?? "")) throw new Error(`--by（或 GEEK_NOTES_BY）要写执行者，形如 agent-claude-geek-bot-01（Claude Code，<模型>）或 human-alice，收到 ${JSON.stringify(by)}`);
  if (!STAGES.includes(stage ?? "")) throw new Error(`--stage 只能是 ${STAGES.join("、")}，收到 ${JSON.stringify(stage)}`);
  if (!branchSlug(chain)) throw new Error("--chain 要写链路对应的分支名（默认当前分支）");
  for (const n of issues) if (!/^\d+$/.test(String(n))) throw new Error(`--issue 只写数字，收到 ${JSON.stringify(n)}`);
  const { date, time } = beijingNow(now);
  const file = chainFile(root, { date, user, chain });
  appendEntry(file, { date, user, chain }, formatEntry({ time, stage, issues, title, by, did, result, next }));
  return file;
}

/** 解析一个链路文件：标题、负责人和每条记录。 */
export function parseChain(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const title = /^# (\S+) · (\S+) · (\d{4}-\d{2}-\d{2})$/.exec(lines[0] ?? "");
  const owner = lines.find((line) => line.startsWith("负责人："))?.slice(4).trim() ?? "";
  const entries = [];
  const badHeadings = [];
  let current = null;
  lines.forEach((line, index) => {
    if (line.startsWith("## ")) {
      const m = ENTRY_RE.exec(line);
      current = null;
      if (!m) {
        badHeadings.push(index + 1);
        return;
      }
      current = {
        line: index + 1,
        time: `${m[1]}:${m[2]}:${m[3]}`,
        hms: [Number(m[1]), Number(m[2]), Number(m[3])],
        stage: m[4],
        issues: m[5] === "无 issue" ? [] : m[5].split(" ").map((ref) => ref.slice(1)),
        title: m[6],
        fields: new Map(),
      };
      entries.push(current);
      return;
    }
    const field = /^- ([^：]+)：(.*)$/.exec(line);
    if (current && field && FIELDS.includes(field[1])) current.fields.set(field[1], field[2].trim());
  });
  return { chain: title?.[1] ?? null, user: title?.[2] ?? null, date: title?.[3] ?? null, owner, entries, badHeadings };
}

function validDate(text) {
  const m = DATE_RE.exec(text);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/** 核对一个链路文件；`rel` 是相对仓库根的路径（notes/<日期>/<用户>/<链路>.md）。 */
export function checkChainFile(rel, text) {
  const parts = rel.split("/");
  if (parts.length !== 4 || parts[0] !== "notes" || !parts[3].endsWith(".md")) return [`${rel}：链路只能放在 notes/<北京日期>/<GitHub 用户名>/<分支>.md`];
  const [, date, user, name] = parts;
  const slug = name.slice(0, -3);
  const problems = [];
  if (!validDate(date)) problems.push(`${rel}：日期目录 ${date} 不是有效日期（YYYY-MM-DD）`);
  if (!USER_RE.test(user)) problems.push(`${rel}：${user} 不是 GitHub 用户名（小写字母、数字和 -）`);
  if (!SLUG_RE.test(slug)) problems.push(`${rel}：文件名要是分支名把 / 和 - 换成 _，例如 task_12_review_queue.md`);
  const parsed = parseChain(text);
  if (!parsed.chain) problems.push(`${rel}:1：第一行要写成「# <分支> · ${user} · ${date}」`);
  else {
    if (parsed.date !== date) problems.push(`${rel}:1：标题里的日期 ${parsed.date} 和目录 ${date} 不一致`);
    if (parsed.user !== user) problems.push(`${rel}:1：标题里的 ${parsed.user} 和用户目录 ${user} 不一致`);
    if (branchSlug(parsed.chain) !== slug) problems.push(`${rel}:1：标题里的分支 ${parsed.chain} 和文件名 ${slug} 不一致`);
  }
  if (parsed.owner !== user) problems.push(`${rel}：缺少「负责人：${user}」一行`);
  for (const line of parsed.badHeadings) {
    problems.push(`${rel}:${line}：记录标题要写成「## HH:MM:SS +08:00 · <阶段> · #<issue> · <一句话>」，阶段是 ${STAGES.join("、")} 之一，没有 issue 写「无 issue」`);
  }
  let last = "";
  for (const entry of parsed.entries) {
    const [h, m, s] = entry.hms;
    if (h > 23 || m > 59 || s > 59) problems.push(`${rel}:${entry.line}：时间 ${entry.time} 不存在`);
    if (entry.time < last) problems.push(`${rel}:${entry.line}：时间 ${entry.time} 早于上一条 ${last}，记录只能往后追加`);
    last = entry.time;
    for (const field of REQUIRED_FIELDS) {
      if (!entry.fields.has(field)) problems.push(`${rel}:${entry.line}：这条记录缺少「- ${field}：」`);
      else if (!entry.fields.get(field)) problems.push(`${rel}:${entry.line}：「${field}」不能是空的`);
    }
    const by = entry.fields.get("执行者");
    if (by && !BY_RE.test(by)) problems.push(`${rel}:${entry.line}：执行者要写成 agent-<工具>-<会话>（说明）或 human-<GitHub 用户名>`);
  }
  if (!parsed.entries.length && !parsed.badHeadings.length) problems.push(`${rel}：一条记录也没有`);
  return problems;
}

/** 全部链路：key 为 `<用户>/<链路文件名>`，按日期排好的文件与记录。 */
export function collectChains(root) {
  const base = join(root, "notes");
  const chains = new Map();
  if (!existsSync(base)) return chains;
  for (const date of readdirSync(base).filter((name) => DATE_RE.test(name)).sort()) {
    const dateDir = join(base, date);
    if (!lstatSync(dateDir).isDirectory()) continue;
    const users = readdirSync(dateDir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name).sort();
    for (const user of users) {
      const names = readdirSync(join(dateDir, user), { withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith(".md") && !d.name.startsWith(".")).map((d) => d.name).sort();
      for (const name of names) {
        const rel = `notes/${date}/${user}/${name}`;
        const parsed = parseChain(readFileSync(join(root, rel), "utf8"));
        const key = `${user}/${name.slice(0, -3)}`;
        if (!chains.has(key)) chains.set(key, { user, slug: name.slice(0, -3), chain: parsed.chain, files: [] });
        chains.get(key).files.push({ date, rel, entries: parsed.entries });
      }
    }
  }
  return chains;
}

/** task 链路的规则：第一条是开工；收尾之后不能再有记录。stage、main 等链路只记发布与验收，不要求。 */
export function checkChainOrder(chain) {
  const problems = [];
  const all = chain.files.flatMap((file) => file.entries.map((entry) => ({ ...entry, rel: file.rel })));
  if (!all.length || !TASK_RE.test(chain.chain ?? "")) return problems;
  if (all[0].stage !== "开工") problems.push(`${all[0].rel}:${all[0].line}：链路 ${chain.user}/${chain.slug} 的第一条必须是「开工」（开发前先记），现在是「${all[0].stage}」`);
  const closed = all.findIndex((entry) => entry.stage === "收尾");
  if (closed >= 0 && closed < all.length - 1) problems.push(`${all[closed + 1].rel}:${all[closed + 1].line}：链路 ${chain.user}/${chain.slug} 已经收尾，后面不能再记；重新开始要开新的 task`);
  return problems;
}

/** notes/INDEX.md：按日期（新的在前）列出每个人的目录；每个人目录下一条链路一个文件。 */
export function renderIndex(root) {
  const base = join(root, "notes");
  const dates = existsSync(base) ? readdirSync(base).filter((name) => DATE_RE.test(name)).sort().reverse() : [];
  const lines = [
    "# 执行记录索引",
    "",
    "> 由 `node scripts/note.mjs index` 生成，不要手改。规则见 [NOTES](../docs/conventions/NOTES.md)。每个日期下按 GitHub 用户名分目录，目录里一条链路一个文件，文件名是分支名；全部链路的一览表见 `node scripts/note.mjs index --summary`，每次 CI 运行也会贴进运行摘要。",
    "",
  ];
  if (!dates.length) lines.push("还没有记录。");
  for (const date of dates) {
    const users = readdirSync(join(base, date), { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name).sort();
    lines.push(`- ${date}：${users.map((user) => `[${user}](${date}/${user}/)`).join("、")}`);
  }
  return `${lines.join("\n")}\n`;
}

/** 全部链路的一览表（Markdown），给 CI 运行摘要和终端里看。 */
export function renderSummary(root) {
  const rows = [...collectChains(root).values()]
    .map((chain) => {
      const all = chain.files.flatMap((file) => file.entries.map((entry) => ({ ...entry, date: file.date })));
      const first = all[0];
      const last = all.at(-1);
      const issues = [...new Set(all.flatMap((entry) => entry.issues))].map((n) => `#${n}`).join(" ");
      const bys = [...new Set(all.map((entry) => (entry.fields.get("执行者") ?? "").replace(/（.*$/, "")).filter(Boolean))].join("、");
      return {
        key: `${last?.date ?? ""} ${last?.time ?? ""}`,
        line: `| ${chain.user} | ${chain.chain ?? chain.slug} | ${issues} | ${bys} | ${all.length} | ${first ? `${first.date} ${first.time}` : ""} | ${last ? `${last.stage}（${last.date} ${last.time}）` : ""} |`,
      };
    })
    .sort((a, b) => b.key.localeCompare(a.key));
  return ["## 执行记录：全部链路", "", "| 负责人 | 链路 | issue | 执行者 | 条数 | 开工 | 最后一条 |", "|---|---|---|---|---|---|---|", ...rows.map((row) => row.line), ""].join("\n");
}

/** 核对 root 下全部记录；返回问题列表。 */
export function checkAll(root) {
  const base = join(root, "notes");
  if (!existsSync(base)) return [];
  const problems = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      const rel = relative(root, path).split("\\").join("/");
      if (entry.isSymbolicLink()) problems.push(`${rel}：notes/ 下不放符号链接`);
      else if (entry.isDirectory()) walk(path);
      else if (rel === "notes/INDEX.md") continue;
      else if (!rel.endsWith(".md") || rel.split("/").length !== 4) problems.push(`${rel}：notes/ 下只放 <日期>/<用户>/<链路>.md 和 INDEX.md`);
      else problems.push(...checkChainFile(rel, readFileSync(path, "utf8")));
    }
  };
  walk(base);
  for (const chain of collectChains(root).values()) problems.push(...checkChainOrder(chain));
  const index = join(base, "INDEX.md");
  if (!existsSync(index) || readFileSync(index, "utf8") !== renderIndex(root)) problems.push("notes/INDEX.md 不是最新的：运行 `node scripts/note.mjs index` 重新生成");
  return problems;
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

/**
 * task/<issue>/<slug> 进 stage 的 PR：这个分支的链路里必须有引用 #<issue> 的开工、提交、PR、审查，
 * 并且这次改动新增了引用 #<issue> 的记录；notes/ 下已有的记录（INDEX.md 除外）不能被改写或删除。
 * forReview 为 true 时允许暂缺「审查」记录（审查进行中）。不是 task 分支时不要求。返回问题列表。
 * git 命令失败（例如 base 解析不了）直接抛错，不当作通过。
 * @param {string} root
 * @param {{ base: string, head: string, forReview?: boolean }} options
 */
export function checkPullRequest(root, { base, head, forReview = false }) {
  const task = TASK_RE.exec(head ?? "");
  if (!task) return [];
  const issue = task[1];
  const slug = branchSlug(head);
  const mine = [...collectChains(root).values()].filter((chain) => chain.slug === slug);
  if (!mine.length) return [`没有 ${head} 的执行链路：notes/<日期>/<GitHub 用户名>/${slug}.md 不存在。开工时 task.mjs start 会写第一条，之后每一步都要记（docs/conventions/NOTES.md）。`];
  const entries = mine.flatMap((chain) => chain.files.flatMap((file) => file.entries)).filter((entry) => entry.issues.includes(issue));
  const hint = (stage) => `  node scripts/note.mjs add --stage ${stage} --issue ${issue} --title "<一句话>" --did "<做了什么>" --result "<结果和证据>"`;
  const required = forReview ? REQUIRED_BEFORE_MERGE.filter((stage) => stage !== "审查") : REQUIRED_BEFORE_MERGE;
  const problems = required
    .filter((stage) => !entries.some((entry) => entry.stage === stage))
    .map((stage) => `${head} 的链路里还没有引用 #${issue} 的「${stage}」记录，例如：\n${hint(stage)}`);

  // 只能追加：已有的记录不改不删（NOTES §3）。INDEX.md 是生成物，不算。
  const range = `${base}...HEAD`;
  for (const line of git(root, ["diff", "--no-renames", "--name-status", range, "--", "notes/"]).split("\n").filter(Boolean)) {
    const [status, path] = line.split("\t");
    if (path === "notes/INDEX.md") continue;
    if (status === "D") problems.push(`不能删除执行记录：${path}（已写的记录不改不删）`);
  }
  let file = "";
  for (const line of git(root, ["diff", "--no-renames", "--unified=0", "--no-color", range, "--", "notes/"]).split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = / b\/(\S+)$/.exec(line)?.[1] ?? "";
      continue;
    }
    if (file === "notes/INDEX.md" || line.startsWith("--- ")) continue;
    if (line.startsWith("-")) {
      problems.push(`${file}：删除或改写了已有记录的行（「${line.slice(1).trim()}」），记录只能往末尾追加`);
      break;
    }
  }

  const added = git(root, ["diff", "--no-renames", "--unified=0", "--no-color", "--diff-filter=AM", range, "--", "notes/"])
    .split("\n")
    .filter((line) => line.startsWith("+## "))
    .map((line) => ENTRY_RE.exec(line.slice(1)))
    .filter(Boolean);
  if (!added.some((m) => m[5].split(" ").includes(`#${issue}`))) problems.push(`这次改动没有新增引用 #${issue} 的记录：链路要随开发持续往后记。`);
  return problems;
}

/**
 * 把 from/notes 下暂存的记录并进 to/notes（按时间合并、去重），并入的暂存文件随即删除。返回并进的文件。
 * 两种暂存留着不动：属于 skipSlugs 里链路的（别的 task worktree 还在用，由它自己 flush）；
 * task 链路在暂存和目标里都找不到「开工」的（目标 worktree 里没有这条链路的前文，并进来会是一条断掉的链路）。
 * @param {string} from 暂存目录（主工作区的 .claude/notes-pending）
 * @param {string} to 目标 task worktree
 * @param {{ skipSlugs?: Iterable<string> }} [options]
 */
export function flushPending(from, to, { skipSlugs = [] } = {}) {
  const base = join(from, "notes");
  if (!existsSync(base)) return [];
  const skip = new Set(skipSlugs);
  const hasStart = (chains, key) => chains.get(key)?.files.some((file) => file.entries.some((entry) => entry.stage === "开工")) ?? false;
  const pendingChains = collectChains(from);
  const targetChains = collectChains(to);
  const moved = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const slug = entry.name.slice(0, -3);
      if (skip.has(slug)) continue;
      const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
      const parsed = parseChain(text);
      const blocks = text.split(/\n(?=## )/).slice(1);
      if (!parsed.chain || !parsed.user || !parsed.date || !blocks.length) continue;
      const key = `${parsed.user}/${slug}`;
      if (TASK_RE.test(parsed.chain) && !hasStart(pendingChains, key) && !hasStart(targetChains, key)) continue;
      const rel = relative(from, path).split("\\").join("/");
      mergeEntries(join(to, rel), { date: parsed.date, user: parsed.user, chain: parsed.chain }, blocks);
      rmSync(path);
      moved.push(rel);
    }
  };
  walk(base);
  const removeEmpty = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) removeEmpty(join(dir, entry.name));
    if (!readdirSync(dir).length) rmSync(dir, { recursive: true, force: true });
  };
  removeEmpty(base);
  return moved;
}

// ── 读 Git 状态 ──────────────────────────────────────────────────────────

export function currentBranch(root) {
  try {
    return git(root, ["branch", "--show-current"]).trim();
  } catch {
    return "";
  }
}

/** 主工作区根目录（任何 worktree 里都能找到），暂存目录放在它下面。 */
export function mainRoot(root) {
  return dirname(git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim());
}

/** 本机各个 worktree 检出的 task 分支对应的链路文件名。 */
export function activeTaskSlugs(root) {
  const text = git(root, ["worktree", "list", "--porcelain"]);
  return text
    .split("\n")
    .filter((line) => line.startsWith("branch refs/heads/task/"))
    .map((line) => branchSlug(line.slice("branch refs/heads/".length)));
}

/**
 * 这条 task 链路是不是已经随 PR 合进 origin/stage：HEAD 已在 origin/stage 里，而且 HEAD 里已经有这条链路的文件。
 * 刚开工的 worktree（HEAD 就是 stage 的某个提交、还没有这条链路）不算。取不到 origin/stage 时按没合并处理。
 */
export function chainMerged(root, chain) {
  try {
    git(root, ["merge-base", "--is-ancestor", "HEAD", "origin/stage"]);
  } catch {
    return false;
  }
  const slug = branchSlug(chain);
  return git(root, ["ls-tree", "-r", "--name-only", "HEAD", "--", "notes"]).split("\n").some((path) => path.endsWith(`/${slug}.md`));
}

/**
 * 写一条记录。当前 worktree 就在这条链路的 task 分支上、PR 还没合并、阶段也不是合并之后的阶段时，写进这个 worktree 并更新索引；
 * 其它情况（主工作区、release 用的 worktree、给别的链路补记、合并之后的记录）暂存到主工作区的 .claude/notes-pending/，
 * 下一个 task 开工时（task.mjs start）或在 task worktree 里运行 flush 时并进去。
 */
export function record(root, options) {
  const branch = currentBranch(root);
  const chain = options.chain ?? branch;
  if (!chain) throw new Error("--chain 要写链路对应的分支名：当前不在任何分支上");
  const here = chain === branch && TASK_RE.test(branch) && !AFTER_MERGE_STAGES.includes(options.stage) && !chainMerged(root, chain);
  const target = here ? root : join(mainRoot(root), PENDING_DIR);
  const file = addNote(target, { ...options, chain });
  if (here) writeIndex(root);
  return { file, here };
}

export function writeIndex(root) {
  mkdirSync(join(root, "notes"), { recursive: true });
  writeFileSync(join(root, "notes", "INDEX.md"), renderIndex(root));
}

// ── 命令行 ───────────────────────────────────────────────────────────────

const SPECS = Object.freeze({
  add: { flags: ["--help", "-h"], values: ["--root", "--user", "--by", "--chain", "--stage", "--issue", "--title", "--did", "--result", "--next"] },
  flush: { flags: ["--help", "-h"], values: ["--root"] },
  index: { flags: ["--help", "-h", "--summary"], values: ["--root"] },
  check: { flags: ["--help", "-h", "--pr", "--for-review"], values: ["--root", "--base", "--head"] },
});

/** `--issue "87 91"`、`--issue 87,#91` → ["87", "91"]；不是数字的原样留下，由 addNote 报错。 */
export function parseIssues(value) {
  if (value === undefined) return [];
  return String(value)
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((ref) => ref.replace(/^#/, ""))
    .map((ref) => (/^\d+$/.test(ref) ? String(Number(ref)) : ref));
}

export function main(argv) {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }
  if (!command) throw new UsageError("缺少子命令");
  if (command.startsWith("-")) throw new UsageError(`未知参数：${command}`);
  if (!Object.hasOwn(SPECS, command)) throw new UsageError(`未知子命令：${command}`);
  const { flags, values } = parseFlags(rest, SPECS[command]);
  if (flags.has("--help") || flags.has("-h")) {
    console.log(USAGE);
    return;
  }
  const root = values["--root"] ? resolve(values["--root"]) : ROOT;

  if (command === "add") {
    const { file, here } = record(root, {
      user: values["--user"] ?? process.env.GEEK_NOTES_USER,
      by: values["--by"] ?? process.env.GEEK_NOTES_BY,
      chain: values["--chain"],
      stage: values["--stage"],
      issues: parseIssues(values["--issue"]),
      title: values["--title"],
      did: values["--did"],
      result: values["--result"],
      next: values["--next"],
    });
    console.log(here ? `已写入 ${relative(root, file)}，并更新 notes/INDEX.md` : `已暂存到 ${file}：下一个 task 开工时（task.mjs start）或在 task worktree 里运行 node scripts/note.mjs flush 并进去`);
    return;
  }
  if (command === "flush") {
    if (!TASK_RE.test(currentBranch(root))) throw new Error("flush 要在 task worktree 里运行：暂存的记录随这个 task 的提交入库");
    const target = branchSlug(currentBranch(root));
    const others = activeTaskSlugs(root).filter((slug) => slug !== target);
    const moved = flushPending(join(mainRoot(root), PENDING_DIR), root, { skipSlugs: others });
    writeIndex(root);
    console.log(moved.length ? `已并入 ${moved.length} 个文件：${moved.join("、")}` : "没有可以并入的暂存记录。");
    return;
  }
  if (command === "index") {
    if (flags.has("--summary")) {
      process.stdout.write(renderSummary(root));
      return;
    }
    writeIndex(root);
    console.log("已生成 notes/INDEX.md");
    return;
  }
  // check
  const pr = flags.has("--pr");
  if (!pr && (values["--base"] !== undefined || values["--head"] !== undefined || flags.has("--for-review"))) {
    throw new UsageError("--base、--head、--for-review 只能和 --pr 一起用");
  }
  const problems = checkAll(root);
  if (pr) {
    const head = values["--head"] ?? currentBranch(root);
    problems.push(...checkPullRequest(root, { base: values["--base"] ?? "origin/stage", head, forReview: flags.has("--for-review") }));
  }
  if (problems.length) {
    for (const problem of problems) console.error(problem);
    console.error(`执行记录检查未通过（${problems.length} 项）。补记录，不改检查（docs/conventions/NOTES.md §6）。`);
    process.exitCode = 1;
    return;
  }
  console.log(`执行记录检查通过：${collectChains(root).size} 条链路${pr ? "，本 task 的链路完整" : ""}。`);
}

if (isDirectRun(import.meta.url)) runCli(main, USAGE);
