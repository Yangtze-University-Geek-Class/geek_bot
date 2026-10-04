/** 任务：列表（状态、项目、需求筛选）、详情、时间线、取消、重新排队（幂等）、发布（经 publisher）。 */
import type { FastifyInstance } from "fastify";
import { idempotencyKeyOf, parseLimit } from "../../../platform/http.js";
import type { PlatformServices } from "../../../platform/registry.js";
import { sessionOf, type RouteAccess } from "../../../platform/security.js";
import { ACTION_SCHEMA, EVENTS_SCHEMA, GET_SCHEMA, LIST_SCHEMA, type EventsQuery, type IdParams, type ListQuery } from "./contracts.js";

export function registerTaskRoutes(app: FastifyInstance, { tasks, ctx }: PlatformServices): void {
  app.get("/api/v1/tasks", { schema: LIST_SCHEMA, config: { access: "viewer" } satisfies RouteAccess }, async request => {
    const query = request.query as ListQuery;
    return tasks.list({ limit: parseLimit(query.limit), cursor: query.cursor, status: query.status, project_id: query.project_id, demand_id: query.demand_id });
  });

  app.get("/api/v1/tasks/:id", { schema: GET_SCHEMA, config: { access: "viewer" } satisfies RouteAccess }, async request => tasks.get((request.params as IdParams).id));

  app.get("/api/v1/tasks/:id/events", { schema: EVENTS_SCHEMA, config: { access: "viewer" } satisfies RouteAccess }, async request => {
    const query = request.query as EventsQuery;
    return tasks.events((request.params as IdParams).id, { limit: parseLimit(query.limit), cursor: query.cursor });
  });

  app.post("/api/v1/tasks/:id/cancel", { schema: ACTION_SCHEMA, config: { access: "operator" } satisfies RouteAccess }, async request =>
    tasks.cancel(sessionOf(request), (request.params as IdParams).id),
  );

  app.post("/api/v1/tasks/:id/requeue", { schema: ACTION_SCHEMA, config: { access: "operator" } satisfies RouteAccess }, async (request, reply) => {
    const session = sessionOf(request);
    const { id } = request.params as IdParams;
    const result = ctx.idempotency.run(session.githubId, `POST /api/v1/tasks/${id}/requeue`, idempotencyKeyOf(request), {}, () => ({ status: 200, body: tasks.requeue(session, id) }));
    return reply.code(result.status).send(result.body);
  });

  app.post("/api/v1/tasks/:id/publish", { schema: ACTION_SCHEMA, config: { access: "operator" } satisfies RouteAccess }, async request =>
    tasks.publish(sessionOf(request), (request.params as IdParams).id),
  );
}
