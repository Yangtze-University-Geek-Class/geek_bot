#!/usr/bin/env node
/**
 * 密钥门禁：仓库里**永远不能出现真实密钥**。
 *
 *   node scripts/check-secrets.mjs [--root <仓库根目录>]
 *
 * 允许入库的模板型 env 文件只有两种：`deploy/env/.env.<环境>`（随 #7 加入）与根 `.env.example`（本机开发用）。
 * 它们只放占位符和通用默认值；密钥一律以 `*_FILE` 指向目标机上的密钥文件，模板里的密钥项只能留空或写文件路径。
 *
 * 硬失败条件：
 *   1. 根 `.env`、`.env.local`、`.env.<环境>.local` 等本地/私有 env 文件进入版本控制（或未被忽略）。
 *   2. 模板 env 里「密钥名 = 非空值」（SECRET / TOKEN / PASSWORD / API_KEY / SETUP_KEY / JOIN_KEY / MASTER_KEY /
 *      ENCRYPTION_KEY / SSH_KEY / PRIVATE_KEY…）；键名以 `_FILE` 结尾时，值只能是文件路径。
 *   3. 任何被扫描文本里出现 sshpass 内联口令、私钥材料、GitHub 令牌形态、OpenAI 兼容密钥形态（`sk-` 开头的长串）。
 *   4. 数据库文件进入版本控制：`.db` / `.sqlite` / `.sqlite3` 及其附属与备份后缀（-journal、-wal、-shm、.bak、.1……；
 *      源码与文档扩展名除外，例如 repo.db.ts），以及任何以 SQLite 文件头开头的文件（改了名的库文件）。
 *      .gitignore 只忽略确切的库文件名；它没列到、又像库文件的名字不会被静默忽略，而是在这里报出来。
 *   5. 私钥文件进入版本控制：`*.pem`、`*.key`、`*.p12`、`*.pfx`、`*.ppk`、`*.jks`、`*.keystore`、`id_rsa`、`id_ed25519` 等，
 *      不看内容，按文件名直接失败。
 *
 * 文件清单取自 `git ls-files --cached --others --exclude-standard`（含还没 add 的新文件，排除被忽略的）；
 * 不按扩展名挑文件：每个普通文件读前 8 KB，没有 NUL 字节就当文本扫描（Dockerfile、.npmrc、.py、没有扩展名的钩子都在内）；
 * 符号链接与子模块只按文件名判定。不读 Git 历史、不联网、不改文件。反例测试见 tests/tooling/secrets.test.ts。
 */

import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun, parseFlags, runCli } from './lib/cli.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** 允许入库的模板 env：deploy/env/.env.<环境> 与根 .env.example。 */
export const TEMPLATE_ENV_RE = /^(?:deploy\/env\/\.env\.[a-z0-9-]+|\.env\.example)$/;
/** 明确禁止入库的私有 env 形态。 */
const FORBIDDEN_ENV_RES = [
  /(?:^|\/)\.env$/,
  /(?:^|\/)\.env\.local$/,
  /(?:^|\/)\.env\.[a-z0-9-]+\.local$/,
];
/** 键名长得像密钥：模板里一旦有非空值即失败（CLIENT_ID 这类公开标识不在列表里）。 */
export const SECRET_KEY_RE = /(?:^|_)(?:SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?|API_KEY|SETUP_KEY|JOIN_KEY|MASTER_KEY|ENCRYPTION_KEY|SSH_KEY|PRIVATE_KEY)(?:_|$)/i;
/** `*_FILE` 的值只能是文件路径（绝对路径或 ./、../ 开头的相对路径，不含空白）。 */
const FILE_REFERENCE_RE = /^(?:\/|\.{1,2}\/)\S*$/;
/** 二进制判定：前 8 KB 里出现 NUL 字节（与 check-public-safety 同一口径）。 */
const BINARY_PROBE_BYTES = 8192;
/** 数据库文件名：.db / .sqlite / .sqlite3 及其附属、备份后缀（-wal、-shm、-journal、.bak、.1……）。 */
const DATABASE_NAME_RE = /\.(?:db|sqlite3?)(?:[-.][A-Za-z0-9]+)*$/i;
/** 源码与文档扩展名：repo.db.ts 这类名字里带 .db. 的源码不按文件名判定（真正的库文件由 SQLite 文件头兜住）。 */
const SOURCE_EXTENSION_RE = /\.(?:[cm]?[jt]sx?|vue|json|md|sql|ya?ml|sh)$/i;
/** SQLite 3 数据库文件头（16 字节）。 */
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1');
/** 私钥与证书密钥库文件名：不看内容，出现就失败。公钥（id_ed25519.pub）不在此列。 */
const PRIVATE_KEY_FILE_RE = /(?:^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?|[^/]+\.(?:pem|key|p12|pfx|ppk|jks|keystore))$/i;
/** OpenAI 兼容密钥：`sk-` 开头的长串，且同时含字母与数字（排除 kebab-case 的普通长名字）。 */
const OPENAI_KEY_RE = /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/g;
const PATTERN_RULES = [
  { name: 'inline SSH password', test: (line) => /sshpass\s+-p\s+(?:'[^']+'|"[^"]+")/.test(line) },
  { name: 'private key material', test: (line) => /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/.test(line) },
  { name: 'GitHub token', test: (line) => /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/.test(line) },
  {
    name: 'OpenAI-compatible API key',
    test: (line) => [...line.matchAll(OPENAI_KEY_RE)].some(([match]) => /[0-9]/.test(match) && /[A-Za-z]/.test(match.slice(3))),
  },
];

const USAGE = [
  '用法：node scripts/check-secrets.mjs [--root <仓库根目录>]',
  '  扫描未被忽略的文件：私有 env、数据库文件、私钥文件不入库；env 模板里的密钥项只能留空或写 *_FILE 路径；',
  '  任何文本文件（不论扩展名）里不出现私钥、GitHub 令牌、sk- 开头的长密钥。',
].join('\n');

/** 逐行解析 KEY=VALUE，返回 [行号, 键, 值]；注释与空行跳过，支持 `export KEY=VALUE`。 */
export function parseAssignments(text) {
  const assignments = [];
  text.split('\n').forEach((line, index) => {
    const trimmed = line.trim().replace(/^export\s+/, '');
    if (!trimmed || trimmed.startsWith('#')) return;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) return;
    const key = trimmed.slice(0, separator).trim();
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) return;
    const raw = trimmed.slice(separator + 1);
    let value = raw.trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    } else {
      // 未加引号的值：前面有空白的 # 起行尾注释（`KEY= # 说明` 的值是空的）；紧贴等号的 `KEY=#abc` 仍然算值。
      value = raw.replace(/\s+#.*$/, '').trim();
    }
    assignments.push({ line: index + 1, key, value });
  });
  return assignments;
}

