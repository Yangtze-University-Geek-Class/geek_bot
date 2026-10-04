/**
 * 任务包（protocol TaskBundle）的校验与安全解包。
 * 任务包是不可信输入：路径必须是规范的相对路径，不能穿越、不能是绝对路径、不能带反斜杠或控制字符；
 * 不允许 agent 扩展、MCP、规则目录与 .env*（S-04、S-08）。JSON 任务包里没有符号链接这一类型，
 * 解包时每个文件用 O_CREAT|O_EXCL|O_NOFOLLOW 新建，目录逐级 lstat 核对，不跟随任何已有链接。
 */
import { createHash } from "node:crypto";
import { closeSync, constants, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { BundleFile, JsonValue, TaskBundle } from "@geek-bot/protocol";

export const BUNDLE_LIMITS = Object.freeze({
  maxFiles: 20_000,
  maxFileBytes: 32 * 1024 * 1024,
  maxTotalBytes: 400 * 1024 * 1024,
  maxPathLength: 1024,
  maxDiffBytes: 16 * 1024 * 1024,
  maxRules: 200,
  maxRuleBytes: 512 * 1024,
});

/** 任何一级目录名命中即拒绝：agent 扩展、规则与 MCP 配置目录，以及 Git 内部目录。 */
const FORBIDDEN_DIRECTORIES: ReadonlySet<string> = new Set([".omp", ".claude", ".cursor", ".codex", ".gemini", ".agent", ".agents", ".windsurf", ".git", ".pi"]);
/** 文件名命中即拒绝（大小写不敏感）。 */
const FORBIDDEN_BASENAMES: ReadonlySet<string> = new Set(["mcp.json", ".mcp.json", ".cursorrules", ".windsurfrules", ".clinerules", "mcp_config.json"]);

export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleError";
  }
}

/** 规范的相对路径：不空、不以 / 开头、没有空段 . 和 ..、没有反斜杠与控制字符，每段不超过 255 字节。 */
export function isSafeRelativePath(path: string, maxLength = BUNDLE_LIMITS.maxPathLength): boolean {
  if (typeof path !== "string" || path.length === 0 || path.length > maxLength) return false;
  if (path.startsWith("/") || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path)) return false;
  return path.split("/").every(part => part !== "" && part !== "." && part !== ".." && Buffer.byteLength(part) <= 255);
}

/** 路径是否落在禁止的 agent 扩展、MCP 或 env 文件上。 */
export function isForbiddenRepoPath(path: string): boolean {
  const parts = path.toLowerCase().split("/");
  const base = parts[parts.length - 1];
  if (parts.slice(0, -1).some(part => FORBIDDEN_DIRECTORIES.has(part))) return true;
  if (FORBIDDEN_DIRECTORIES.has(base)) return true;
  if (FORBIDDEN_BASENAMES.has(base)) return true;
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (parts.length >= 2 && parts[parts.length - 2] === ".vscode" && base === "mcp.json") return true;
  return false;
}

function isJsonObject(value: unknown): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ValidatedBundle {
  readonly files: ReadonlyMap<string, Buffer>;
  readonly diff: string;
  readonly rules: readonly { readonly path: string; readonly content: string }[];
  readonly meta: { readonly [key: string]: JsonValue };
}

function decodeFile(file: BundleFile): Buffer {
  const { path, content } = file;
  const encoding: string = file.encoding;
  if (encoding === "utf8") return Buffer.from(content, "utf8");
  if (encoding === "base64") {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(content) || content.length % 4 !== 0) throw new BundleError(`文件 ${path} 的 base64 内容不合法`);
    return Buffer.from(content, "base64");
  }
  throw new BundleError(`文件 ${path} 的 encoding 只能是 utf8 或 base64`);
}

