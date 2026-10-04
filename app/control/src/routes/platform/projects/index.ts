/**
 * 项目：列表（按连接与名称筛选）、详情、设置（If-Match；调高写入模式或打开任务开关要 owner 重新认证）、条目、
 * 按条目派发任务（幂等）、同步。
 */
import type { FastifyInstance } from "fastify";
import { etag, idempotencyKeyOf, parseLimit, requireIfMatch } from "../../../platform/http.js";
import type { PlatformServices } from "../../../platform/registry.js";
import { sessionOf, type RouteAccess } from "../../../platform/security.js";
import {
  GET_SCHEMA,
  ITEM_DISPATCH_SCHEMA,
  ITEMS_SCHEMA,
  LIST_SCHEMA,
  PATCH_SCHEMA,
  SYNC_SCHEMA,
  type IdParams,
  type ItemDispatchBody,
  type ItemParams,
  type ItemsQuery,
  type ListQuery,
  type PatchBody,
} from "./contracts.js";

export function registerProjectRoutes(app: FastifyInstance, { connections, tasks, auth, ctx }: PlatformServices): void {
  app.get("/api/v1/projects", { schema: LIST_SCHEMA, config: { access: "viewer" } satisfies RouteAccess }, async request => {
    const query = request.query as ListQuery;
    return connections.listProjects({ limit: parseLimit(query.limit), cursor: query.cursor, connection_id: query.connection_id, search: query.search });
  });

  app.get("/api/v1/projects/:id", { schema: GET_SCHEMA, config: { access: "viewer" } satisfies RouteAccess }, async (request, reply) => {
    const record = connections.getProject((request.params as IdParams).id);
    reply.header("ETag", etag(record.revision));
    return record;
  });

  app.patch("/api/v1/projects/:id", { schema: PATCH_SCHEMA, config: { access: "operator" } satisfies RouteAccess }, async (request, reply) => {
    const session = sessionOf(request);
    const record = connections.updateProject(session, (request.params as IdParams).id, request.body as PatchBody, revision => requireIfMatch(request, revision), auth.reauthValid(session));
    reply.header("ETag", etag(record.revision));
    return record;
  });

  app.get("/api/v1/projects/:id/items", { schema: ITEMS_SCHEMA, config: { access: "viewer" } satisfies RouteAccess }, async request => {
    const query = request.query as ItemsQuery;
    return connections.listItems((request.params as IdParams).id, { limit: parseLimit(query.limit), cursor: query.cursor, kind: query.kind });
  });

  app.post("/api/v1/projects/:id/items/:item_id/dispatch", { schema: ITEM_DISPATCH_SCHEMA, config: { access: "operator" } satisfies RouteAccess }, async (request, reply) => {
    const session = sessionOf(request);
    const params = request.params as ItemParams;
    const body = request.body as ItemDispatchBody;
    const result = await ctx.idempotency.runAsync(session.githubId, `POST /api/v1/projects/${params.id}/items/${params.item_id}/dispatch`, idempotencyKeyOf(request), body, async () => ({
      status: 201,
      body: await tasks.dispatchItem(session, params.id, params.item_id, body),
    }));
    return reply.code(result.status).send(result.body);
  });

  app.post("/api/v1/projects/:id/sync", { schema: SYNC_SCHEMA, config: { access: "operator" } satisfies RouteAccess }, async request =>
    connections.syncProject({ type: "user", id: String(sessionOf(request).githubId) }, (request.params as IdParams).id),
  );
}
