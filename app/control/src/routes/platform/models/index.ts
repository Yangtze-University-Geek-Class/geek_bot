/** 概览计数（A-35）与模型池（A-46、A-47）：目录只读 catalog 文件，池按任务类型保存，PATCH 要 If-Match。 */
import type { FastifyInstance } from "fastify";
import { etag, requireIfMatch } from "../../../platform/http.js";
import { computeOverview } from "../../../platform/overview.js";
import type { PlatformServices } from "../../../platform/registry.js";
import { sessionOf, type RouteAccess } from "../../../platform/security.js";
import { GET_SCHEMA, OVERVIEW_SCHEMA, PATCH_SCHEMA, type KindParams, type PatchBody } from "./contracts.js";

export function registerModelRoutes(app: FastifyInstance, { models, ctx }: PlatformServices): void {
  app.get("/api/v1/overview", { schema: OVERVIEW_SCHEMA, config: { access: "viewer" } satisfies RouteAccess }, async () => computeOverview(ctx.db));

  app.get("/api/v1/model-pools", { schema: GET_SCHEMA, config: { access: "viewer" } satisfies RouteAccess }, async () => models.pools());

  app.patch("/api/v1/model-pools/:kind", { schema: PATCH_SCHEMA, config: { access: "operator" } satisfies RouteAccess }, async (request, reply) => {
    const { kind } = request.params as KindParams;
    const pool = models.updatePool(sessionOf(request), kind, (request.body as PatchBody).entries, revision => requireIfMatch(request, revision));
    reply.header("ETag", etag(pool.revision));
    return pool;
  });
}
