import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectionRecord, ProjectRecord, TaskRecord } from "@geek-bot/protocol";
import { ConnectorError } from "../connectors/types.js";

const FORBIDDEN_SEGMENTS: Record<string, true> = { ".github": true, ".gitlab": true, ".git": true, ".omp": true, ".claude": true, ".cursor": true, ".githooks": true, "secrets": true, "migrations": true, "deploy": true };
export function protectedPatchPath(path: string): boolean {
  const lower = path.toLowerCase();
  const parts = lower.split("/");
  const name = parts.at(-1) ?? "";
  return !path || path.startsWith("/") || path.includes("\\") || path.includes("\0") || parts.some(part => !part || part === "." || part === ".." || FORBIDDEN_SEGMENTS[part])
    || name.startsWith(".env") || name.endsWith(".pem") || name.endsWith(".key") || name === ".gitmodules" || name === "codeowners" || name === "mcp.json"
    || name === ".gitlab-ci.yml" || name.startsWith("dockerfile") || /compose.*\.ya?ml$/.test(name);
}
export interface PatchSummary { readonly paths: readonly string[]; readonly changed_lines: number }
function gitEnvironment(home: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: home, LANG: "C.UTF-8", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_LFS_SKIP_SMUDGE: "1" };
}
function executeGit(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, input?: string): string {
  try { return execFileSync("git", [...args], { cwd, env, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }); }
  catch { throw new ConnectorError("git_publication_failed", "受控 Git 操作失败；未执行仓库脚本，请检查项目权限和分支状态", 409); }
}
function executeGitAsync(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, input?: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const child = execFile("git", [...args], { cwd, env, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
    if (error) reject(new ConnectorError("git_publication_failed", "受控 Git 操作失败；请检查项目权限和分支状态", 409));
    else resolve(stdout);
  });
  child.stdin?.end(input);
  return promise;
}
export function inspectPatch(patch: string, maximumFiles = 10, maximumLines = 200): PatchSummary {
  if (!patch.trim() || Buffer.byteLength(patch, "utf8") > 1024 * 1024 || patch.includes("GIT binary patch") || patch.includes("Binary files ") || patch.includes("\0")) throw new ConnectorError("patch_rejected", "补丁为空、包含二进制内容或超过允许大小", 422);
  const temporary = mkdtempSync(join(tmpdir(), "geek-bot-patch-check-"));
  try {
    const env = gitEnvironment(temporary);
    const stat = executeGit(["apply", "--numstat", "-z", "-"], temporary, env, patch);
    const metadata = executeGit(["apply", "--summary", "-"], temporary, env, patch);
    if (/120000|160000|rename|copy/i.test(metadata)) throw new ConnectorError("patch_rejected", "修复补丁不能包含符号链接、子模块、重命名或复制", 422);
    const paths: string[] = [];
    let changedLines = 0;
    for (const row of stat.split("\0")) {
      if (!row) continue;
      const match = /^([0-9]+)\t([0-9]+)\t([\s\S]+)$/.exec(row);
      if (!match || protectedPatchPath(match[3])) throw new ConnectorError("patch_path_rejected", "补丁涉及不允许修改的路径", 422);
      paths.push(match[3]);
      changedLines += Number(match[1]) + Number(match[2]);
    }
    if (paths.length === 0 || paths.length > maximumFiles || changedLines > maximumLines) throw new ConnectorError("patch_too_large", "补丁超过小改动的文件数或行数限制", 422);
    return { paths, changed_lines: changedLines };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

export interface GitPushOptions {
  readonly task: TaskRecord;
  readonly project: ProjectRecord;
  readonly connection: ConnectionRecord;
  readonly token: string;
  readonly branch: string;
  readonly patch: string;
  readonly expectedHead?: string;
  readonly assertAllowed?: () => void;
}
export function repositoryGitUrl(connection: ConnectionRecord, project: ProjectRecord): string {
  const api = new URL(connection.base_url);
  const web = new URL(api);
  if (connection.provider === "github" && api.hostname === "api.github.com") { web.hostname = "github.com"; web.pathname = "/"; }
  else web.pathname = web.pathname.replace(/\/?api\/v[34]\/?$/, "/");
  const source = new URL(project.url);
  if (!["https:", "http:"].includes(source.protocol) || source.origin !== web.origin || source.username || source.password || source.search || source.hash || !source.pathname.startsWith(web.pathname.replace(/\/+$/, "") + "/")) throw new ConnectorError("publish_target_rejected", "项目 Git 地址不在配置的渠道范围内", 422);
  const expected = new URL(project.path.split("/").map(encodeURIComponent).join("/"), web.href.replace(/\/?$/, "/"));
  if (decodeURIComponent(source.pathname.replace(/\/+$/, "")) !== decodeURIComponent(expected.pathname.replace(/\/+$/, ""))) throw new ConnectorError("publish_target_rejected", "项目路径与渠道地址不一致", 422);
  source.pathname = source.pathname.replace(/\/+$/, "") + ".git";
  return source.href;
}
export interface GitPushResult { readonly branch: string; readonly commit: string }
export async function pushPatch(options: GitPushOptions): Promise<GitPushResult> {
  const { task, project, connection, branch, patch } = options;
  if (!/^geek_bot\/[a-z0-9_]{1,120}$/.test(branch) || branch === project.default_branch || ["main", "stage"].includes(branch)) throw new ConnectorError("branch_rejected", "只能更新本任务的机器人分支", 422);
  const base = options.expectedHead ?? task.base_sha;
  if (!base || !/^[0-9a-f]{40,64}$/.test(base)) throw new ConnectorError("task_snapshot_missing", "任务没有固定的基准提交", 409);
  inspectPatch(patch);
  const work = mkdtempSync(join(tmpdir(), "geek-bot-publish-"));
  try {
    const url = repositoryGitUrl(connection, project);
    const env = gitEnvironment(work);
    const auth = Buffer.from(`${connection.provider === "gitlab" ? "oauth2" : "x-access-token"}:${options.token}`, "utf8").toString("base64");
    const settings: Readonly<Record<string, string>> = {
      "core.hooksPath": "/dev/null", "core.quotePath": "false", "credential.helper": "", "push.followTags": "false", "http.followRedirects": "false",
      "protocol.allow": "never", "protocol.https.allow": "always", "protocol.http.allow": "always", [`http.${url}.extraHeader`]: `Authorization: Basic ${auth}`,
    };
    let index = 0;
    for (const [key, value] of Object.entries(settings)) { env[`GIT_CONFIG_KEY_${index}`] = key; env[`GIT_CONFIG_VALUE_${index}`] = value; index++; }
    env.GIT_CONFIG_COUNT = String(index);
    const git = (args: readonly string[], input?: string) => executeGitAsync(args, work, env, input);
    await git(["init", "--template=", "--initial-branch=geek_bot_staging", "."]);
    const targetRef = `refs/heads/${branch}`;
    const beforeBranch = (await git(["ls-remote", "--heads", url, targetRef])).trim();
    if (options.expectedHead) {
      if (!beforeBranch.startsWith(options.expectedHead + "\t")) throw new ConnectorError("branch_changed", "机器人分支已有新的提交，拒绝覆盖", 409);
    } else if (beforeBranch) throw new ConnectorError("branch_taken", "本任务的机器人分支已存在，先核对未知写入结果", 409);
    const protectedRef = `refs/heads/${project.default_branch}`;
    const beforeDefault = (await git(["ls-remote", "--heads", url, protectedRef])).trim();
    if (!options.expectedHead && !beforeDefault.startsWith(base + "\t")) throw new ConnectorError("base_changed", "默认分支已变化，需要重新生成补丁", 409);
    const beforeTags = (await git(["ls-remote", "--tags", url])).split("\n").filter(Boolean).sort().join("\n");
    await git(["fetch", "--no-tags", "--depth=1", url, base]);
    await git(["checkout", "--detach", base]);
    await git(["apply", "--index", "--whitespace=nowarn", "-"], patch);
    const changedPaths = (await git(["diff", "--cached", "--name-only", "-z"])).split("\0").filter(Boolean);
    for (const path of changedPaths) if (protectedPatchPath(path)) throw new ConnectorError("patch_path_rejected", "提交包含禁止修改的路径", 422);
    for (const path of changedPaths) {
      if (!path) continue;
      try {
        const file = join(work, path);
        if (statSync(file).isFile() && readFileSync(file, "utf8").startsWith("version https://git-lfs.github.com/spec/v1")) throw new ConnectorError("patch_lfs_rejected", "补丁不能引入 LFS 指针", 422);
      } catch (error) { if (error instanceof ConnectorError) throw error; }
    }
    const login = connection.account_name ?? "geek_bot";
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(login)) throw new ConnectorError("publish_identity_invalid", "机器人账号标识不合法", 422);
    env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = login;
    env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = `${login}@users.noreply.${connection.provider === "github" ? "github.com" : "gitlab.com"}`;
    await git(["commit", "-m", `fix: ${task.result?.summary.slice(0, 120).replace(/[\r\n]/g, " ") ?? "机器人修复"}\n\ngeek-bot task ${task.id}`]);
    const commit = (await git(["rev-parse", "HEAD"])).trim();
    await git(["merge-base", "--is-ancestor", base, commit]);
    options.assertAllowed?.();
    const result = await git(["push", "--porcelain", "--no-follow-tags", `--force-with-lease=${targetRef}:${options.expectedHead ?? ""}`, url, `HEAD:${targetRef}`]);
    const updates = result.split("\n").filter(line => /^[* =+]\t/.test(line));
    if (updates.length !== 1 || updates[0].split("\t")[1]?.split(":").at(-1) !== targetRef) throw new ConnectorError("push_scope_unknown", "推送结果无法确认仅更新机器人分支", 409);
    const afterDefault = (await git(["ls-remote", "--heads", url, protectedRef])).trim();
    const afterTags = (await git(["ls-remote", "--tags", url])).split("\n").filter(Boolean).sort().join("\n");
    if (afterDefault !== beforeDefault || afterTags !== beforeTags) throw new ConnectorError("protected_refs_changed", "主干或 tag 在发布期间变化，结果需要人工核对", 409);
    return { branch, commit };
  } finally { rmSync(work, { recursive: true, force: true }); }
}
