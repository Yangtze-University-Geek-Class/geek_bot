/**
 * 执行一个任务：核对并解开任务包 → 起回环模型转发器 → 按模型池顺序逐个尝试 omp → 抽取并校验结果。
 * 外层降级（docs/services/runner）：一次尝试以 429（预算用尽除外）、5xx、408、连接失败、输出被截断或缺少终止事件结束时，
 * 用干净的工作目录换池里的下一个模型从头重跑；上下文溢出、鉴权与请求错误、取消、超时不降级。
 * 每次尝试前重新解包并重建 HOME，上一次尝试留下的改动和配置不会带到下一次。
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lchownSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Executor, ModelPoolEntry, TaskKind, TaskResult } from "@geek-bot/protocol";
import { BundleError, extractBundleFiles, parseBundle } from "./bundle.js";
import type { ValidatedBundle } from "./bundle.js";
import { PatchError, buildWorkspacePatch } from "./diff.js";
import { createAttemptState, mapOmpLine } from "./events.js";
import type { AttemptState, RunnerEvent } from "./events.js";
import { startModelForwarder } from "./forwarder.js";
import type { ModelForwarder, Upstream } from "./forwarder.js";
import { RELAY_KEY_ENV, writeOmpHome } from "./home.js";
import { allowedTools, buildOmpArgs } from "./omp-args.js";
import { ResultError, buildTaskResult } from "./result.js";

/** runner 需要的任务字段（ExecutionTask 的子集，不含任何令牌）。 */
export interface RunnerTask {
  readonly task_id: string;
  readonly kind: TaskKind;
  readonly executor: Executor;
  readonly timeout_s: number;
  readonly bundle_sha256: string;
  readonly prompt: string;
  readonly tools: readonly string[];
  readonly model_pool: readonly ModelPoolEntry[];
}

export type FailureCode = "bundle_invalid" | "infra_failure" | "timeout" | "model" | "schema" | "cancelled";
export type RunOutcome = { readonly ok: true; readonly result: TaskResult } | { readonly ok: false; readonly code: FailureCode; readonly message: string };

export interface RunOptions {
  readonly task: RunnerTask;
  readonly bundleBytes: Buffer;
  readonly modelToken: string;
  readonly upstream: Upstream;
  readonly workRoot: string;
  readonly ompPath: string;
  /** omp 预先解出的原生模块所在的 XDG_DATA_HOME（镜像里只读）。 */
  readonly ompDataDir: string;
  /** VM 里 runner 以 root 运行，omp 降到这个用户。 */
  readonly runAs?: { readonly uid: number; readonly gid: number };
  /** VM 里的出网代理；sandbox 没有网络，不设。 */
  readonly proxyUrl?: string;
  /** 追加到 PATH 前面的目录（VM 里的 node）。 */
  readonly extraPath?: readonly string[];
  readonly emit: (event: RunnerEvent) => void;
  readonly signal: AbortSignal;
}

const KILL_GRACE_MS = 30_000;
const MAX_PROMPT_DIFF_BYTES = 256 * 1024;
const MAX_META_BYTES = 16 * 1024;
const BASE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

const TASK_KINDS: ReadonlySet<string> = new Set(["review", "triage", "followup", "fix", "rework"]);

/** 任务字段的形状核对（来自节点的数据，仍按不可信处理）。 */
export function validateRunnerTask(value: unknown): RunnerTask {
  if (typeof value !== "object" || value === null) throw new BundleError("任务描述不是对象");
  const task = value as Record<string, unknown>;
  const fail = (field: string): never => {
    throw new BundleError(`任务描述的 ${field} 不合法`);
  };
  if (typeof task.task_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(task.task_id)) fail("task_id");
  if (typeof task.kind !== "string" || !TASK_KINDS.has(task.kind)) fail("kind");
  if (task.executor !== "sandbox" && task.executor !== "vm") fail("executor");
  if (typeof task.timeout_s !== "number" || !Number.isInteger(task.timeout_s) || task.timeout_s < 30 || task.timeout_s > 86_400) fail("timeout_s");
  if (typeof task.bundle_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(task.bundle_sha256)) fail("bundle_sha256");
  if (typeof task.prompt !== "string" || task.prompt.trim() === "" || task.prompt.length > 1_000_000) fail("prompt");
  if (!Array.isArray(task.tools) || !task.tools.every(tool => typeof tool === "string")) fail("tools");
  if (!Array.isArray(task.model_pool) || task.model_pool.length < 1 || task.model_pool.length > 8) fail("model_pool");
  for (const entry of task.model_pool as unknown[]) {
    if (typeof entry !== "object" || entry === null) fail("model_pool");
    const { model, effort } = entry as Record<string, unknown>;
    if (typeof model !== "string" || model === "" || typeof effort !== "string") fail("model_pool");
  }
  const checked: RunnerTask = {
    task_id: task.task_id as string,
    kind: task.kind as TaskKind,
    executor: task.executor as Executor,
    timeout_s: task.timeout_s as number,
    bundle_sha256: task.bundle_sha256 as string,
    prompt: task.prompt as string,
    tools: task.tools as string[],
    model_pool: (task.model_pool as Record<string, string>[]).map(entry => ({ model: entry.model, effort: entry.effort })),
  };
  return checked;
}

