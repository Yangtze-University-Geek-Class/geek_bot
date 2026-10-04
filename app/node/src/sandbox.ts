/**
 * sandbox 执行器：按槽位预先登记的 sandbox 容器（无网、根只读、cap_drop ALL、非 root），每个槽位与 node 共享一个卷，
 * 卷里只有 node 监听的 unix socket。node 不持有 docker.sock、不起容器、不在宿主执行仓库代码：
 * 槽位容器里的 runner 自己来领任务，做完一个就退出，由容器的重启策略换一个全新的进程和 tmpfs。
 *
 * 槽位状态：
 *   空闲   runner 会话正在长轮询（或 5 秒内轮询过），没有任务；
 *   已分配 任务交给了某个会话，只有这个会话能取任务包、交事件、交结果、调模型；
 *   已用过 会话交完结果后被记为退役，必须换新会话（新进程）才算空闲；
 *   污染   取消或销毁后会话没有按时结束：撤销模型访问、断开它的连接，直到出现新会话。
 * 取消：事件响应带 cancel=true，runner 停下 omp（SIGTERM，30 秒后 SIGKILL）并交 cancelled；
 * 35 秒内没交就按 cancelled 结束、撤销模型访问并把槽位记为污染。
 */
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";
import type { ExecutionTask } from "@geek-bot/protocol";
import type { ControlClient } from "./control-client.js";
import type { FailureCode } from "./control-client.js";
import { RUNNER_FAILURE_CODES, normalizeRunnerEvent, runnerTaskOf, validateTaskResult } from "./executor.js";
import type { ExecutionHandle, ExecutionOutcome, ExecutionSink, TaskExecutor } from "./executor.js";
import { handleModelRequest } from "./model-relay.js";
import { parseProbeEvidence, sandboxEvidenceProblems } from "./self-check.js";
import type { CheckResult, ProbeEvidence } from "./self-check.js";

const SESSION_RE = /^[0-9a-f-]{36}$/;
const IDLE_WINDOW_MS = 5_000;
const DELIVERY_TIMEOUT_MS = 15_000;
const CANCEL_GRACE_MS = 35_000;
const MAX_POLL_S = 25;
const MAX_JSON_BYTES = 2 * 1024 * 1024;

interface Assignment {
  readonly task: ExecutionTask;
  readonly bundle: Buffer;
  readonly sink: ExecutionSink;
  session: string | null;
  cancelRequested: boolean;
  revoked: boolean;
  settled: boolean;
  readonly abort: AbortController;
  readonly timers: NodeJS.Timeout[];
  readonly resolve: (outcome: ExecutionOutcome) => void;
}

interface Waiter {
  readonly session: string;
  readonly res: ServerResponse;
  readonly timer: NodeJS.Timeout;
}

interface Slot {
  readonly index: number;
  readonly socketPath: string;
  server: Server | null;
  readonly sockets: Map<Socket, string | null>;
  waiter: Waiter | null;
  lastPollAt: number;
  lastPollSession: string | null;
  assignment: Assignment | null;
  readonly retired: Set<string>;
  tainted: boolean;
  /** 当前会话（最近一次报到）的自检证据与判定。只有通过判定的会话能领任务。 */
  helloSession: string | null;
  evidence: ProbeEvidence | null;
  problems: readonly string[];
  checkedAt: string | null;
}

export interface SandboxPoolOptions {
  readonly slotsDir: string;
  readonly count: number;
  readonly client: ControlClient;
  readonly onUnauthorized: () => void;
  /** 节点期望的 omp 版本（来自节点镜像），sandbox 里的版本必须一致；null 表示不比较。 */
  readonly expectedOmpVersion: string | null;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_JSON_BYTES) {
        req.destroy();
        reject(new Error("请求体超过上限"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("请求体不是 JSON"));
      }
    });
    req.on("error", reject);
  });
}

export class SandboxPool implements TaskExecutor {
  readonly #options: SandboxPoolOptions;
  readonly #slots: Slot[] = [];

  constructor(options: SandboxPoolOptions) {
    this.#options = options;
  }

