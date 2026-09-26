/**
 * 健康检查的契约（API.md A-53、A-54）：两个端点都公开、没有入参。
 * 响应的 JSON Schema 同时是序列化白名单：没声明的字段不会出现在响应里。
 */
import { ERROR_BODY_SCHEMA } from "../../http/errors.js";

/**
 * /readyz 的检查项，名字稳定，未就绪时按名字列出（不含路径和值）：
 * - database_writable：库打开着、能拿到写锁，库文件和所在目录可写；
 * - schema_compatible：库的兼容版本 K 不大于代码认识的最高迁移编号 C；
 * - migrations_applied：已执行的迁移 D 不小于 C（没有待执行的迁移）；
 * - secrets_readable：必需的密钥文件（master key、备份加密密钥）此刻可读；
 * - serving：没有在停机。
 */
export const READINESS_CHECKS = Object.freeze(["database_writable", "schema_compatible", "migrations_applied", "secrets_readable", "serving"] as const);
export type ReadinessCheck = (typeof READINESS_CHECKS)[number];

/** Fastify 会在 schema 对象上做标记，这里不冻结。 */
export const HEALTHZ_SCHEMA = {
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: { status: { type: "string", enum: ["ok"] } },
    },
  },
};

export const READYZ_SCHEMA = {
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: { status: { type: "string", enum: ["ready"] } },
    },
    503: ERROR_BODY_SCHEMA,
  },
};
