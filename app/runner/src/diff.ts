/**
 * fix/rework 的补丁由 runner 根据「任务包原文件」与「omp 运行后的工作目录」生成，格式与 `git diff` 相同
 * （a/ b/ 前缀、new file / deleted file、@@ 块、三行上下文），publisher 可以直接 `git apply`。
 * 规则：
 *   - 只比较普通文件；工作目录里出现符号链接、设备等其它类型时拒绝（不让补丁携带链接）；
 *   - 二进制改动（含 NUL 或不是合法 UTF-8）拒绝；
 *   - 新增文件若落在依赖与构建产物目录（node_modules 等）或命中仓库根 .gitignore 的简单规则，视为本地产物跳过；
 *     已在任务包里的文件不受忽略规则影响；
 *   - 新增或修改 agent 扩展、MCP、.env* 等禁止路径时拒绝。
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isForbiddenRepoPath, isSafeRelativePath } from "./bundle.js";

export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchError";
  }
}

const ARTIFACT_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules", ".pnpm-store", ".npm", ".yarn", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache",
  ".gradle", ".m2", ".cache", ".turbo", ".next", ".nuxt", ".parcel-cache", "coverage", "target",
]);
const CONTEXT = 3;
/** 编辑距离上限：回溯要保存每一步的 V 数组，上限决定最坏内存（约 4·上限² 字节）。 */
const MAX_EDIT_DISTANCE = 2_000;
/** 文本里不会出现 NUL（二进制已拒绝）：用它标记「最后一行没有换行」，让换行差异参与比较。 */
const NO_NEWLINE = "\u0000";

interface IgnoreRule {
  readonly regex: RegExp;
  readonly directoryOnly: boolean;
  readonly anchored: boolean;
}

/** 把 .gitignore 的一行转成规则；只支持 *、**、?、前导 /、结尾 /，不支持取反（取反行忽略）。 */
function compileIgnoreLine(line: string): IgnoreRule | null {
  const text = line.trim();
  if (text === "" || text.startsWith("#") || text.startsWith("!")) return null;
  const directoryOnly = text.endsWith("/");
  const body = text.replace(/\/+$/, "");
  const anchored = body.startsWith("/") || body.includes("/");
  const pattern = body.replace(/^\//, "");
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
      if (pattern[index + 1] === "/") index += 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return { regex: new RegExp(`^${source}$`), directoryOnly, anchored };
}

function isIgnored(path: string, isDirectory: boolean, rules: readonly IgnoreRule[]): boolean {
  const parts = path.split("/");
  if (parts.some(part => ARTIFACT_DIRECTORIES.has(part))) return true;
  for (const rule of rules) {
    if (rule.directoryOnly && !isDirectory) continue;
    if (rule.anchored ? rule.regex.test(path) : rule.regex.test(parts[parts.length - 1])) return true;
  }
  return false;
}

/** 列出工作目录里的普通文件（相对路径）；新增的忽略目录不进入。 */
function walk(root: string, original: ReadonlyMap<string, Buffer>, rules: readonly IgnoreRule[]): string[] {
  const originalDirectories = new Set<string>();
  for (const path of original.keys()) {
    const parts = path.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) originalDirectories.add(parts.slice(0, depth).join("/"));
  }
  const files: string[] = [];
  const visit = (relative: string): void => {
    for (const name of readdirSync(relative ? join(root, relative) : root)) {
      const path = relative ? `${relative}/${name}` : name;
      const stat = lstatSync(join(root, path));
      if (stat.isDirectory()) {
        if (!originalDirectories.has(path) && isIgnored(path, true, rules)) continue;
        visit(path);
      } else if (stat.isFile()) {
        if (!original.has(path) && isIgnored(path, false, rules)) continue;
        files.push(path);
      } else {
        if (!original.has(path) && isIgnored(path, false, rules)) continue;
        throw new PatchError(`工作目录里出现了不是普通文件的路径：${path}`);
      }
    }
  };
  visit("");
  return files;
}

function decodeText(data: Buffer, path: string): string {
  if (data.includes(0)) throw new PatchError(`补丁不能包含二进制文件：${path}`);
  const text = data.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(data)) throw new PatchError(`补丁不能包含非 UTF-8 文件：${path}`);
  return text;
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

type Op = { readonly type: "equal" | "delete" | "insert"; readonly line: string };

/** Myers O((N+M)D) 最短编辑脚本；编辑距离超过上限时退化为整段删除加整段插入。 */
function diffLines(a: readonly string[], b: readonly string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found === -1; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found === -1) return [...a.map(line => ({ type: "delete" as const, line })), ...b.map(line => ({ type: "insert" as const, line }))];
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d -= 1) {
    const prev = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = prev[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ type: "equal", line: a[x - 1] });
      x -= 1;
      y -= 1;
    }
    if (x === prevX) {
      ops.push({ type: "insert", line: b[y - 1] });
      y -= 1;
    } else {
      ops.push({ type: "delete", line: a[x - 1] });
      x -= 1;
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ type: "equal", line: a[x - 1] });
    x -= 1;
    y -= 1;
  }
  return ops.reverse();
}

