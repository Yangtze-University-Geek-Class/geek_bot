/** 平台连接：列表、创建（owner 重新认证）、详情、配置更新（If-Match）、发现、同步、停用。 */
import type { FastifyInstance } from "fastify";
import { etag, idempotencyKeyOf, parseLimit, requireIfMatch } from "../../../platform/http.js";
import type { PlatformServices } from "../../../platform/registry.js";
import { requireReauth, sessionOf, type RouteAccess } from "../../../platform/security.js";
import { ACTION_SCHEMA, CREATE_SCHEMA, DISCOVER_SCHEMA, GET_SCHEMA, LIST_SCHEMA, PATCH_SCHEMA, SYNC_SCHEMA, type CreateBody, type IdParams, type ListQuery, type PatchBody } from "./contracts.js";

export function registerConnectionRoutes(app: FastifyInstance, { connections, auth, ctx }: PlatformServices): void {
  app.get("/api/v1/connections", { schema: LIST_SCHEMA, config: { access: "viewer" } satisfies RouteAccess }, async request => {
    const query = request.query as ListQuery;
    return connections.list({ limit: parseLimit(query.limit), cursor: query.cursor });
  });

  app.post("/api/v1/connections", { schema: CREATE_SCHEMA, config: { access: "owner", reauth: true } satisfies RouteAccess }, async (request, reply) => {
    const session = sessionOf(request);
    const body = request.body as CreateBody;
    // 幂等记录里不保存凭据原文：请求体哈希只用于判断同 key 是否同内容。
    const result = ctx.idempotency.run(session.githubId, "POST /api/v1/connections", idempotencyKeyOf(request), body, () => ({ status: 201, body: connections.create(session, body) }));
    return reply.code(result.status).send(result.body);
  });

  app.get("/api/v1/connections/:id", { schema: GET_SCHEMA, config: { access: "viewer" } satisfies RouteAccess }, async (request, reply) => {
    const record = connections.get((request.params as IdParams).id);
    reply.header("ETag", etag(record.revision));
    return record;
  });

  app.patch("/api/v1/connections/:id", { schema: PATCH_SCHEMA, config: { access: "owner" } satisfies RouteAccess }, async (request, reply) => {
    const session = sessionOf(request);
    const body = request.body as PatchBody;
    if (connections.updateNeedsReauth(body)) requireReauth(auth, session);
    const record = connections.update(session, (request.params as IdParams).id, body, revision => requireIfMatch(request, revision));
    reply.header("ETag", etag(record.revision));
    return record;
  });

  app.post("/api/v1/connections/:id/discover", { schema: DISCOVER_SCHEMA, config: { access: "operator" } satisfies RouteAccess }, async request =>
    connections.discover({ type: "user", id: String(sessionOf(request).githubId) }, (request.params as IdParams).id),
  );

  app.post("/api/v1/connections/:id/sync", { schema: SYNC_SCHEMA, config: { access: "operator" } satisfies RouteAccess }, async request =>
    connections.sync({ type: "user", id: String(sessionOf(request).githubId) }, (request.params as IdParams).id),
  );

  app.post("/api/v1/connections/:id/disable", { schema: ACTION_SCHEMA, config: { access: "operator" } satisfies RouteAccess }, async request =>
    connections.disable(sessionOf(request), (request.params as IdParams).id),
  );
}
