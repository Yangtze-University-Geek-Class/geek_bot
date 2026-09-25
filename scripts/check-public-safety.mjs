#!/usr/bin/env node
/**
 * 公开安全门禁：仓库以后可能公开，代码、文档、测试、夹具里都不能出现组织专属信息。
 *
 *   node scripts/check-public-safety.mjs [--root <仓库根目录>]
 *   node scripts/check-public-safety.mjs --hash <token 或 IPv4>  # 打印要追加进被禁清单的 SHA-256
 *
 * 扫描 `git ls-files --cached --others --exclude-standard` 列出的文件：
 *   - 每个路径逐段扫描（文件名、目录名随仓库公开，二进制、快照、符号链接的路径同样要查）；
 *   - 文本文件扫描内容；二进制文件（前 8 KB 里有 NUL）只查路径；
 *   - 符号链接扫描链接目标（Git 把目标路径作为内容入库）；
 *   - 受哈希管理的上游快照只跳过内容：docs/components/tuffex/reference/** 与 snapshot/** 下、
 *     登记在 docs/components/tuffex/manifest.json 里的文件（由 tuffex-docs check 逐文件核对哈希）；
 *     这两个目录里没登记的文件照常扫描。
 * 规则：
 *   1. 私网 IPv4（10/8、172.16/12、192.168/16）、CGNAT（100.64/10）、链路本地（169.254/16）；
 *   2. 主机名里带 `.mesh.` 这一段（组网内部主机名）；
 *   3. 被禁 token：文本转小写后按 [a-z0-9]+ 切成 token；另按驼峰、全大写缩写接小写、字母与数字相连这几种边界
 *      再切一次（fooBar、ABCbot、host01）。每个 token 本身，以及它长度不小于 4 的每个前缀和后缀，逐个算 SHA-256，
 *      与 scripts/public-safety-denylist.json 比对，这样被禁词和别的词连写（<词>bot、<词>university）也能拦住；
 *      夹在中间的连写拦不住。另把每个 IPv4 字面量整体算 SHA-256 比对（用于个别公网地址）。
 *      清单里只有哈希，没有明文；用 --hash 生成新条目（只接受单个 [a-z0-9]+ token 或 IPv4，其它输入永远匹配不上，直接拒绝）。
 *   4. 放行清单 scripts/public-safety-allow.json：逐条写 { path, value, reason }，不许有别的字段。value 对规则 1、2
 *      是命中的原文，对规则 3 是命中的 SHA-256。放行项必须写明理由；没有命中的放行项也算失败（清单要跟着文件一起清理）。
 *      放行清单自己的 path 与 reason 照常扫描，命中不能再被放行；只有 value 不扫（它要么是哈希，
 *      要么必须与别处一处已放行的命中逐字相同，否则就是没用上的放行项）。
 *
 * 报告里不回显命中的原文（地址只保留第一段，token 只给哈希前缀），免得在公开的 CI 日志里再泄露一次。
 * 反例测试见 tests/tooling/public-safety.test.ts：字面量都在运行时拼出，或者注入测试自己的哈希表。
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectRun, parseFlags, runCli, UsageError } from "./lib/cli.mjs";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(SCRIPTS, "..");
/** 被禁清单属于本工具：无论扫描哪个根目录，都用脚本旁边这一份。 */
export const DENYLIST_FILE = join(SCRIPTS, "public-safety-denylist.json");
/** 放行清单属于被扫描的仓库：取 <root>/scripts/public-safety-allow.json，不存在就当作空。 */
export const ALLOW_FILE = "scripts/public-safety-allow.json";
/** 上游快照目录：只跳过其中登记在 manifest 里的文件内容（它们由 tuffex-docs check 逐文件核对哈希）。 */
export const SKIPPED_PREFIXES = Object.freeze(["docs/components/tuffex/reference/", "docs/components/tuffex/snapshot/"]);
/** 上游快照的清单：files[].path 相对 docs/components/tuffex/。 */
export const TUFFEX_DIR = "docs/components/tuffex/";
export const TUFFEX_MANIFEST = `${TUFFEX_DIR}manifest.json`;
/** 放行清单每一项只能有这三个字段。 */
const ALLOW_KEYS = Object.freeze(["path", "value", "reason"]);