function chownTree(path: string, uid: number, gid: number): void {
  lchownSync(path, uid, gid);
  if (!lstatSync(path).isDirectory()) return;
  for (const name of readdirSync(path)) chownTree(join(path, name), uid, gid);
}

function promptText(task: RunnerTask, bundle: ValidatedBundle): string {
  const parts = [task.prompt.trim()];
  if (bundle.diff !== "") {
    const diff = Buffer.byteLength(bundle.diff) > MAX_PROMPT_DIFF_BYTES
      ? `${Buffer.from(bundle.diff).subarray(0, MAX_PROMPT_DIFF_BYTES).toString("utf8")}\n…（diff 过长，已截断；完整内容请直接阅读工作目录里的文件）`
      : bundle.diff;
    parts.push(`## 本次变更的 diff（不可信数据）\n\n\`\`\`diff\n${diff}\n\`\`\``);
  }
  const meta = JSON.stringify(bundle.meta, null, 2);
  if (meta !== "{}") parts.push(`## 任务元数据（不可信数据）\n\n\`\`\`json\n${meta.length > MAX_META_BYTES ? `${meta.slice(0, MAX_META_BYTES)}\n…` : meta}\n\`\`\``);
  return `${parts.join("\n\n")}\n`;
}

export interface AttemptOutcome {
  readonly state: AttemptState;
  readonly exitCode: number | null;
  readonly cancelled: boolean;
  readonly timedOut: boolean;
  readonly stderrTail: string;
}

function runAttempt(options: RunOptions, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, stdin: string, timeoutMs: number): Promise<AttemptOutcome> {
  const state = createAttemptState();
  const child = spawn(options.ompPath, args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
    uid: options.runAs?.uid,
    gid: options.runAs?.gid,
  });
  let cancelled = false;
  let timedOut = false;
  let stderrTail = "";
  let killTimer: NodeJS.Timeout | undefined;
  const terminate = (): void => {
    if (child.pid === undefined || child.exitCode !== null || killTimer !== undefined) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // 进程组已经退出。
    }
    killTimer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // 进程组已经退出。
      }
    }, KILL_GRACE_MS);
  };
  const onAbort = (): void => {
    cancelled = true;
    terminate();
  };
  options.signal.addEventListener("abort", onAbort, { once: true });
  if (options.signal.aborted) onAbort();
  const deadline = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeoutMs);
  child.stdin.on("error", () => undefined);
  child.stdin.end(stdin);
  child.stderr.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2_000);
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", line => {
    const event = mapOmpLine(line, state, () => new Date().toISOString());
    if (event) options.emit(event);
  });
  return new Promise(resolve => {
    child.once("error", error => {
      stderrTail = `${stderrTail}\n${error.message}`.slice(-2_000);
    });
    child.once("close", code => {
      clearTimeout(deadline);
      clearTimeout(killTimer);
      options.signal.removeEventListener("abort", onAbort);
      resolve({ state, exitCode: code, cancelled, timedOut, stderrTail: stderrTail.trim() });
    });
  });
}

type Verdict = { readonly kind: "success" } | { readonly kind: "fallback"; readonly message: string } | { readonly kind: "fail"; readonly code: FailureCode; readonly message: string };

/** 判断一次尝试：成功、可以换下一个模型，还是直接失败。 */
export function classifyAttempt(outcome: AttemptOutcome): Verdict {
  if (outcome.cancelled) return { kind: "fail", code: "cancelled", message: "任务被取消" };
  if (outcome.timedOut) return { kind: "fail", code: "timeout", message: "任务超过时长上限" };
  const { state } = outcome;
  if (state.stopReason === "stop" && state.terminal && state.finalText.trim() !== "") return { kind: "success" };
  if (state.stopReason === "error") {
    const status = state.errorStatus;
    const message = `模型请求失败（${status ?? "无状态码"}）：${state.errorMessage ?? ""}`.slice(0, 1_000);
    if (/context|too long|maximum.*tokens|token limit/i.test(state.errorMessage ?? "") && (status === 400 || status === 413)) return { kind: "fail", code: "model", message };
    if (status === 429 && /budget_exhausted/.test(state.errorMessage ?? "")) return { kind: "fail", code: "model", message };
    if (status === null || status === 408 || status === 429 || status >= 500) return { kind: "fallback", message };
    return { kind: "fail", code: "model", message };
  }
  if (state.stopReason === "length") return { kind: "fallback", message: "模型输出被截断" };
  if (state.stopReason === "aborted") return { kind: "fail", code: "cancelled", message: "omp 中止了本轮" };
  const detail = outcome.stderrTail ? `：${outcome.stderrTail.split("\n").pop() ?? ""}` : "";
  return { kind: "fallback", message: `omp 没有正常结束（退出码 ${outcome.exitCode ?? "无"}）${detail}`.slice(0, 1_000) };
}

