/**
 * 节点对 control 的 HTTP 客户端（/api/node/v1，只由节点主动发起）。
 * 每个请求带节点认证与版本；任务请求同时在头和体/query里带 lease_id、epoch，两处必须一致。
 * 收到 control 的任何非 5xx 响应都算「联络上」（失联判定只看这个），网络错误与 5xx 不算。
 * 错误统一抛 ControlHttpError：status 0 表示网络错误或超时。调用方按 status 区分：
 *   401 → 立即停止一切任务并停领任务；任务请求的 409/404 → 只停该任务；0、408、429、5xx → 退避重试。
 */
import { NODE_PROTOCOL_VERSION } from "@geek-bot/protocol";
import type { ExecutionTask, HeartbeatReply, LeaseFence, LeaseRequest, MachineHeartbeat, TaskEvent, TaskResult } from "@geek-bot/protocol";

export class ControlHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterMs: number | null;
  constructor(status: number, code: string, message: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = "ControlHttpError";
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
  get unauthorized(): boolean {
    return this.status === 401 && this.code !== "task_token_invalid";
  }
  /** 任务请求被栅栏挡下或租约不属于本机：只停这个任务。 */
  get fenced(): boolean {
    return this.status === 409 || this.status === 404;
  }
  get retryable(): boolean {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

export interface RenewReply {
  readonly lease_expires_at: string;
  readonly lease_ttl_s: number;
  readonly cancel: boolean;
}

export type FailureCode =
  | "bundle_invalid"
  | "vm_start_failed"
  | "resource_unavailable"
  | "infra_failure"
  | "draining"
  | "node_shutdown"
  | "timeout"
  | "model"
  | "schema"
  | "cancelled";

export interface ControlClientOptions {
  readonly baseUrl: string;
  readonly nodeName: string;
  readonly token: () => string;
  /** 每次收到 control 的非 5xx 响应时调用。 */
  readonly onContact: () => void;
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function retryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 300_000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.min(Math.max(0, date - Date.now()), 300_000);
}

export class ControlClient {
  readonly #options: ControlClientOptions;
  readonly #fetch: typeof fetch;

  constructor(options: ControlClientOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `Bearer ${this.#options.token()}`,
      "x-geek-bot-protocol": String(NODE_PROTOCOL_VERSION),
      "x-geek-bot-node": this.#options.nodeName,
      ...extra,
    };
  }

  /** 五个任务请求共用同一组租约头，避免体/query栅栏与传输头脱节。 */
  fenceHeaders(fence: LeaseFence): Record<string, string> {
    return { "x-geek-bot-lease": fence.lease_id, "x-geek-bot-epoch": String(fence.epoch) };
  }

  /** 发请求并在非 2xx 时抛 ControlHttpError；返回响应（调用方读取正文）。 */
  async send(method: string, path: string, init: { body?: unknown; headers?: Record<string, string>; timeoutMs?: number | null; signal?: AbortSignal } = {}): Promise<Response> {
    const signals: AbortSignal[] = [];
    if (init.timeoutMs !== null) signals.push(AbortSignal.timeout(init.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    if (init.signal) signals.push(init.signal);
    const headers = this.headers(init.headers);
    let body: string | undefined;
    if (init.body !== undefined) {
      body = JSON.stringify(init.body);
      headers["content-type"] = "application/json";
    }
    let response: Response;
    try {
      response = await this.#fetch(`${this.#options.baseUrl}/api/node/v1${path}`, {
        method,
        headers,
        body,
        signal: signals.length > 0 ? AbortSignal.any(signals) : undefined,
        redirect: "error",
      });
    } catch (error) {
      throw new ControlHttpError(0, "network", `连不上 control：${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status < 500) this.#options.onContact();
    if (response.ok) return response;
    let code = "http_error";
    let message = `control 返回 ${response.status}`;
    try {
      const parsed: unknown = await response.json();
      if (typeof parsed === "object" && parsed !== null && "error" in parsed && typeof parsed.error === "object" && parsed.error !== null) {
        const error = parsed.error;
        if ("code" in error && typeof error.code === "string") code = error.code;
        if ("message" in error && typeof error.message === "string") message = `${message}：${error.message}`;
      }
    } catch {
      // 错误正文不是 JSON：保留状态码。
    }
    throw new ControlHttpError(response.status, code, message, retryAfter(response.headers.get("retry-after")));
  }

  async #json<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>, timeoutMs?: number): Promise<T> {
    const response = await this.send(method, path, { body, headers, timeoutMs });
    try {
      return (await response.json()) as T;
    } catch {
      throw new ControlHttpError(0, "invalid_response", `control 的 ${path} 响应不是 JSON`);
    }
  }

  heartbeat(body: MachineHeartbeat): Promise<HeartbeatReply> {
    return this.#json<HeartbeatReply>("POST", "/heartbeat", body);
  }

  /** 模型中继自检：control 用自己的网关密钥做一次只读连通检查（节点不持有网关密钥）。 */
  selfCheckModel(): Promise<{ ok: boolean; checked_at: string; models: number; error?: string }> {
    return this.#json<{ ok: boolean; checked_at: string; models: number; error?: string }>("POST", "/self-check/model", {});
  }

  /** 长轮询领任务：同一个 Idempotency-Key 重试时 control 返回同一个任务。请求超时比挂起上限多 10 秒。 */
  async lease(body: LeaseRequest, idempotencyKey: string): Promise<ExecutionTask | null> {
    const reply = await this.#json<{ task: ExecutionTask | null }>("POST", "/lease", body, { "idempotency-key": idempotencyKey }, (body.wait_s + 10) * 1000);
    return reply.task ?? null;
  }

  renew(taskId: string, fence: LeaseFence): Promise<RenewReply> {
    return this.#json<RenewReply>("POST", `/tasks/${encodeURIComponent(taskId)}/renew`, fence, this.fenceHeaders(fence));
  }

  /** 取任务包原始字节（不解析；调用方按 sha256 核对）。 */
  async bundle(taskId: string, fence: LeaseFence): Promise<Buffer> {
    const query = new URLSearchParams({ lease_id: fence.lease_id, epoch: String(fence.epoch) });
    const response = await this.send("GET", `/tasks/${encodeURIComponent(taskId)}/bundle?${query}`, { headers: this.fenceHeaders(fence), timeoutMs: 300_000 });
    return Buffer.from(await response.arrayBuffer());
  }

  events(taskId: string, fence: LeaseFence, events: readonly TaskEvent[]): Promise<{ ack_seq: number }> {
    return this.#json<{ ack_seq: number }>("POST", `/tasks/${encodeURIComponent(taskId)}/events`, { ...fence, events }, this.fenceHeaders(fence));
  }

  result(taskId: string, fence: LeaseFence, result: TaskResult): Promise<unknown> {
    return this.#json<unknown>("POST", `/tasks/${encodeURIComponent(taskId)}/result`, { ...fence, result }, this.fenceHeaders(fence));
  }

  failure(taskId: string, fence: LeaseFence, code: FailureCode, message: string): Promise<unknown> {
    return this.#json<unknown>("POST", `/tasks/${encodeURIComponent(taskId)}/failure`, { ...fence, code, message: message.slice(0, 2_000) }, this.fenceHeaders(fence));
  }

  /**
   * 模型中继：把 sandbox 或 VM 的 OpenAI 兼容请求转给 control。模型令牌放进 X-Geek-Bot-Task-Token，
   * 不设整体超时（流式响应可能很长），由 signal 在任务结束时中断。返回原始响应，状态码由调用方判断（网络错误抛 ControlHttpError）。
   */
  relay(method: "GET" | "POST", subpath: "chat/completions" | "models", task: { task_id: string; lease_id: string; epoch: number; model_token: string }, body: string | null, accept: string, signal: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = {
      "x-geek-bot-task-token": task.model_token,
      "x-geek-bot-lease": task.lease_id,
      "x-geek-bot-epoch": String(task.epoch),
      "x-geek-bot-task": task.task_id,
      accept,
    };
    if (body) headers["content-type"] = "application/json";
    return this.#sendRaw(method, `/model/v1/${subpath}`, headers, body, signal);
  }

  async #sendRaw(method: string, path: string, extra: Record<string, string>, body: string | null, signal: AbortSignal): Promise<Response> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#options.baseUrl}/api/node/v1${path}`, {
        method,
        headers: this.headers(extra),
        body: body ?? undefined,
        signal,
        redirect: "error",
      });
    } catch (error) {
      throw new ControlHttpError(0, "network", `连不上 control：${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status < 500) this.#options.onContact();
    return response;
  }
}
