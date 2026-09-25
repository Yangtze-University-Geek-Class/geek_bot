#!/usr/bin/env node
// 仓库标签的 dry-run：读 .github/labels.yml，打印创建或更新标签的 gh 命令，只打印、不执行、不联网。
//
//   node scripts/labels.mjs [--repo <owner>/<repo>] [--root <dir>]
//
// 输出每行一条 `gh label create <name> --color <c> --description <d> --force [--repo <owner>/<repo>]`，
// 由仓库所有者确认后执行（--force 会把已存在的同名标签改成这里声明的颜色与说明）。
// 不给 --repo 时，gh 在仓库目录里执行会自动解析当前仓库，所以仓库地址不写死。
//
// labels.yml 只支持这个文件用到的 YAML 子集，自己解析、不加依赖：
//   顶层是列表；每项以 `- key: "value"` 开头，后续键缩进对齐；只有 name、color、description 三个键；
//   值一律用双引号（只认 \" 与 \\ 两种转义）；整行注释用 #。其它写法一律报错并给出行号。
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectRun } from "./lib/cli.mjs";

export const LABELS_FILE = ".github/labels.yml";
const KEYS = ["name", "color", "description"];
/** GitHub 的限制：标签名最多 50 个字符，说明最多 100 个字符，颜色是不带 # 的 6 位十六进制 */
const NAME_MAX = 50;
const DESCRIPTION_MAX = 100;
const COLOR_RE = /^[0-9a-fA-F]{6}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const USAGE = "用法：node scripts/labels.mjs [--repo <owner>/<repo>] [--root <dir>]";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 解析双引号值；返回 { value, rest }，rest 是右引号之后的剩余文本 */
function parseQuoted(text, lineNo) {
  if (!text.startsWith('"')) throw new Error(`labels.yml 第 ${lineNo} 行：值要用双引号括起来，例如 name: "P0"。`);
  let value = "";
  for (let i = 1; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\") {
      const next = text[i + 1];
      if (next !== '"' && next !== "\\") throw new Error(`labels.yml 第 ${lineNo} 行：双引号里只支持 \\" 与 \\\\ 两种转义。`);
      value += next;
      i += 1;
      continue;
    }
    if (ch === '"') return { value, rest: text.slice(i + 1) };
    value += ch;
  }
  throw new Error(`labels.yml 第 ${lineNo} 行：缺少右双引号。`);
}

