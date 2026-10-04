/**
 * 需求：列表、创建、详情、编辑（If-Match）、派发；以及 Feishu 原生事件回调与通用签名 webhook 入站。
 * 入站回调保留原始字节交给 IM 适配器验签（签名覆盖的是原文，不是重新序列化的 JSON）。
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { etag, idempotencyKeyOf, parseLimit, PlatformError, requireIfMatch } from "../../../platform/http.js";
import type { PlatformServices } from "../../../platform/registry.js";
import { sessionOf, type RouteAccess } from "../../../platform/security.js";
import { CREATE_SCHEMA, DISPATCH_SCHEMA, GET_SCHEMA, INTAKE_SCHEMA, LIST_SCHEMA, PATCH_SCHEMA, type CreateBody, type DispatchBody, type IdParams, type IntakeParams, type ListQuery, type PatchBody } from "./contracts.js";

const INTAKE_BODY_LIMIT = 256 * 1024;

export function registerDemandRoutes(app: FastifyInstance, { demands, tasks, ctx }: PlatformServices): void {
  app.get("/api/v1/demands", { schema: LIST_SCHEMA, config: { access: "viewer" } satisfies RouteAccess }, async request => {
    const query = request.query as ListQuery;
    return demands.list({ limit: parseLimit(query.limit), cursor: query.cursor, status: query.status, project_id: query.project_id });
  });

  app.post("/api/v1/demands", { schema: CREATE_SCHEMA, config: { access: "operator" } satisfies RouteAccess }, async (request, reply) => {
    const session = sessionOf(request);
    const body = request.body as CreateBody;
    const result = ctx.idempotency.run(session.githubId, "POST /api/v1/demands", idempotencyKeyOf(request), body, () => ({ status: 201, body: demands.create(session, body) }));
    return reply.code(result.status).send(result.body);
  });

  app.get("/api/v1/demands/:id", { schema: GET_SCHEMA, config: { access: "viewer" } satisfies RouteAccess }, async (request, reply) => {
    const record = demands.get((request.params as IdParams).id);
    reply.header("ETag", etag(record.revision));
    return record;
  });

  app.patch("/api/v1/demands/:id", { schema: PATCH_SCHEMA, config: { access: "operator" } satisfies RouteAccess }, async (request, reply) => {
    const record = demands.update(sessionOf(request), (request.params as IdParams).id, request.body as PatchBody, revision => requireIfMatch(request, revision));
    reply.header("ETag", etag(record.revision));
    return record;
  });

  app.post("/api/v1/demands/:id/dispatch", { schema: DISPATCH_SCHEMA, config: { access: "operator" } satisfies RouteAccess }, async (request, reply) => {
    const session = sessionOf(request);
    const { id } = request.params as IdParams;
    const body = request.body as DispatchBody;
    const result = await ctx.idempotency.runAsync(session.githubId, `POST /api/v1/demands/${id}/dispatch`, idempotencyKeyOf(request), body, async () => ({
      status: 201,
      body: await tasks.dispatch(session, id, body),
    }));
    return reply.code(result.status).send(result.body);
  });

  // IM 入站：独立作用域里换成保留原始字节的 JSON 解析器。
  void app.register(async scope => {
    const raw = new WeakMap<FastifyRequest, Buffer>();
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: INTAKE_BODY_LIMIT }, (request, body, done) => {
      const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
      raw.set(request, buffer);
      try {
        done(null, buffer.length === 0 ? {} : (JSON.parse(buffer.toString("utf8")) as unknown));
      } catch {
        done(new PlatformError(400, "invalid_json", "请求体不是合法的 JSON"), undefined);
      }
    });
    const config: RouteAccess = { access: "public", signedCallback: true };
    for (const provider of ["feishu", "webhook"] as const) {
      scope.post(`/api/v1/intake/${provider}/:connection_id`, { schema: INTAKE_SCHEMA, config, bodyLimit: INTAKE_BODY_LIMIT }, async (request, reply) => {
        const params = request.params as IntakeParams;
        const result = await demands.intake(provider, params.connection_id, request.headers, request.body, raw.get(request) ?? Buffer.alloc(0));
        return reply.code(result.status).send(result.body);
      });
    }
  });
}
