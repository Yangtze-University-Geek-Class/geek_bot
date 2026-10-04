/**
 * 同源托管 console（ADR-0009）与 A-55 `/api/release`。
 * 静态文件同样校验 Host（防 DNS 重绑定）；API 前缀下没有匹配的路径一律 JSON 404，不回落到 index.html。
 */
import type { FastifyInstance } from "fastify";
import { NODE_PROTOCOL_VERSION } from "@geek-bot/protocol";
import { errorBody } from "../../../http/errors.js";
import { PROTOCOL_RANGE } from "../../../platform/machines.js";
import type { PlatformServices } from "../../../platform/registry.js";
import { responses } from "../../../platform/schemas.js";
import { checkHost } from "../../../platform/security.js";

const RELEASE_SCHEMA = {
  response: responses({
    200: {
      type: "object", additionalProperties: false, required: ["display", "version", "commit", "protocol_version", "protocol_range"],
      properties: {
        display: { type: "string" }, version: { type: "string" }, commit: { type: "string" }, protocol_version: { type: "integer" },
        protocol_range: { type: "object", additionalProperties: false, required: ["min", "max"], properties: { min: { type: "integer" }, max: { type: "integer" } } },
      },
    },
  }),
};

export function registerConsoleRoutes(app: FastifyInstance, { ctx, assets }: PlatformServices): void {
  void app.register(async scope => {
    scope.addHook("onRequest", async (request, reply) => {
      reply.header("X-Content-Type-Options", "nosniff");
      checkHost(ctx, request);
    });

    scope.get("/api/release", { schema: RELEASE_SCHEMA }, async () => ({
      display: ctx.config.release.display,
      version: ctx.config.release.version,
      commit: ctx.config.release.commit,
      protocol_version: NODE_PROTOCOL_VERSION,
      protocol_range: { min: PROTOCOL_RANGE.min, max: PROTOCOL_RANGE.max },
    }));

    scope.get("/*", async (request, reply) => {
      const path = request.url.split("?", 1)[0] ?? "/";
      if (path === "/api" || path.startsWith("/api/")) return reply.code(404).send(errorBody("not_found", "没有这个接口"));
      const served = assets.serve(path, reply);
      if (served) return served;
      return reply.code(404).send(errorBody("not_found", assets.available ? "没有这个文件" : "这个实例没有托管 console 的构建产物"));
    });
  });
}
