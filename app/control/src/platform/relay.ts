/**
 * 模型中继（S-02；ADR-0006；节点协议 N-09）：节点带节点令牌与每任务模型令牌请求，control 核对后换成网关密钥转发。
 *
 * - 同时要求节点令牌与任务令牌：任务令牌离开领它的节点用不了；租约（lease_id + epoch）必须仍有效。
 * - 请求体字段白名单；n 只许 1；tools 只许 function；model 必须在本任务池里，reasoning_effort 必须是池里配的档位。
 * - 预算：请求数与 token 上限；max_tokens 按剩余 token 封顶；流式强制 stream_options.include_usage。
 * - 网关地址只来自 GEEK_BOT_MODEL_GATEWAY_URL；每个请求记模型、HTTP 状态、耗时与用量（可信的降级记录）。
 */
import type { FastifyReply } from "fastify";
import type { PlatformContext } from "./context.js";
import { PlatformError, sha256Hex } from "./http.js";
import type { NodeIdentity } from "./machines.js";
import type { TasksService } from "./tasks.js";

export const RELAY_FIELDS = Object.freeze(["model", "messages", "tools", "tool_choice", "temperature", "top_p", "max_tokens", "stop", "stream", "stream_options", "reasoning_effort", "n"] as const);
const UPSTREAM_TIMEOUT_MS = 10 * 60_000;

export interface RelayHeaders {
  readonly taskToken: string | undefined;
  readonly leaseId: string | undefined;
  readonly epoch: string | undefined;
  readonly taskId: string | undefined;
}

export interface RelayService {
  models(node: NodeIdentity, headers: RelayHeaders): { object: "list"; data: { id: string; object: "model"; created: number; owned_by: string }[] };
  chat(node: NodeIdentity, headers: RelayHeaders, body: unknown, reply: FastifyReply): Promise<void>;
  /** 停机：中止全部进行中的网关请求，让流式连接结束。 */
  abortAll(): void;
  /** 节点自检的模型连通探针：control 用网关密钥对网关做一次只读的 GET /models，结果缓存 60 秒。 */
  probe(node: NodeIdentity): Promise<ModelProbe>;
}

export interface ModelProbe {
  readonly ok: boolean;
  readonly checked_at: string;
  readonly models: number;
  readonly error?: string;
}

interface Usage {
  prompt: number;
  completion: number;
}

function usageOf(value: unknown): Usage | null {
  if (value === null || typeof value !== "object" || !("usage" in value)) return null;
  const usage = value.usage;
  if (usage === null || typeof usage !== "object") return null;
  const prompt = "prompt_tokens" in usage && typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const completion = "completion_tokens" in usage && typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
  return { prompt, completion };
}

