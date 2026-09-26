/**
 * 后台 API 的错误格式（docs/architecture/API.md「错误格式」）：所有错误只有 code 与 message 两个字段。
 * code 是稳定的 snake_case 标识；message 是给人看的中文，不含密钥、堆栈、SQL、内部路径，也不回显请求体里的原始值。
 */
import type { ApiErrorBody } from "@geek-bot/protocol";

/** 错误响应的 JSON Schema：各路由的 response 声明都引用它，作为序列化白名单（Fastify 会在 schema 对象上做标记，不冻结）。 */
export const ERROR_BODY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["error"],
  properties: {
    error: {
      type: "object",
      additionalProperties: false,
      required: ["code", "message"],
      properties: { code: { type: "string" }, message: { type: "string" } },
    },
  },
};

export function errorBody(code: string, message: string): ApiErrorBody {
  return { error: { code, message } };
}
