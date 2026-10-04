/**
 * A-56 实时推送（API.md「SSE」）：会话鉴权；topics 最多 20 个；Last-Event-ID 从环形缓冲补发，补不了发 reset；
 * 每 15 秒心跳注释并复核会话，会话失效发 session_expired 后关闭。事件里只有公共记录，已打码。
 */
import type { FastifyInstance } from "fastify";
import { COOKIE_SESSION } from "../../../platform/auth.js";
import { STREAM_TOPICS_FIXED, type BusEvent } from "../../../platform/events.js";
import { parseCookies, PlatformError } from "../../../platform/http.js";
import type { PlatformServices } from "../../../platform/registry.js";
import type { RouteAccess } from "../../../platform/security.js";

const MAX_TOPICS = 20;
const PING_MS = 15_000;
const TASK_TOPIC = /^task:[A-Za-z0-9_-]{1,80}$/;

export interface StreamQuery { readonly topics: string }
export const STREAM_SCHEMA = {
  querystring: { type: "object", additionalProperties: false, required: ["topics"], properties: { topics: { type: "string", minLength: 1, maxLength: 2000 } } },
};

export function registerStreamRoutes(app: FastifyInstance, { ctx, auth }: PlatformServices): void {
  const fixed = new Set<string>(STREAM_TOPICS_FIXED);
  const open = new Set<{ end(): void }>();
  // 停机时先结束长连接，否则 server.close 会一直等它们。
  app.addHook("preClose", async () => {
    for (const stream of open) stream.end();
  });

  app.get("/api/v1/stream", { schema: STREAM_SCHEMA, config: { access: "viewer" } satisfies RouteAccess }, async (request, reply) => {
    const topics = (request.query as StreamQuery).topics.split(",").map(topic => topic.trim()).filter(Boolean);
    if (topics.length === 0 || topics.length > MAX_TOPICS) throw new PlatformError(400, "validation_failed", `topics 需要 1 到 ${MAX_TOPICS} 个`);
    for (const topic of topics) if (!fixed.has(topic) && !TASK_TOPIC.test(topic)) throw new PlatformError(400, "validation_failed", "topics 里有不认识的 topic");
    const wanted = new Set(topics);
    const lastHeader = request.headers["last-event-id"];
    const lastId = typeof lastHeader === "string" && /^[0-9]{1,15}$/.test(lastHeader) ? Number(lastHeader) : null;
    const cookie = parseCookies(request.headers.cookie).get(COOKIE_SESSION);

    reply.hijack();
    const raw = reply.raw;
    open.add(raw);
    raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
      "X-Request-Id": request.id,
      Connection: "keep-alive",
    });
    raw.write("retry: 5000\n\n");
    const write = (event: BusEvent) => {
      if (event.topics.some(topic => wanted.has(topic))) raw.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${event.data}\n\n`);
    };
    if (lastId !== null) {
      const missed = ctx.bus.since(lastId);
      if (missed === null) raw.write("event: reset\ndata: {}\n\n");
      else for (const event of missed) write(event);
    }
    const unsubscribe = ctx.bus.subscribe(write);
    const timer = setInterval(() => {
      if (auth.authenticate(cookie) === null) {
        raw.write("event: session_expired\ndata: {}\n\n");
        raw.end();
        return;
      }
      raw.write(": ping\n\n");
    }, PING_MS);
    timer.unref();
    raw.on("close", () => {
      clearInterval(timer);
      unsubscribe();
      open.delete(raw);
    });
  });
}
