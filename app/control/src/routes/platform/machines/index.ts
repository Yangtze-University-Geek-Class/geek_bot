/**
 * 机器：列表、登记（owner 重新认证，响应带一次性节点令牌）、详情、属性（If-Match；信任等级调到 high 要重新认证）、
 * cordon / uncordon / drain（owner、operator）、重置令牌（owner 重新认证，一次性）。
 */
import type { FastifyInstance } from "fastify";
import { etag, idempotencyKeyOf, parseLimit, requireIfMatch } from "../../../platform/http.js";
import type { PlatformServices } from "../../../platform/registry.js";
import { sessionOf, type RouteAccess } from "../../../platform/security.js";
import { ACTION_SCHEMA, CREATE_SCHEMA, GET_SCHEMA, LIST_SCHEMA, PATCH_SCHEMA, RESET_SCHEMA, type CreateBody, type IdParams, type ListQuery, type PatchBody } from "./contracts.js";

export function registerMachineRoutes(app: FastifyInstance, { machines, auth, ctx }: PlatformServices): void {
  app.get("/api/v1/machines", { schema: LIST_SCHEMA, config: { access: "viewer" } satisfies RouteAccess }, async request => {
    const query = request.query as ListQuery;
    return machines.list({ limit: parseLimit(query.limit), cursor: query.cursor });
  });

  app.post("/api/v1/machines", { schema: CREATE_SCHEMA, config: { access: "owner", reauth: true } satisfies RouteAccess }, async (request, reply) => {
    const session = sessionOf(request);
    const body = request.body as CreateBody;
    const result = ctx.idempotency.run(session.githubId, "POST /api/v1/machines", idempotencyKeyOf(request), body, () => machines.create(session, body));
    return reply.code(result.status).header("Cache-Control", "no-store").send(result.body);
  });

  app.get("/api/v1/machines/:id", { schema: GET_SCHEMA, config: { access: "viewer" } satisfies RouteAccess }, async (request, reply) => {
    const record = machines.get((request.params as IdParams).id);
    reply.header("ETag", etag(record.revision));
    return record;
  });

  app.patch("/api/v1/machines/:id", { schema: PATCH_SCHEMA, config: { access: "owner" } satisfies RouteAccess }, async (request, reply) => {
    const session = sessionOf(request);
    const record = machines.update(session, (request.params as IdParams).id, request.body as PatchBody, revision => requireIfMatch(request, revision), auth.reauthValid(session));
    reply.header("ETag", etag(record.revision));
    return record;
  });

  for (const action of ["cordon", "uncordon", "drain"] as const) {
    app.post(`/api/v1/machines/:id/${action}`, { schema: ACTION_SCHEMA, config: { access: "operator" } satisfies RouteAccess }, async request =>
      machines.transition(sessionOf(request), (request.params as IdParams).id, action),
    );
  }

  app.post("/api/v1/machines/:id/reset-token", { schema: RESET_SCHEMA, config: { access: "owner", reauth: true } satisfies RouteAccess }, async (request, reply) => {
    const session = sessionOf(request);
    const { id } = request.params as IdParams;
    const result = ctx.idempotency.run(session.githubId, `POST /api/v1/machines/${id}/reset-token`, idempotencyKeyOf(request), {}, () => machines.resetToken(session, id));
    return reply.code(result.status).header("Cache-Control", "no-store").send(result.body);
  });
}