  /** 为每个槽位建目录并监听 socket（旧 socket 先删掉）。 */
  async listen(): Promise<void> {
    for (let index = 0; index < this.#options.count; index += 1) {
      const dir = join(this.#options.slotsDir, `sandbox-${index}`);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const slot: Slot = {
        index,
        socketPath: join(dir, "node.sock"),
        server: null,
        sockets: new Map(),
        waiter: null,
        lastPollAt: 0,
        lastPollSession: null,
        assignment: null,
        retired: new Set(),
        tainted: false,
        helloSession: null,
        evidence: null,
        problems: ["runner 还没报到"],
        checkedAt: null,
      };
      rmSync(slot.socketPath, { force: true });
      const server = createServer((req, res) => {
        void this.#route(slot, req, res).catch(() => {
          if (!res.headersSent) sendJson(res, 400, { error: { code: "bad_request", message: "请求不合法" } });
          else res.destroy();
        });
      });
      server.on("connection", socket => {
        slot.sockets.set(socket, null);
        socket.once("close", () => slot.sockets.delete(socket));
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(slot.socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });
      chmodSync(slot.socketPath, 0o600);
      slot.server = server;
      this.#slots.push(slot);
    }
  }

  stop(): void {
    this.destroyAll();
    for (const slot of this.#slots) {
      slot.server?.close();
      for (const socket of slot.sockets.keys()) socket.destroy();
    }
  }

  #verified(slot: Slot, session: string): boolean {
    return slot.helloSession === session && slot.problems.length === 0;
  }

  #idle(slot: Slot): boolean {
    if (slot.assignment || slot.tainted) return false;
    const session = slot.waiter?.session ?? slot.lastPollSession;
    if (session === null || slot.retired.has(session) || !this.#verified(slot, session)) return false;
    return slot.waiter !== null || Date.now() - slot.lastPollAt < IDLE_WINDOW_MS;
  }

  free(): number {
    return this.#slots.filter(slot => this.#idle(slot)).length;
  }

  /** 已连接槽位的概况（放进心跳的 health）。 */
  describe(): { connected: number; idle: number; busy: number; tainted: number; verified: number } {
    return {
      connected: this.#slots.filter(slot => Date.now() - slot.lastPollAt < 60_000 || slot.waiter !== null).length,
      idle: this.free(),
      busy: this.#slots.filter(slot => slot.assignment !== null).length,
      tainted: this.#slots.filter(slot => slot.tainted).length,
      verified: this.#slots.filter(slot => slot.helloSession !== null && slot.problems.length === 0).length,
    };
  }

  /**
   * sandbox 执行器的自检结论：至少一个槽位的 runner 报到并通过隔离与 omp 检查即为可用；
   * 没有槽位通过时给出第一个槽位的原因。ompVersion 是通过的槽位报出的 omp 版本。
   */
  check(): CheckResult & { readonly ompVersion: string | null } {
    const passed = this.#slots.filter(slot => slot.helloSession !== null && slot.problems.length === 0);
    const latest = this.#slots.map(slot => slot.checkedAt).filter((value): value is string => value !== null).sort().pop() ?? null;
    if (passed.length > 0) return { ok: true, error: null, checked_at: latest, ompVersion: passed[0].evidence?.omp_version ?? null };
    if (this.#slots.length === 0) return { ok: false, error: "没有 sandbox 槽位", checked_at: null, ompVersion: null };
    const reasons = this.#slots.map(slot => `槽位 ${slot.index}：${slot.problems.join("、")}`);
    return { ok: false, error: reasons.join("；").slice(0, 1_000), checked_at: latest, ompVersion: null };
  }

  start(task: ExecutionTask, bundle: Buffer, sink: ExecutionSink): ExecutionHandle {
    const slot = this.#slots.find(candidate => this.#idle(candidate));
    let resolveDone!: (outcome: ExecutionOutcome) => void;
    const done = new Promise<ExecutionOutcome>(resolve => {
      resolveDone = resolve;
    });
    if (!slot) {
      resolveDone({ kind: "failure", code: "resource_unavailable", message: "没有空闲的 sandbox 槽位" });
      return { done, cancel: () => undefined, destroy: () => undefined };
    }
    const assignment: Assignment = {
      task,
      bundle,
      sink,
      session: null,
      cancelRequested: false,
      revoked: false,
      settled: false,
      abort: new AbortController(),
      timers: [],
      resolve: resolveDone,
    };
    slot.assignment = assignment;
    if (slot.waiter) this.#deliver(slot, slot.waiter);
    else {
      assignment.timers.push(setTimeout(() => {
        if (assignment.session === null) this.#settle(slot, assignment, { kind: "failure", code: "resource_unavailable", message: "sandbox 槽位的 runner 没有来领任务" }, true);
      }, DELIVERY_TIMEOUT_MS));
    }
    return {
      done,
      cancel: () => {
        if (assignment.settled || assignment.cancelRequested) return;
        assignment.cancelRequested = true;
        if (assignment.session === null) {
          this.#settle(slot, assignment, { kind: "failure", code: "cancelled", message: "任务在交给 runner 之前被取消" }, false);
          return;
        }
        assignment.timers.push(setTimeout(() => {
          this.#settle(slot, assignment, { kind: "failure", code: "cancelled", message: "runner 没有在宽限期内停下，已撤销它的模型访问" }, true);
        }, CANCEL_GRACE_MS));
      },
      destroy: () => this.#settle(slot, assignment, { kind: "failure", code: "cancelled", message: "任务被强制销毁" }, true),
    };
  }

  destroyAll(): void {
    for (const slot of this.#slots) {
      if (slot.assignment) this.#settle(slot, slot.assignment, { kind: "failure", code: "cancelled", message: "任务被强制销毁" }, true);
    }
  }

  /** 结束一个分配；taint 为真时撤销会话、断开它的连接并把槽位记为污染，直到出现新会话。 */
  #settle(slot: Slot, assignment: Assignment, outcome: ExecutionOutcome, taint: boolean): void {
    if (assignment.settled) return;
    assignment.settled = true;
    assignment.revoked = true;
    assignment.abort.abort();
    for (const timer of assignment.timers) clearTimeout(timer);
    if (slot.assignment === assignment) slot.assignment = null;
    if (assignment.session !== null) slot.retired.add(assignment.session);
    if (taint) {
      slot.tainted = true;
      for (const [socket, session] of slot.sockets) if (session === null || session === assignment.session) socket.destroy();
    }
    assignment.resolve(outcome);
  }

  #deliver(slot: Slot, waiter: Waiter): void {
    const assignment = slot.assignment;
    if (!assignment) return;
    clearTimeout(waiter.timer);
    slot.waiter = null;
    assignment.session = waiter.session;
    sendJson(waiter.res, 200, { task: runnerTaskOf(assignment.task), model_token: assignment.task.model_token });
  }

  async #route(slot: Slot, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const session = typeof req.headers["x-runner-session"] === "string" ? req.headers["x-runner-session"] : "";
    if (!SESSION_RE.test(session)) {
      sendJson(res, 400, { error: { code: "bad_request", message: "缺少 X-Runner-Session" } });
      return;
    }
    slot.sockets.set(req.socket, session);
    const url = new URL(req.url ?? "/", "http://slot");
    const assignment = slot.assignment;
    const owns = assignment !== null && assignment.session === session;

    if (url.pathname.startsWith("/model/")) {
      if (!owns || !assignment) {
        sendJson(res, 409, { error: { code: "no_task", message: "这个会话没有任务" } });
        return;
      }
      await handleModelRequest(req, res, {
        client: this.#options.client,
        task: assignment.task,
        signal: assignment.abort.signal,
        revoked: () => assignment.revoked,
        onUnauthorized: this.#options.onUnauthorized,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/hello") {
      if (slot.assignment && slot.assignment.session !== null && slot.assignment.session !== session) {
        sendJson(res, 409, { error: { code: "slot_busy", message: "槽位正被别的会话占用" } });
        return;
      }
      const evidence = parseProbeEvidence(await readJson(req));
      slot.helloSession = session;
      slot.evidence = evidence;
      slot.problems = evidence ? sandboxEvidenceProblems(evidence, this.#options.expectedOmpVersion) : ["runner 报到的证据格式不对"];
      slot.checkedAt = new Date().toISOString();
      sendJson(res, 200, { accepted: slot.problems.length === 0, problems: slot.problems });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/task") {
      if (!this.#verified(slot, session)) {
        sendJson(res, 403, { error: { code: "not_verified", message: `这个会话没有通过自检：${slot.helloSession === session ? slot.problems.join("、") : "没有报到"}` } });
        return;
      }
      if (slot.retired.has(session)) {
        sendJson(res, 409, { error: { code: "session_retired", message: "这个会话已经做过任务，进程应当退出" } });
        return;
      }
      if (owns) {
        // 同一会话重复领取（上一个响应丢了）：再给一次同样的任务。
        sendJson(res, 200, { task: runnerTaskOf(assignment.task), model_token: assignment.task.model_token });
        return;
      }
      if (assignment && assignment.session !== null) {
        sendJson(res, 409, { error: { code: "slot_busy", message: "槽位正被别的会话占用" } });
        return;
      }
      if (slot.tainted) slot.tainted = false;
      slot.lastPollAt = Date.now();
      slot.lastPollSession = session;
      if (slot.waiter) {
        clearTimeout(slot.waiter.timer);
        if (!slot.waiter.res.headersSent) slot.waiter.res.writeHead(204).end();
      }
      const wait = Math.min(MAX_POLL_S, Math.max(0, Number(url.searchParams.get("wait") ?? "0") || 0));
      const waiter: Waiter = {
        session,
        res,
        timer: setTimeout(() => {
          if (slot.waiter === waiter) slot.waiter = null;
          slot.lastPollAt = Date.now();
          if (!res.headersSent) res.writeHead(204).end();
        }, wait * 1000),
      };
      slot.waiter = waiter;
      res.once("close", () => {
        if (slot.waiter === waiter) {
          clearTimeout(waiter.timer);
          slot.waiter = null;
          slot.lastPollAt = Date.now();
        }
      });
      if (slot.assignment && slot.assignment.session === null) this.#deliver(slot, waiter);
      return;
    }

    if (!owns || !assignment) {
      sendJson(res, 409, { error: { code: "no_task", message: "这个会话没有任务" } });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/bundle") {
      res.writeHead(200, { "content-type": "application/json", "content-length": assignment.bundle.length });
      res.end(assignment.bundle);
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/events") {
      const body = await readJson(req);
      const events = typeof body === "object" && body !== null && "events" in body && Array.isArray(body.events) ? body.events : [];
      for (const raw of events.slice(0, 500)) {
        const event = normalizeRunnerEvent(raw);
        if (event) assignment.sink.emit(event);
      }
      sendJson(res, 200, { cancel: assignment.cancelRequested });
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/result") {
      const body = await readJson(req);
      const raw = typeof body === "object" && body !== null && "result" in body ? body.result : undefined;
      let outcome: ExecutionOutcome;
      try {
        outcome = { kind: "result", result: validateTaskResult(assignment.task.kind, raw) };
      } catch (error) {
        outcome = { kind: "failure", code: "schema", message: `runner 交回的结果不合格：${error instanceof Error ? error.message : String(error)}` };
      }
      sendJson(res, 200, { accepted: true });
      this.#settle(slot, assignment, outcome, false);
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/failure") {
      const body = await readJson(req);
      const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      const code = typeof record.code === "string" && RUNNER_FAILURE_CODES.has(record.code) ? (record.code as FailureCode) : "infra_failure";
      const message = typeof record.message === "string" ? record.message.slice(0, 2_000) : "runner 没有给出原因";
      sendJson(res, 200, { accepted: true });
      this.#settle(slot, assignment, { kind: "failure", code: assignment.cancelRequested ? "cancelled" : code, message }, false);
      return;
    }
    sendJson(res, 404, { error: { code: "not_found", message: "没有这个本地端点" } });
  }
}