/**
 * 模板 env 里的一个赋值是否违规；返回问题描述或 null。
 * @param {{ key: string, value: string }} assignment
 */
export function templateViolation({ key, value }) {
  if (!SECRET_KEY_RE.test(key) || !value) return null;
  if (/_FILE$/i.test(key)) {
    return FILE_REFERENCE_RE.test(value) ? null : `${key} 是密钥文件引用，值只能是文件路径（绝对路径或 ./ 开头）`;
  }
  return `${key} 在模板 env 里必须留空，改用 ${key}_FILE 指向目标机上的密钥文件`;
}

/** 扫描一个文件的内容，返回问题描述列表（不回显命中的值）。 */
export function scanText(file, text) {
  const findings = [];
  if (TEMPLATE_ENV_RE.test(file)) {
    for (const assignment of parseAssignments(text)) {
      const problem = templateViolation(assignment);
      if (problem) findings.push(`${file}:${assignment.line}: ${problem} [REDACTED]`);
    }
  }
  text.split('\n').forEach((line, index) => {
    for (const rule of PATTERN_RULES) {
      if (rule.test(line)) findings.push(`${file}:${index + 1}: ${rule.name} [REDACTED]`);
    }
  });
  return findings;
}

/**
 * 判断一个仓库相对路径是否需要报「不该入库」；返回问题描述或 null。
 * @param {string} file
 */
export function fileViolation(file) {
  if (FORBIDDEN_ENV_RES.some((pattern) => pattern.test(file))) {
    return `${file}: 私有 env 文件禁止入库（模板只能是 deploy/env/.env.<环境> 与根 .env.example）`;
  }
  if (/(?:^|\/)\.env(?:\.|$)/.test(file) && !TEMPLATE_ENV_RE.test(file)) {
    return `${file}: 只允许 deploy/env/.env.<环境> 与根 .env.example 这两类模板 env 入库`;
  }
  if (DATABASE_NAME_RE.test(file) && !SOURCE_EXTENSION_RE.test(file)) return `${file}: 数据库文件禁止入库`;
  if (PRIVATE_KEY_FILE_RE.test(file)) return `${file}: 私钥或密钥库文件禁止入库（不论内容）`;
  return null;
}

/**
 * 按文件内容判断：SQLite 文件头 → 数据库文件；前 8 KB 有 NUL → 二进制（不扫）；否则是文本。
 * @param {Buffer} buffer
 * @returns {'database' | 'binary' | 'text'}
 */
export function contentKind(buffer) {
  if (buffer.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)) return 'database';
  return buffer.subarray(0, BINARY_PROBE_BYTES).includes(0) ? 'binary' : 'text';
}

/** 列出仓库里未被忽略的文件（已跟踪 + 未跟踪未忽略）。 */
export function listFiles(repoRoot) {
  return [
    ...new Set(
      execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
        .split('\0')
        .filter(Boolean),
    ),
  ];
}

export function auditRepository({ repoRoot = ROOT } = {}) {
  const files = listFiles(repoRoot);
  const findings = [];
  let checked = 0;
  for (const file of files) {
    const problem = fileViolation(file);
    if (problem) {
      findings.push(problem);
      continue;
    }
    const path = resolve(repoRoot, file);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      continue; // 已删除但还没提交删除的文件
    }
    if (!stat.isFile()) continue; // 符号链接、子模块：只按文件名判定
    const buffer = readFileSync(path);
    const kind = contentKind(buffer);
    if (kind === 'database') {
      findings.push(`${file}: 数据库文件禁止入库（SQLite 文件头）`);
      continue;
    }
    if (kind === 'binary') continue;
    checked += 1;
    findings.push(...scanText(file, buffer.toString('utf8')));
  }
  return { ok: findings.length === 0, findings, checked, files: files.length };
}

function main(argv) {
  const { flags, values } = parseFlags(argv, { flags: ['--help', '-h'], values: ['--root'] });
  if (flags.has('--help') || flags.has('-h')) {
    console.log(USAGE);
    return;
  }
  const result = auditRepository({ repoRoot: values['--root'] ? resolve(values['--root']) : ROOT });
  if (!result.ok) {
    console.error(result.findings.join('\n'));
    console.error(`密钥门禁未通过（${result.findings.length} 项）。`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `密钥门禁通过：扫描 ${result.checked} 个文本文件（共 ${result.files} 个入库或未忽略的文件）；`
      + '模板 env 只允许 deploy/env/.env.<环境> 与根 .env.example，密钥项只能留空或写 *_FILE 路径；二进制文件只按文件名与文件头判定；未读取 Git 历史。',
  );
}

if (isDirectRun(import.meta.url)) runCli(main, USAGE);
