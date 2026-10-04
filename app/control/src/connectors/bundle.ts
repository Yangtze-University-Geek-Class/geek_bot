import type { BundleFile, JsonValue, TaskBundle } from "@geek-bot/protocol";
import { ConnectorError } from "./types.js";

export const MAX_BUNDLE_FILES = 10000;
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** 所有执行器共用的输入边界；不把仓库里的代理扩展、git配置或env带进执行环境。 */
export function permittedSnapshotPath(path: string): boolean {
  if (!path || path.length > 1024 || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  const parts = path.split("/");
  if (parts.some(part => !part || part === "." || part === "..")) return false;
  return !parts.some(part => part === ".git" || part === ".omp" || part === ".claude" || part === ".cursor" || part === "mcp.json" || part.startsWith(".env"));
}
export function isRulePath(path: string): boolean {
  const name = path.split("/").at(-1) ?? "";
  return /^(?:AGENTS|CLAUDE|CONTRIBUTING|CODE-REVIEW|PULL-REQUESTS|ISSUES|COMMITS|BRANCHING|TRACKING)(?:\.[^/]*)?$/.test(name)
    || path === ".github/geek-bot.yml" || path === ".geek-bot.json"
    || path.startsWith(".github/ISSUE_TEMPLATE/") || path.startsWith(".github/PULL_REQUEST_TEMPLATE/")
    || path === ".github/pull_request_template.md" || path.startsWith(".gitlab/merge_request_templates/");
}
export function makeTaskBundle(headFiles: readonly BundleFile[], baseFiles: readonly BundleFile[], diff: string, meta: Readonly<Record<string, JsonValue>>): TaskBundle {
  const files = new Map<string, BundleFile>();
  let bytes = 0;
  for (const file of headFiles) if (permittedSnapshotPath(file.path)) files.set(file.path, file);
  // PR/MR head 上的规则删除和改动都不能成为实际执行时的规则。
  for (const [path] of files) if (isRulePath(path)) files.delete(path);
  const rules: { path: string; content: string }[] = [];
  let ruleBytes = 0;
  for (const file of baseFiles) {
    if (!permittedSnapshotPath(file.path) || !isRulePath(file.path)) continue;
    const raw = Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8");
    if (raw.byteLength > 64 * 1024 || ruleBytes + raw.byteLength > 256 * 1024) throw new ConnectorError("rules_too_large", "仓库规范超过任务输入的允许大小", 422);
    ruleBytes += raw.byteLength;
    files.set(file.path, file);
    rules.push({ path: file.path, content: raw.toString("utf8") });
  }
  if (files.size > MAX_BUNDLE_FILES) throw new ConnectorError("bundle_too_large", "仓库文件数超过任务输入的允许上限", 422);
  for (const file of files.values()) {
    const length = file.encoding === "base64" ? Buffer.byteLength(file.content, "base64") : Buffer.byteLength(file.content, "utf8");
    if (length > MAX_FILE_BYTES) throw new ConnectorError("bundle_too_large", "仓库中有文件超过任务输入的允许大小", 422);
    bytes += length;
    if (bytes > MAX_BUNDLE_BYTES) throw new ConnectorError("bundle_too_large", "仓库快照超过任务输入的允许大小", 422);
  }
  if (Buffer.byteLength(diff, "utf8") > 8 * 1024 * 1024) throw new ConnectorError("diff_too_large", "变更 diff 超过审查任务允许大小", 422);
  return { files: [...files.values()], diff, rules, meta };
}