function hunks(oldText: string, newText: string): string {
  const oldEndsWithNewline = oldText === "" || oldText.endsWith("\n");
  const newEndsWithNewline = newText === "" || newText.endsWith("\n");
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (!oldEndsWithNewline) a[a.length - 1] += NO_NEWLINE;
  if (!newEndsWithNewline) b[b.length - 1] += NO_NEWLINE;
  const ops = diffLines(a, b);
  const out: string[] = [];
  let index = 0;
  let oldLine = 1;
  let newLine = 1;
  while (index < ops.length) {
    if (ops[index].type === "equal") {
      index += 1;
      oldLine += 1;
      newLine += 1;
      continue;
    }
    // 找到一个改动块：向前取 CONTEXT 行，向后合并间隔不超过 2*CONTEXT 行的改动。
    const startIndex = Math.max(0, index - CONTEXT);
    const lead = index - startIndex;
    let endIndex = index;
    let gap = 0;
    for (let cursor = index; cursor < ops.length; cursor += 1) {
      if (ops[cursor].type === "equal") {
        gap += 1;
        if (gap > 2 * CONTEXT) break;
      } else {
        gap = 0;
        endIndex = cursor;
      }
    }
    const stopIndex = Math.min(ops.length, endIndex + 1 + CONTEXT);
    const hunkOldStart = oldLine - lead;
    const hunkNewStart = newLine - lead;
    let oldCount = 0;
    let newCount = 0;
    const body: string[] = [];
    for (let cursor = startIndex; cursor < stopIndex; cursor += 1) {
      const op = ops[cursor];
      const marker = op.type === "equal" ? " " : op.type === "delete" ? "-" : "+";
      if (op.type !== "insert") oldCount += 1;
      if (op.type !== "delete") newCount += 1;
      if (op.line.endsWith(NO_NEWLINE)) body.push(`${marker}${op.line.slice(0, -1)}`, "\\ No newline at end of file");
      else body.push(`${marker}${op.line}`);
    }
    const oldRange = oldCount === 0 ? `${hunkOldStart - 1},0` : oldCount === 1 ? `${hunkOldStart}` : `${hunkOldStart},${oldCount}`;
    const newRange = newCount === 0 ? `${hunkNewStart - 1},0` : newCount === 1 ? `${hunkNewStart}` : `${hunkNewStart},${newCount}`;
    out.push(`@@ -${oldRange} +${newRange} @@`, ...body);
    for (let cursor = index; cursor < stopIndex; cursor += 1) {
      if (ops[cursor].type !== "insert") oldLine += 1;
      if (ops[cursor].type !== "delete") newLine += 1;
    }
    index = stopIndex;
  }
  return out.join("\n");
}

/** 生成整个工作目录相对任务包的补丁；没有改动时返回空串。 */
export function buildWorkspacePatch(root: string, original: ReadonlyMap<string, Buffer>): string {
  let gitignore = "";
  const originalIgnore = original.get(".gitignore");
  if (originalIgnore) gitignore = originalIgnore.toString("utf8");
  const rules = gitignore.split("\n").map(compileIgnoreLine).filter((rule): rule is IgnoreRule => rule !== null);
  const current = walk(root, original, rules);
  const currentSet = new Set(current);
  const paths = [...new Set([...original.keys(), ...current])].sort();
  const sections: string[] = [];
  for (const path of paths) {
    const before = original.get(path);
    const after = currentSet.has(path) ? readFileSync(join(root, path)) : undefined;
    if (before && after && before.equals(after)) continue;
    if (!isSafeRelativePath(path) || isForbiddenRepoPath(path)) throw new PatchError(`补丁不能改动禁止的路径：${path}`);
    const oldText = before ? decodeText(before, path) : "";
    const newText = after ? decodeText(after, path) : "";
    const header = [`diff --git a/${path} b/${path}`];
    if (!before) header.push("new file mode 100644", "--- /dev/null", `+++ b/${path}`);
    else if (!after) header.push("deleted file mode 100644", `--- a/${path}`, "+++ /dev/null");
    else header.push(`--- a/${path}`, `+++ b/${path}`);
    const body = hunks(oldText, newText);
    if (body === "" && before && after) continue;
    sections.push(body === "" ? header.join("\n") : `${header.join("\n")}\n${body}`);
  }
  return sections.length === 0 ? "" : `${sections.join("\n")}\n`;
}