const USAGE = [
  "用法：node scripts/check-public-safety.mjs [--root <仓库根目录>]",
  "      node scripts/check-public-safety.mjs --hash <token 或 IPv4>",
  "  扫描未被忽略的文件内容、路径与符号链接目标：私网/CGNAT/链路本地地址、带 .mesh. 段的主机名、被禁 token 与 IPv4 的哈希。",
  "  --hash 只接受单个 [a-z0-9]+ token（大小写不限）或 IPv4：扫描按 token 比对，别的输入算出的哈希永远匹配不上。",
  "  放行项写进 scripts/public-safety-allow.json：[{ \"path\": ..., \"value\": ..., \"reason\": ... }]。",
].join("\n");

const HEX64 = /^[a-f0-9]{64}$/;
// IPv4 字面量：前后都不能紧挨数字或点（排除 1.2.3.4.5 这类版本号片段）；每段 0–255 在 classifyIPv4 里再核。
const IPV4_RE = /(?<![0-9.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\.?[0-9])/g;
// 至少一段标签 + .mesh. + 至少一段标签；前面不能紧挨主机名字符。
const MESH_HOST_RE = /(?<![A-Za-z0-9-])(?:[A-Za-z0-9-]+\.)+mesh\.[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*/gi;

/** @typedef {{ file: string, line: number, rule: string, value: string, shown: string }} Finding 一处命中 */
/** @typedef {{ path: string, value: string, reason: string }} AllowEntry 放行清单的一项 */

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** 被禁清单里的词统一按小写、去首尾空白后计算哈希。 */
export function hashTerm(term) {
  return sha256(String(term).trim().toLowerCase());
}

/**
 * --hash 的输入能不能被扫描命中：只有单个 [a-z0-9]+ token 或 IPv4 字面量能。能返回 null，不能返回原因。
 * 其它输入算出的哈希永远匹配不上（扫描按 token 切分），登记进清单只会让人以为已经拦住。
 * @param {string} term
 */
export function hashTermProblem(term) {
  const value = String(term).trim().toLowerCase();
  if (!value) return "--hash 需要一个非空的词";
  if (/^[a-z0-9]+$/.test(value)) return null;
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (octets) return octets.slice(1).every((part) => Number(part) <= 255) ? null : "--hash 的 IPv4 每段必须在 0–255 之间";
  if (/\p{Script=Han}/u.test(value)) return "--hash 不接受汉字：扫描只按 [a-z0-9]+ 切 token，汉字词的哈希永远匹配不上";
  const parts = value.match(/[a-z0-9]+/g) ?? [];
  if (parts.length > 1) return `--hash 只接受单个 token：输入会被切成 ${parts.join("、")} ${parts.length} 个 token，永远匹配不上，请分别登记`;
  return "--hash 只接受单个 [a-z0-9]+ token 或 IPv4：其它字符不参与比对，这条哈希永远匹配不上";
}

/**
 * 判断一个 IPv4 属于哪类受限网段；不在受限网段返回 null，不是合法地址也返回 null。
 * @param {number[]} octets
 */
export function classifyIPv4(octets) {
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  const [a, b] = octets;
  if (a === 10) return "私网地址（10/8）";
  if (a === 172 && b >= 16 && b <= 31) return "私网地址（172.16/12）";
  if (a === 192 && b === 168) return "私网地址（192.168/16）";
  if (a === 100 && b >= 64 && b <= 127) return "CGNAT 地址（100.64/10）";
  if (a === 169 && b === 254) return "链路本地地址（169.254/16）";
  return null;
}

/**
 * 一行文本里的 token：整行小写后按 [a-z0-9]+ 切；再按驼峰（fooBar）、全大写缩写接小写（ABCbot、ABCBot）、
 * 字母与数字相连（host01、2026abc）这几种边界补切一次。
 */
export function tokensOf(line) {
  const tokens = new Set(line.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const digits = (text) => text.replace(/([A-Za-z])([0-9])/g, "$1 $2").replace(/([0-9])([A-Za-z])/g, "$1 $2");
  const lowerStart = line.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  // 全大写串后面接小写有两种读法：ACMEBot 是 ACME + Bot，ACMEbot 是 ACME + bot。两种都切，token 取并集。
  const variants = [lowerStart.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2"), lowerStart.replace(/([A-Z]{2,})([a-z])/g, "$1 $2")];
  for (const variant of variants) for (const token of digits(variant).toLowerCase().match(/[a-z0-9]+/g) ?? []) tokens.add(token);
  return tokens;
}

/** 连写检测的最短片段：被禁词里最短的是 4 个字符。 */
export const MIN_AFFIX = 4;

/** 一个 token 要比对的候选：它本身，以及长度不小于 MIN_AFFIX 的每个前缀和后缀。 */
export function candidatesOf(token) {
  const out = new Set([token]);
  for (let length = MIN_AFFIX; length < token.length; length++) {
    out.add(token.slice(0, length));
    out.add(token.slice(token.length - length));
  }
  return out;
}

function maskIPv4(value) {
  return `${value.split(".")[0]}.*.*.*`;
}

/**
 * 扫描一个文件的内容（纯函数）。返回的每条命中：{ file, line, rule, value, shown }。
 * value 用于和放行清单比对（规则 3 是哈希）；shown 是打印用的打码形式。
 * @param {string} file 仓库相对路径
 * @param {string} text
 * @param {{ denylist: Set<string>, hashCache?: Map<string, string> }} options
 * @returns {Finding[]}
 */
export function scanText(file, text, { denylist, hashCache = new Map() }) {
  /** @type {Finding[]} */
  const findings = [];
  const hashed = (value) => {
    let digest = hashCache.get(value);
    if (digest === undefined) {
      digest = sha256(value);
      hashCache.set(value, digest);
    }
    return digest;
  };
  text.split("\n").forEach((content, index) => {
    const line = index + 1;
    for (const match of content.matchAll(IPV4_RE)) {
      const value = match[0];
      const octets = match.slice(1, 5).map(Number);
      if (octets.some((part) => part > 255)) continue;
      const kind = classifyIPv4(octets);
      if (kind) findings.push({ file, line, rule: kind, value, shown: maskIPv4(value) });
      const digest = hashed(value);
      if (denylist.has(digest)) findings.push({ file, line, rule: "被禁 IPv4（哈希命中）", value: digest, shown: `sha256:${digest.slice(0, 12)}` });
    }
    for (const match of content.matchAll(MESH_HOST_RE)) {
      findings.push({ file, line, rule: "组网主机名（含 .mesh. 段）", value: match[0], shown: "*.mesh.*" });
    }
    const hits = new Set();
    for (const token of tokensOf(content)) {
      for (const candidate of candidatesOf(token)) {
        const digest = hashed(candidate);
        if (denylist.has(digest)) hits.add(digest);
      }
    }
    for (const digest of hits) findings.push({ file, line, rule: "被禁 token（哈希命中）", value: digest, shown: `sha256:${digest.slice(0, 12)}` });
  });
  return findings;
}

/**
 * 扫描一个路径：逐段扫描，同一个目录前缀只报一次。命中记在该前缀上（line 为 0），放行清单按「前缀 + value」生效。
 * @param {string} file 仓库相对路径
 * @param {{ denylist: Set<string>, hashCache?: Map<string, string>, seen?: Set<string> }} options seen 记录已经查过的前缀
 * @returns {Finding[]}
 */
export function scanPath(file, { denylist, hashCache = new Map(), seen = new Set() }) {
  const segments = file.split("/");
  /** @type {Finding[]} */
  const findings = [];
  segments.forEach((segment, index) => {
    const prefix = segments.slice(0, index + 1).join("/");
    if (seen.has(prefix)) return;
    seen.add(prefix);
    for (const finding of scanText(prefix, segment, { denylist, hashCache })) findings.push({ ...finding, line: 0, rule: `路径：${finding.rule}` });
  });
  return findings;
}

/**
 * 打印用的路径：命中任何规则的路径段换成 ***，报告里不回显被禁的目录名或文件名。
 * @param {string} file
 * @param {{ denylist: Set<string>, hashCache?: Map<string, string> }} options
 */
export function maskPath(file, options) {
  return file.split("/").map((segment) => (scanText(file, segment, options).length ? "***" : segment)).join("/");
}

/** 读被禁清单：{ "sha256": ["<64 位小写十六进制>", ...] }，格式不对就失败（不静默放行）。 */
export function loadDenylist(file = DENYLIST_FILE) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  const list = data?.sha256;
  if (!Array.isArray(list) || !list.length) throw new Error(`${file}：需要非空的 "sha256" 数组`);
  const bad = list.filter((item) => typeof item !== "string" || !HEX64.test(item));
  if (bad.length) throw new Error(`${file}：只能放 64 位小写十六进制的 SHA-256，发现 ${bad.length} 条不合规`);
  return new Set(list);
}

/**
 * 读放行清单：[{ path, value, reason }]；文件不存在当作空；字段缺失或理由为空就失败。
 * @param {string} root
 * @returns {AllowEntry[]}
 */
export function loadAllowlist(root) {
  const file = join(root, ALLOW_FILE);
  if (!existsSync(file)) return [];
  const data = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(data)) throw new Error(`${ALLOW_FILE}：必须是数组`);
  data.forEach((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${ALLOW_FILE} 第 ${index + 1} 项：必须是 { path, value, reason } 对象`);
    for (const key of ALLOW_KEYS) {
      if (typeof entry[key] !== "string" || !entry[key].trim()) throw new Error(`${ALLOW_FILE} 第 ${index + 1} 项：缺少 ${key}（放行必须写明路径、原文和理由）`);
    }
    const extra = Object.keys(entry).filter((key) => !ALLOW_KEYS.includes(key));
    if (extra.length) throw new Error(`${ALLOW_FILE} 第 ${index + 1} 项：只能有 path、value、reason 三个字段，多了 ${extra.join("、")}`);
  });
  return data;
}

/**
 * 扫描放行清单自己的 path 与 reason（自由文本，写进组织名、主机名同样是泄漏）；value 不扫。
 * 行号取该字段在原文里第一次出现的行，找不到时记第 1 行。
 * @param {string} raw 放行清单原文
 * @param {AllowEntry[]} allow
 * @param {{ denylist: Set<string>, hashCache?: Map<string, string> }} options
 * @returns {Finding[]}
 */
export function scanAllowlist(raw, allow, options) {
  /** @type {Finding[]} */
  const findings = [];
  let from = 0;
  allow.forEach((entry, index) => {
    for (const key of ["path", "reason"]) {
      const at = raw.indexOf(JSON.stringify(entry[key]), from);
      if (at !== -1) from = at;
      const line = at === -1 ? 1 : raw.slice(0, at).split("\n").length;
      for (const finding of scanText(ALLOW_FILE, entry[key], options)) {
        findings.push({ ...finding, line, rule: `放行清单第 ${index + 1} 项的 ${key}：${finding.rule}` });
      }
    }
  });
  return findings;
}

/**
 * 上游快照里登记过、由 tuffex-docs check 核对哈希的文件（仓库相对路径），只限 reference/ 与 snapshot/ 两个目录。
 * manifest 不存在时返回空集（快照目录照常扫描）；存在但格式不对就失败。
 * @param {string} root
 * @returns {Set<string>}
 */
export function managedSnapshotFiles(root) {
  const file = join(root, TUFFEX_MANIFEST);
  if (!existsSync(file)) return new Set();
  const files = JSON.parse(readFileSync(file, "utf8"))?.files;
  if (!Array.isArray(files) || files.some((item) => typeof item?.path !== "string")) throw new Error(`${TUFFEX_MANIFEST}：files 必须是 [{ path, ... }] 数组`);
  return new Set(files.map((item) => `${TUFFEX_DIR}${item.path}`).filter((path) => SKIPPED_PREFIXES.some((prefix) => path.startsWith(prefix))));
}

/**
 * 用放行清单过滤命中；返回剩下的命中与没用上的放行项。
 * @template {{ file: string, value: string }} T
 * @param {T[]} findings
 * @param {AllowEntry[]} allow
 * @returns {{ findings: T[], unused: AllowEntry[] }}
 */
export function applyAllowlist(findings, allow) {
  const used = new Set();
  const remaining = findings.filter((finding) => {
    const index = allow.findIndex((entry) => entry.path === finding.file && entry.value === finding.value);
    if (index === -1) return true;
    used.add(index);
    return false;
  });
  return { findings: remaining, unused: allow.filter((_, index) => !used.has(index)) };
}

export function listFiles(root) {
  return [
    ...new Set(
      execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
        .split("\0")
        .filter(Boolean),
    ),
  ];
}

/**
 * 扫描整个仓库。denylist、allow 可以注入（测试用）；默认读脚本旁边的被禁清单和 <root> 的放行清单。
 * @param {{ root?: string, denylist?: Set<string>, allow?: AllowEntry[] }} [options]
 * @returns {{ ok: boolean, findings: Finding[], unused: AllowEntry[], checked: number, links: number, files: number }}
 */
export function auditRepository({ root = ROOT, denylist = loadDenylist(), allow = loadAllowlist(root) } = {}) {
  const files = listFiles(root);
  const managed = managedSnapshotFiles(root);
  const hashCache = new Map();
  const seenPrefixes = new Set();
  /** @type {Finding[]} 可以被放行清单放行的命中 */
  const findings = [];
  /** @type {Finding[]} 放行清单自己的命中：不能再被放行 */
  const own = [];
  let checked = 0;
  let links = 0;
  for (const file of files) {
    findings.push(...scanPath(file, { denylist, hashCache, seen: seenPrefixes }));
    const path = resolve(root, file);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      continue; // 已删除但还没提交删除的文件
    }
    if (stat.isSymbolicLink()) {
      links += 1;
      for (const finding of scanText(file, readlinkSync(path), { denylist, hashCache })) findings.push({ ...finding, rule: `符号链接目标：${finding.rule}` });
      continue;
    }
    if (!stat.isFile()) continue; // 子模块：只查路径
    if (managed.has(file)) continue; // 登记过哈希的上游快照：只查路径
    const buffer = readFileSync(path);
    if (buffer.subarray(0, 8192).includes(0)) continue; // 二进制：只查路径
    checked += 1;
    if (file === ALLOW_FILE) own.push(...scanAllowlist(buffer.toString("utf8"), allow, { denylist, hashCache }));
    else findings.push(...scanText(file, buffer.toString("utf8"), { denylist, hashCache }));
  }
  const result = applyAllowlist(findings, allow);
  const remaining = [...result.findings, ...own];
  return { ok: remaining.length === 0 && result.unused.length === 0, findings: remaining, unused: result.unused, checked, links, files: files.length };
}

function main(argv) {
  const { flags, values } = parseFlags(argv, { flags: ["--help", "-h"], values: ["--root", "--hash"] });
  if (flags.has("--help") || flags.has("-h")) {
    console.log(USAGE);
    return;
  }
  if (values["--hash"] !== undefined) {
    if (values["--root"] !== undefined) throw new UsageError("--hash 不能和 --root 一起用");
    const problem = hashTermProblem(values["--hash"]);
    if (problem) throw new UsageError(problem);
    console.log(hashTerm(values["--hash"]));
    return;
  }
  const root = values["--root"] ? resolve(values["--root"]) : ROOT;
  const denylist = loadDenylist();
  const result = auditRepository({ root, denylist });
  if (!result.ok) {
    // 路径本身可能含被禁词：打印前把命中的路径段换成 ***。
    const shownPath = (file) => maskPath(file, { denylist });
    for (const finding of result.findings) console.error(`${shownPath(finding.file)}:${finding.line}: ${finding.rule}：${finding.shown}`);
    for (const entry of result.unused) console.error(`${ALLOW_FILE}：放行项没有命中任何内容，删掉它（${shownPath(entry.path)}）`);
    console.error(`公开安全检查未通过（${result.findings.length} 处命中，${result.unused.length} 条多余的放行项）。改成占位（<owner>、<org>/<repo>、https://geek-bot.example.com、203.0.113.10），确需保留的技术常量才写进放行清单并说明理由。`);
    process.exitCode = 1;
    return;
  }
  console.log(`公开安全检查通过：检查 ${result.files} 个入库或未忽略文件的路径，扫描其中 ${result.checked} 个文本文件的内容与 ${result.links} 个符号链接的目标（登记过哈希的上游快照与二进制只查路径）。`);
}

if (isDirectRun(import.meta.url)) runCli(main, USAGE);