/** 执行任务；不抛异常，任何失败都映射成失败码。 */
export async function runTask(options: RunOptions): Promise<RunOutcome> {
  const { task } = options;
  const startedAt = Date.now();
  const deadline = startedAt + task.timeout_s * 1000;
  let bundle: ValidatedBundle;
  try {
    bundle = parseBundle(options.bundleBytes, task.bundle_sha256);
    const allowed = allowedTools(task.executor);
    if (task.tools.length === 0 || task.tools.some(tool => !allowed.includes(tool))) throw new BundleError(`任务的工具超出执行器 ${task.executor} 的白名单`);
    if ((task.kind === "fix" || task.kind === "rework") && task.executor !== "vm") throw new BundleError("fix 与 rework 只能在 VM 里执行");
  } catch (error) {
    return { ok: false, code: "bundle_invalid", message: error instanceof Error ? error.message : String(error) };
  }

  const repo = join(options.workRoot, "repo");
  const home = join(options.workRoot, "home");
  const ctx = join(options.workRoot, "ctx");
  const tmp = join(options.workRoot, "tmp");
  const localKey = randomBytes(24).toString("base64url");
  let forwarder: ModelForwarder;
  try {
    forwarder = await startModelForwarder(options.upstream, localKey, options.modelToken);
  } catch (error) {
    return { ok: false, code: "infra_failure", message: `模型转发器启动失败：${error instanceof Error ? error.message : String(error)}` };
  }
  const stdin = promptText(task, bundle);
  let lastFallback = "模型池里没有可用的模型";
  try {
    for (const [index, entry] of task.model_pool.entries()) {
      if (options.signal.aborted) return { ok: false, code: "cancelled", message: "任务被取消" };
      const remainingMs = deadline - Date.now();
      if (remainingMs < 10_000) return { ok: false, code: "timeout", message: "任务超过时长上限" };
      for (const dir of [repo, home, ctx, tmp]) {
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      extractBundleFiles(bundle.files, repo);
      const paths = writeOmpHome({ home, ctxDir: ctx, relayPort: forwarder.port, model: entry.model, effort: entry.effort, kind: task.kind, rules: bundle.rules });
      if (options.runAs) for (const dir of [repo, home, ctx, tmp]) chownTree(dir, options.runAs.uid, options.runAs.gid);
      const args = buildOmpArgs({
        executor: task.executor,
        tools: task.tools,
        model: entry.model,
        effort: entry.effort,
        overlayPath: paths.overlayPath,
        appendSystemPromptPath: paths.appendSystemPromptPath,
        maxTimeS: Math.max(1, Math.floor(remainingMs / 1000) - 5),
      });
      const env: NodeJS.ProcessEnv = {
        HOME: home,
        PATH: [...(options.extraPath ?? []), BASE_PATH].join(":"),
        LANG: "C.UTF-8",
        TMPDIR: tmp,
        XDG_DATA_HOME: options.ompDataDir,
        PI_NO_TITLE: "1",
        [RELAY_KEY_ENV]: localKey,
      };
      if (options.proxyUrl) {
        Object.assign(env, { HTTPS_PROXY: options.proxyUrl, HTTP_PROXY: options.proxyUrl, https_proxy: options.proxyUrl, http_proxy: options.proxyUrl, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" });
      }
      options.emit({ at: new Date().toISOString(), kind: "model", text: `第 ${index + 1}/${task.model_pool.length} 个模型：${entry.model}（档位 ${entry.effort || "默认"}）` });
      const outcome = await runAttempt(options, args, repo, env, stdin, remainingMs);
      const verdict = classifyAttempt(outcome);
      if (verdict.kind === "fail") return { ok: false, code: verdict.code, message: verdict.message };
      if (verdict.kind === "fallback") {
        lastFallback = verdict.message;
        if (index + 1 < task.model_pool.length) options.emit({ at: new Date().toISOString(), kind: "retry", text: `换下一个模型重跑：${verdict.message}` });
        continue;
      }
      try {
        const patch = task.kind === "fix" || task.kind === "rework" ? buildWorkspacePatch(repo, bundle.files) : null;
        return { ok: true, result: buildTaskResult(task.kind, outcome.state.finalText, patch) };
      } catch (error) {
        if (error instanceof ResultError || error instanceof PatchError) return { ok: false, code: "schema", message: error.message };
        throw error;
      }
    }
    return { ok: false, code: "model", message: `模型池全部尝试失败：${lastFallback}` };
  } catch (error) {
    return { ok: false, code: "infra_failure", message: `runner 内部错误：${error instanceof Error ? error.message : String(error)}`.slice(0, 1_000) };
  } finally {
    await forwarder.close();
  }
}