export function createRelayService(ctx: PlatformContext, tasks: TasksService): RelayService {
  const { db, clock, config, secrets } = ctx;
  const active = new Set<AbortController>();

  function grant(node: NodeIdentity, headers: RelayHeaders) {
    const token = headers.taskToken ?? "";
    if (!/^gbt_[A-Za-z0-9_-]{20,100}$/.test(token)) throw new PlatformError(401, "task_token_invalid", "缺少或不认识的任务令牌");
    const epoch = Number(headers.epoch);
    if (!headers.leaseId || !/^[0-9a-f]{32}$/.test(headers.leaseId) || !Number.isSafeInteger(epoch) || epoch < 1) throw new PlatformError(400, "validation_failed", "缺少合法的 X-Geek-Bot-Lease 与 X-Geek-Bot-Epoch");
    return tasks.relayGrant(node.id, headers.taskId ?? null, { lease_id: headers.leaseId, epoch }, sha256Hex(token));
  }

  function record(taskId: string, leaseId: string, model: string, effort: string | null, status: number, startedAt: number, usage: Usage | null): void {
    const tokens = (usage?.prompt ?? 0) + (usage?.completion ?? 0);
    db.transaction(() => {
      db.prepare("INSERT INTO model_usage (task_id, lease_id, model, effort, http_status, duration_ms, prompt_tokens, completion_tokens, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        taskId, leaseId, model, effort, status, clock() - startedAt, usage?.prompt ?? 0, usage?.completion ?? 0, clock(),
      );
      if (tokens > 0) db.prepare("UPDATE tasks SET tokens_used = tokens_used + ? WHERE id = ?").run(tokens, taskId);
    })();
  }

  let probeCache: { at: number; result: ModelProbe } | null = null;
  let probing: Promise<ModelProbe> | null = null;

  async function runProbe(): Promise<ModelProbe> {
    const checkedAt = new Date(clock()).toISOString();
    if (config.model.gatewayUrl === null || secrets.modelGatewayKey === null) return { ok: false, checked_at: checkedAt, models: 0, error: "实例没有配置模型网关地址或网关密钥" };
    const catalog = ctx.config.model.catalogFile === null ? "没有配置 catalog" : null;
    try {
      const response = await ctx.fetchImpl(`${config.model.gatewayUrl}/models`, { method: "GET", headers: { Authorization: `Bearer ${secrets.modelGatewayKey}`, Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
      const text = (await response.text()).slice(0, 1_000_000);
      if (!response.ok) return { ok: false, checked_at: checkedAt, models: 0, error: `模型网关返回 HTTP ${response.status}` };
      let count = 0;
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === "object" && "data" in parsed && Array.isArray(parsed.data)) count = parsed.data.length;
      } catch {
        return { ok: false, checked_at: checkedAt, models: 0, error: "模型网关的 models 响应不是 JSON" };
      }
      return catalog === null ? { ok: true, checked_at: checkedAt, models: count } : { ok: false, checked_at: checkedAt, models: count, error: catalog };
    } catch {
      return { ok: false, checked_at: checkedAt, models: 0, error: "连不上模型网关" };
    }
  }

  return {
    abortAll() {
      for (const controller of active) controller.abort();
    },

    async probe(node) {
      ctx.limiter.hit(`model-probe:${node.id}`, 1, 60_000);
      if (probeCache && clock() - probeCache.at < 60_000) return probeCache.result;
      probing ??= runProbe().finally(() => {
        probing = null;
      });
      const result = await probing;
      probeCache = { at: clock(), result };
      return result;
    },


    models(node, headers) {
      const { pool } = grant(node, headers);
      const ids = [...new Set(pool.map(entry => entry.model))];
      return { object: "list", data: ids.map(id => ({ id, object: "model", created: 0, owned_by: "geek-bot" })) };
    },

    async chat(node, headers, body, reply) {
      const { task, pool } = grant(node, headers);
      if (config.model.gatewayUrl === null || secrets.modelGatewayKey === null) throw new PlatformError(503, "relay_unavailable", "实例没有配置模型网关地址或网关密钥");
      if (body === null || typeof body !== "object" || Array.isArray(body)) throw new PlatformError(400, "relay_field_rejected", "请求体必须是 JSON 对象");
      const input = { ...(body as Record<string, unknown>) };
      const allowed = new Set<string>(RELAY_FIELDS);
      const extra = Object.keys(input).filter(key => !allowed.has(key));
      if (extra.length > 0) throw new PlatformError(400, "relay_field_rejected", `不允许的字段：${extra.slice(0, 5).join("、")}`);
      if (input.n !== undefined && input.n !== 1) throw new PlatformError(400, "relay_field_rejected", "n 只能是 1");
      delete input.n;
      if (typeof input.model !== "string") throw new PlatformError(400, "relay_field_rejected", "缺少 model");
      const model = input.model;
      const entries = pool.filter(entry => entry.model === model);
      if (entries.length === 0) throw new PlatformError(403, "model_not_in_pool", "模型不在本任务的池里");
      const effort = typeof input.reasoning_effort === "string" ? input.reasoning_effort : null;
      if (input.reasoning_effort !== undefined && (effort === null || !entries.some(entry => entry.effort === effort))) throw new PlatformError(403, "model_not_in_pool", "思考档位不是池里给这个模型配的档位");
      if (!Array.isArray(input.messages)) throw new PlatformError(400, "relay_field_rejected", "messages 必须是数组");
      if (input.tools !== undefined) {
        if (!Array.isArray(input.tools) || !input.tools.every(tool => tool !== null && typeof tool === "object" && "type" in tool && tool.type === "function")) {
          throw new PlatformError(400, "relay_field_rejected", "tools 只许 function 类型");
        }
      }
      if (input.stream !== undefined && typeof input.stream !== "boolean") throw new PlatformError(400, "relay_field_rejected", "stream 必须是布尔值");
      const stream = input.stream === true;
      if (stream) input.stream_options = { include_usage: true };
      else delete input.stream_options;

      // 预算：先占一次请求数，再按剩余 token 封顶 max_tokens。
      const remaining = db.transaction(() => {
        const current = db.prepare("SELECT token_budget, tokens_used, request_budget, requests_used FROM tasks WHERE id = ?").get(task.id) as { token_budget: number; tokens_used: number; request_budget: number; requests_used: number };
        const left = current.token_budget - current.tokens_used;
        if (current.requests_used >= current.request_budget || left <= 0) return null;
        db.prepare("UPDATE tasks SET requests_used = requests_used + 1 WHERE id = ?").run(task.id);
        return left;
      })();
      if (remaining === null) throw new PlatformError(429, "budget_exhausted", "本任务的模型请求数或 token 预算已用完");
      const requested = typeof input.max_tokens === "number" && Number.isSafeInteger(input.max_tokens) && input.max_tokens > 0 ? input.max_tokens : remaining;
      input.max_tokens = Math.min(requested, remaining);

      const startedAt = clock();
      const controller = new AbortController();
      active.add(controller);
      reply.raw.on("close", () => active.delete(controller));
      const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
      let upstream: Response;
      try {
        upstream = await ctx.fetchImpl(`${config.model.gatewayUrl}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${secrets.modelGatewayKey}`, "Content-Type": "application/json", Accept: stream ? "text/event-stream" : "application/json" },
          body: JSON.stringify(input),
          signal: controller.signal,
        });
      } catch {
        clearTimeout(timer);
        const timedOut = controller.signal.aborted;
        record(task.id, task.lease_id as string, model, effort, timedOut ? 504 : 502, startedAt, null);
        throw new PlatformError(timedOut ? 504 : 502, timedOut ? "upstream_timeout" : "upstream_error", timedOut ? "模型网关超时" : "连不上模型网关");
      }

      if (upstream.status === 429 || upstream.status >= 500 || !upstream.body) {
        clearTimeout(timer);
        await upstream.body?.cancel();
        record(task.id, task.lease_id as string, model, effort, upstream.status, startedAt, null);
        if (upstream.status === 429) {
          const retry = upstream.headers.get("retry-after");
          throw new PlatformError(429, "upstream_rate_limited", "模型网关限流", retry && /^[0-9]{1,6}$/.test(retry) ? { "Retry-After": retry } : {});
        }
        throw new PlatformError(502, "upstream_error", `模型网关返回 HTTP ${upstream.status}`);
      }

      if (!stream || !(upstream.headers.get("content-type") ?? "").includes("text/event-stream")) {
        const text = await upstream.text().finally(() => clearTimeout(timer));
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
        record(task.id, task.lease_id as string, model, effort, upstream.status, startedAt, usageOf(parsed));
        reply.code(upstream.status).header("Content-Type", "application/json; charset=utf-8").header("Cache-Control", "no-store");
        await reply.send(ctx.redactor.redactText(text));
        return;
      }

      // 流式：原样转发 SSE 字节，同时从 data 行里取出最后的 usage。
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(upstream.status, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
      raw.on("close", () => controller.abort());
      let usage: Usage | null = null;
      let pending = "";
      const decoder = new TextDecoder();
      const reader = upstream.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          raw.write(value);
          pending += decoder.decode(value, { stream: true });
          let newline = pending.indexOf("\n");
          while (newline >= 0) {
            const line = pending.slice(0, newline).trim();
            pending = pending.slice(newline + 1);
            if (line.startsWith("data:") && line !== "data: [DONE]") {
              try {
                usage = usageOf(JSON.parse(line.slice(5))) ?? usage;
              } catch {
                // 不完整或非 JSON 的 data 行只转发，不参与记账。
              }
            }
            newline = pending.indexOf("\n");
          }
        }
      } catch {
        // 节点断开或网关中断：已发出的字节无法撤回，按已知用量记账。
      } finally {
        clearTimeout(timer);
        record(task.id, task.lease_id as string, model, effort, upstream.status, startedAt, usage);
        raw.end();
      }
    },
  };
}
