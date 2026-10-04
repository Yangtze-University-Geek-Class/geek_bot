/** 管理员名单、邀请与移除（A-09…A-11）：邀请与移除只归 owner 并要求 10 分钟内重新认证。 */
import type { FastifyInstance } from "fastify";
import { idempotencyKeyOf, parseLimit } from "../../../platform/http.js";
import type { PlatformServices } from "../../../platform/registry.js";
import { sessionOf, type RouteAccess } from "../../../platform/security.js";
import { INVITE_SCHEMA, LIST_SCHEMA, REMOVE_SCHEMA, type InviteBody, type ListQuery, type RemoveParams } from "./contracts.js";

export function registerAdminRoutes(app: FastifyInstance, { admins, ctx }: PlatformServices): void {
  app.get("/api/v1/admins", { schema: LIST_SCHEMA, config: { access: "viewer" } satisfies RouteAccess }, async request => {
    const query = request.query as ListQuery;
    return admins.list({ limit: parseLimit(query.limit), cursor: query.cursor });
  });

  app.post("/api/v1/admins", { schema: INVITE_SCHEMA, config: { access: "owner", reauth: true } satisfies RouteAccess }, async (request, reply) => {
    const session = sessionOf(request);
    const body = request.body as InviteBody;
    const result = ctx.idempotency.run(session.githubId, "POST /api/v1/admins", idempotencyKeyOf(request), body, () => admins.invite(session, body));
    return reply.code(result.status).send(result.body);
  });

  app.delete("/api/v1/admins/:github_id", { schema: REMOVE_SCHEMA, config: { access: "owner", reauth: true } satisfies RouteAccess }, async (request, reply) => {
    const params = request.params as RemoveParams;
    admins.remove(sessionOf(request), Number(params.github_id));
    return reply.code(204).send();
  });
}