/** 解析 `key: "value"` 一对 */
function parsePair(text, lineNo) {
  const match = /^([a-z]+):[ \t]+(.*)$/.exec(text);
  if (!match) throw new Error(`labels.yml 第 ${lineNo} 行：看不懂「${text}」，只支持 key: "value"。`);
  const [, key, raw] = match;
  if (!KEYS.includes(key)) throw new Error(`labels.yml 第 ${lineNo} 行：不认识的键 ${key}，只允许 ${KEYS.join("、")}。`);
  const { value, rest } = parseQuoted(raw, lineNo);
  if (rest.trim() && !/^[ \t]+#/.test(rest)) throw new Error(`labels.yml 第 ${lineNo} 行：右引号之后只能跟注释。`);
  return { key, value };
}

/**
 * 解析 labels.yml 文本，返回 [{ name, color, description }]（color 统一成小写）。
 * 语法或取值不合规时抛出中文错误，写明行号或标签名。
 * @param {string} text
 */
export function parseLabels(text) {
  const items = [];
  let current = null;
  let indent = 0;
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  lines.forEach((line, index) => {
    const lineNo = index + 1;
    if (!line.trim() || /^[ \t]*#/.test(line)) return;
    if (line.includes("\t")) throw new Error(`labels.yml 第 ${lineNo} 行：不要用制表符缩进。`);
    const item = /^-( +)(.*)$/.exec(line);
    let pair;
    if (item) {
      indent = 1 + item[1].length;
      pair = parsePair(item[2], lineNo);
      current = { line: lineNo, fields: {} };
      items.push(current);
    } else {
      const lead = /^( *)/.exec(line)[1].length;
      if (current === null || lead !== indent) throw new Error(`labels.yml 第 ${lineNo} 行：缩进不对，续行要与上一行「- 」之后的键对齐。`);
      pair = parsePair(line.slice(lead), lineNo);
    }
    if (Object.hasOwn(current.fields, pair.key)) throw new Error(`labels.yml 第 ${lineNo} 行：同一个标签里 ${pair.key} 写了两次。`);
    current.fields[pair.key] = pair.value;
  });

  const seen = new Map();
  return items.map(({ line, fields }) => {
    for (const key of KEYS) {
      if (!Object.hasOwn(fields, key)) throw new Error(`labels.yml 第 ${line} 行开始的标签缺少 ${key}。`);
    }
    const { name, color, description } = fields;
    if (!name.trim() || name !== name.trim()) throw new Error(`labels.yml 第 ${line} 行：标签名不能为空，也不能有首尾空白。`);
    if ([...name].length > NAME_MAX) throw new Error(`标签 ${name}：名字超过 ${NAME_MAX} 个字符。`);
    if (!COLOR_RE.test(color)) throw new Error(`标签 ${name}：color 要是不带 # 的 6 位十六进制，现在是「${color}」。`);
    if ([...description].length > DESCRIPTION_MAX) throw new Error(`标签 ${name}：description 超过 ${DESCRIPTION_MAX} 个字符（GitHub 的上限）。`);
    // GitHub 的标签名不区分大小写
    const folded = name.toLowerCase();
    if (seen.has(folded)) throw new Error(`标签 ${name} 重复声明（第 ${seen.get(folded)} 行与第 ${line} 行）。`);
    seen.set(folded, line);
    return { name, color: color.toLowerCase(), description };
  });
}

/** POSIX shell 引号：安全字符原样输出，其余用单引号括起来 */
export function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/**
 * 把标签声明变成 gh 命令（只生成字符串，不执行）。
 * @param {{ name: string, color: string, description: string }[]} labels
 * @param {{ repo?: string }} [options]
 */
export function labelCommands(labels, { repo } = {}) {
  if (repo !== undefined && !REPO_RE.test(repo)) throw new Error(`--repo 要写成 <owner>/<repo>，现在是「${repo}」。`);
  return labels.map(({ name, color, description }) => {
    const parts = ["gh", "label", "create", shellQuote(name), "--color", color, "--description", shellQuote(description), "--force"];
    if (repo !== undefined) parts.push("--repo", repo);
    return parts.join(" ");
  });
}

/** 读仓库根目录下的 .github/labels.yml */
export function readLabels(root = defaultRoot) {
  return parseLabels(readFileSync(join(root, LABELS_FILE), "utf8"));
}

/** 解析命令行参数；不认识的参数返回 { error } */
export function parseArgs(argv) {
  const options = { root: defaultRoot, repo: undefined, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--repo" || arg === "--root") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) return { error: `${arg} 后面缺少取值。` };
      if (arg === "--repo") {
        if (!REPO_RE.test(value)) return { error: `--repo 要写成 <owner>/<repo>，现在是「${value}」。` };
        options.repo = value;
      } else options.root = resolve(value);
      i += 1;
    } else return { error: `不认识的参数：${arg}` };
  }
  return { options };
}

export function main(argv = process.argv.slice(2)) {
  const { options, error } = parseArgs(argv);
  if (error) {
    console.error(`${error}\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  let labels;
  try {
    labels = readLabels(options.root);
  } catch (err) {
    console.error(err.message);
    return 1;
  }
  for (const command of labelCommands(labels, { repo: options.repo })) console.log(command);
  console.error(`以上 ${labels.length} 条命令只打印、未执行（来源 ${LABELS_FILE}）。确认后由仓库所有者执行；--force 会覆盖同名标签的颜色与说明。`);
  return 0;
}

if (isDirectRun(import.meta.url)) process.exitCode = main();
