/**
 * Fastify 组装（MODULAR-DEVELOPMENT「control 内部的计划分层」）：日志、请求 id、错误格式、入参校验的全局设置，
 * 然后注册各路由模块。这里不监听端口（src/index.ts 负责），测试用 inject 直接调用。
 *
 * - 日志用 src/log/logger.ts 的结构化日志（整条打码）；Fastify 自己的请求日志关闭，改由 onResponse 记一行，
 *   路径去掉查询串（API.md A-06：code 这类查询参数不落日志）。
 * - 请求 id 由服务端生成（不信任请求头），每个响应都带 X-Request-Id。
 * - 错误一律是 API.md 的 { error: { code, message } }；未预期的错误只回「内部错误」和请求 id。
 * - Ajv 设 removeAdditional: false：多余字段报 400，不静默删除（API.md「入参校验」）。
 * - 请求体上限 64 KB；只接受 application/json 的请求体（去掉 Fastify 默认的 text/plain 解析器）。
 */
import { randomUUID } from "node:crypto";
import Fastify, { LogController, type FastifyBaseLogger, type FastifyError } from "fastify";
import { errorBody } from "./http/errors.js";
import type { Logger } from "./log/logger.js";
import { registerHealthRoutes, type Readiness } from "./routes/health/index.js";

export const BODY_LIMIT_BYTES = 64 * 1024;

export interface AppOptions {
  readonly logger: Logger;
  readonly readiness: Readiness;
  /** 正在停机时返回 true：新请求一律 503 not_ready。 */
  readonly shuttingDown: () => boolean;
}

interface ValidationIssue {
  readonly instancePath?: string;
  readonly keyword?: string;
  readonly params?: Record<string, unknown>;
}

/** 校验失败的说明：只写字段路径和原因，不回显请求里的值。 */
function describeValidation(context: string | undefined, issue: ValidationIssue | undefined): string {
  const part = context === "body" ? "请求体" : context === "querystring" ? "查询参数" : context === "params" ? "路径参数" : context === "headers" ? "请求头" : "请求";
  if (!issue) return `${part}不符合约定`;
  const path = issue.instancePath || "/";
  const name = (key: string) => String(issue.params?.[key] ?? "").slice(0, 64);
  switch (issue.keyword) {
    case "additionalProperties":
      return `${part}里有不认识的字段：${path === "/" ? "" : path}/${name("additionalProperty")}`;
    case "required":
      return `${part}缺少必填字段：${path === "/" ? "" : path}/${name("missingProperty")}`;
    case "type":
      return `${part}的字段类型不对：${path}`;
    case "enum":
      return `${part}的字段取值不在允许范围内：${path}`;
    default:
      return `${part}的字段不符合约定（${issue.keyword ?? "未知规则"}）：${path}`;
  }
}

export function buildApp(options: AppOptions) {
  const app = Fastify({
    // 自带的 Logger 满足 Fastify 的 logger 接口；按基础接口传入，路由模块照常用 FastifyInstance 的默认类型。
    loggerInstance: options.logger as FastifyBaseLogger,
    logController: new LogController({ disableRequestLogging: true }),
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    bodyLimit: BODY_LIMIT_BYTES,
    return503OnClosing: false,
    ajv: { customOptions: { removeAdditional: false, allErrors: false } },
  });

  app.removeContentTypeParser("text/plain");

  app.addHook("onRequest", async (_request, reply) => {
    if (options.shuttingDown()) return reply.code(503).send(errorBody("not_ready", "control 正在停机"));
  });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("X-Request-Id", request.id);
    return payload;
  });

  app.addHook("onResponse", async (request, reply) => {
    const quiet = (request.routeOptions.config as { quietLog?: boolean } | undefined)?.quietLog === true;
    if (quiet && reply.statusCode < 400) return;
    const path = request.url.split("?", 1)[0];
    const fields = { method: request.method, path, status: reply.statusCode, duration_ms: Math.round(reply.elapsedTime) };
    if (reply.statusCode >= 500) request.log.warn(fields, "请求完成");
    else request.log.info(fields, "请求完成");
  });

  app.setNotFoundHandler(async (_request, reply) => reply.code(404).send(errorBody("not_found", "没有这个接口")));

  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    if (error.validation) {
      return reply.code(400).send(errorBody("validation_failed", describeValidation(error.validationContext, error.validation[0] as ValidationIssue | undefined)));
    }
    switch (error.code) {
      case "FST_ERR_CTP_INVALID_MEDIA_TYPE":
        return reply.code(415).send(errorBody("unsupported_media_type", "请求体必须是 application/json"));
      case "FST_ERR_CTP_BODY_TOO_LARGE":
        return reply.code(413).send(errorBody("payload_too_large", `请求体超过 ${BODY_LIMIT_BYTES / 1024} KB`));
      case "FST_ERR_CTP_EMPTY_JSON_BODY":
      case "FST_ERR_CTP_INVALID_JSON_BODY":
        return reply.code(400).send(errorBody("invalid_json", "请求体不是合法的 JSON"));
    }
    if (error instanceof SyntaxError && error.statusCode === 400) return reply.code(400).send(errorBody("invalid_json", "请求体不是合法的 JSON"));
    const status = error.statusCode ?? 500;
    if (status >= 400 && status < 500) return reply.code(status).send(errorBody("bad_request", "请求不合法"));
    request.log.error({ err: error }, "未预期的错误");
    return reply.code(500).send(errorBody("internal_error", `内部错误（请求 id ${request.id}）`));
  });

  registerHealthRoutes(app, options.readiness);
  return app;
}

export type ControlApp = ReturnType<typeof buildApp>;