/** 核对 sha256 后解析并校验任务包；任何一项不合法都抛 BundleError。 */
export function parseBundle(bytes: Buffer, expectedSha256: string): ValidatedBundle {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (!/^[0-9a-f]{64}$/.test(expectedSha256) || actual !== expectedSha256) throw new BundleError("任务包 sha256 与任务声明不符");
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new BundleError("任务包不是合法的 JSON");
  }
  if (!isJsonObject(raw)) throw new BundleError("任务包顶层必须是对象");
  const allowedKeys: Record<string, true> = { files: true, diff: true, rules: true, meta: true };
  for (const key of Object.keys(raw)) if (!allowedKeys[key]) throw new BundleError(`任务包里有不认识的字段 ${key}`);
  const bundle = raw;
  if (!Array.isArray(bundle.files)) throw new BundleError("任务包缺少 files 数组");
  if (typeof bundle.diff !== "string") throw new BundleError("任务包的 diff 必须是字符串");
  if (Buffer.byteLength(bundle.diff) > BUNDLE_LIMITS.maxDiffBytes) throw new BundleError("任务包的 diff 超过上限");
  if (!Array.isArray(bundle.rules) || bundle.rules.length > BUNDLE_LIMITS.maxRules) throw new BundleError("任务包的 rules 必须是不超过上限的数组");
  if (!isJsonObject(bundle.meta)) throw new BundleError("任务包的 meta 必须是对象");
  if (bundle.files.length > BUNDLE_LIMITS.maxFiles) throw new BundleError("任务包里的文件数超过上限");

  const files = new Map<string, Buffer>();
  const lowered = new Set<string>();
  const directories = new Set<string>();
  let total = 0;
  for (const file of bundle.files) {
    if (!isJsonObject(file) || typeof file.path !== "string" || typeof file.content !== "string") throw new BundleError("任务包里的文件项不合法");
    if (!isSafeRelativePath(file.path)) throw new BundleError(`任务包里的路径不合法：${JSON.stringify(file.path).slice(0, 200)}`);
    if (isForbiddenRepoPath(file.path)) throw new BundleError(`任务包里有禁止的路径：${file.path}`);
    const key = file.path.toLowerCase();
    if (lowered.has(key)) throw new BundleError(`任务包里有重复路径（大小写不敏感）：${file.path}`);
    lowered.add(key);
    if (file.encoding !== "utf8" && file.encoding !== "base64") throw new BundleError(`文件 ${file.path} 的 encoding 只能是 utf8 或 base64`);
    const validatedFile: BundleFile = { path: file.path, content: file.content, encoding: file.encoding };
    const data = decodeFile(validatedFile);
    if (data.length > BUNDLE_LIMITS.maxFileBytes) throw new BundleError(`文件 ${file.path} 超过单个文件上限`);
    total += data.length;
    if (total > BUNDLE_LIMITS.maxTotalBytes) throw new BundleError("任务包解开后的总大小超过上限");
    const parts = key.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) directories.add(parts.slice(0, depth).join("/"));
    files.set(file.path, data);
  }
  for (const key of lowered) if (directories.has(key)) throw new BundleError(`任务包里的文件与目录同名：${key}`);

  const rules: { path: string; content: string }[] = [];
  for (const rule of bundle.rules) {
    if (!isJsonObject(rule) || typeof rule.path !== "string" || typeof rule.content !== "string") throw new BundleError("任务包里的规则项不合法");
    if (!isSafeRelativePath(rule.path)) throw new BundleError(`规则路径不合法：${JSON.stringify(rule.path).slice(0, 200)}`);
    if (Buffer.byteLength(rule.content) > BUNDLE_LIMITS.maxRuleBytes) throw new BundleError(`规则 ${rule.path} 超过上限`);
    rules.push({ path: rule.path, content: rule.content });
  }
  return { files, diff: bundle.diff, rules, meta: bundle.meta };
}

function ensureDirectory(path: string): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new BundleError(`解包目标 ${path} 已存在且不是目录`);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    mkdirSync(path, { mode: 0o755 });
  }
}

/** 解包到一个空目录：逐级建目录，文件用 O_EXCL|O_NOFOLLOW 新建。root 必须已存在且为空。 */
export function extractBundleFiles(files: ReadonlyMap<string, Buffer>, root: string): void {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  for (const [path, data] of files) {
    const parts = path.split("/");
    let current = root;
    for (const part of parts.slice(0, -1)) {
      current = join(current, part);
      ensureDirectory(current);
    }
    const fd = openSync(join(current, parts[parts.length - 1]), flags, 0o644);
    try {
      let done = 0;
      while (done < data.length) done += writeSync(fd, data, done, data.length - done);
    } finally {
      closeSync(fd);
    }
  }
}
