/**
 * 健康检查路由（API.md A-53、A-54）。只做 HTTP 映射：检查逻辑由组装处传入的 Readiness 提供。
 * - GET /healthz：进程活着就 200，不检查依赖；
 * - GET /readyz：全部检查通过 200，否则 503 not_ready，message 里列出没通过的检查项名称。部署脚本的健康门与镜像的 HEALTHCHECK 都用它。
 */
import type { FastifyInstance } from "fastify";
import { errorBody } from "../../http/errors.js";
import { HEALTHZ_SCHEMA, READYZ_SCHEMA, type ReadinessCheck } from "./contracts.js";

export interface Readiness {
  /** 没通过的检查项，按 READINESS_CHECKS 的顺序；全部通过时为空。 */
  failedChecks(): ReadinessCheck[];
}

/** 这两个端点每隔几秒就被探测一次：成功的请求不写访问日志。 */
export const QUIET_ROUTE = Object.freeze({ quietLog: true });

export function registerHealthRoutes(app: FastifyInstance, readiness: Readiness): void {
  app.get("/healthz", { schema: HEALTHZ_SCHEMA, config: QUIET_ROUTE }, async () => ({ status: "ok" as const }));

  app.get("/readyz", { schema: READYZ_SCHEMA, config: QUIET_ROUTE }, async (_request, reply) => {
    const failed = readiness.failedChecks();
    if (failed.length === 0) return { status: "ready" as const };
    return reply.code(503).send(errorBody("not_ready", `未就绪，没通过的检查项：${failed.join("、")}`));
  });
}
