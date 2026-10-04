/**
 * 共享平台响应的 JSON Schema（API.md「入参校验」：响应 schema 是序列化白名单，没声明的字段不会出现在响应里）。
 * 与 records.ts 的序列化函数一一对应；各路由的 contracts.ts 引用这里，不各自复制。
 */
import { RESOURCE_BUDGET_SCHEMA } from "@geek-bot/protocol";
import { ERROR_BODY_SCHEMA } from "../http/errors.js";

const str = { type: "string" } as const;
const nstr = { type: ["string", "null"] } as const;
const int = { type: "integer" } as const;
const bool = { type: "boolean" } as const;
const strs = { type: "array", items: str } as const;

function object(properties: Record<string, unknown>): Record<string, unknown> {
  return { type: "object", additionalProperties: false, required: Object.keys(properties), properties };
}

export const RESOURCE_OUT = object({ cpu: int, memory_mib: int });
export const SLOTS_OUT = object({ sandbox: int, vm: int });

export const ADMIN_OUT = object({ github_id: int, login: str, role: str, invited_by: { type: ["integer", "null"] }, invited_at: str, last_login_at: nstr });
export const CONNECTION_OUT = object({
  id: str, provider: str, name: str, base_url: str, enabled: bool, status: str, account_name: nstr, capabilities: strs, secret_configured: bool, revision: int, created_at: str,
});
export const PROJECT_OUT = object({
  id: str, connection_id: str, external_id: str, name: str, path: str, url: str, default_branch: str, private: bool, archived: bool, permission: str,
  capabilities: strs, status: str, enabled: bool, write_mode: str, review_enabled: bool, triage_enabled: bool, fix_enabled: bool, rework_enabled: bool,
  machine_ids: strs, tags: strs, revision: int, updated_at: str,
});
const ACTIVE_TASK_OUT = {
  type: ["object", "null"], additionalProperties: false, required: ["id", "kind", "status"],
  properties: { id: str, kind: str, status: str },
} as const;
export const ITEM_OUT = object({
  id: str, project_id: str, external_id: str, kind: str, number: int, title: str, body: str, url: str, state: str, author: str, bot_authored: bool,
  head_sha: nstr, base_sha: nstr, updated_at: str, active_task: ACTIVE_TASK_OUT,
});
export const DEMAND_OUT = object({
  id: str, title: str, body: str, project_id: nstr, source: str, source_ref: str, source_connection_id: nstr, status: str, revision: int, created_by: { type: ["integer", "null"] }, created_at: str, updated_at: str,
});
export const MACHINE_OUT = object({
  id: str, name: str, status: str, trust: str, tags: strs, slots: SLOTS_OUT, capacity: RESOURCE_OUT,
  used: object({ cpu: int, memory_mib: int, sandbox: int, vm: int }), last_seen_at: nstr, revision: int,
});
const FINDING_OUT = object({ severity: str, path: str, line: int, message: str });
const RESULT_OUT = {
  type: ["object", "null"], additionalProperties: false, required: ["summary", "body"],
  properties: { summary: str, body: str, findings: { type: "array", items: FINDING_OUT }, patch: str },
} as const;
export const TASK_OUT = object({
  id: str, project_id: str, demand_id: nstr, item_id: nstr, kind: str, executor: str, status: str, priority: int, resources: RESOURCE_OUT, machine_id: nstr,
  epoch: int, lease_id: nstr, lease_expires_at: nstr, head_sha: nstr, base_sha: nstr, result: RESULT_OUT, error: nstr, created_at: str, updated_at: str,
});
export const TASK_EVENT_OUT = object({ seq: int, at: str, kind: str, text: str });
export const MACHINE_SECRET_OUT = object({ machine: MACHINE_OUT, node_token: str });

export function listOf(item: Record<string, unknown>): Record<string, unknown> {
  return object({ items: { type: "array", items: item }, next_cursor: nstr });
}

/** 一个端点的响应声明：成功体加全部错误码共用的错误体。 */
export function responses(success: Record<number, unknown>): Record<string, unknown> {
  return { ...success, "4xx": ERROR_BODY_SCHEMA, "5xx": ERROR_BODY_SCHEMA };
}

export const LIST_QUERY_PROPS = {
  limit: { type: "string", pattern: "^[0-9]{1,3}$" },
  cursor: { type: "string", maxLength: 512 },
} as const;

export const ID_PARAMS = { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string", minLength: 1, maxLength: 80, pattern: "^[A-Za-z0-9_-]+$" } } } as const;
export const EMPTY_BODY = { type: "object", additionalProperties: false, properties: {} } as const;
export const TAG_SCHEMA = { type: "string", minLength: 1, maxLength: 40, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" } as const;
export const TAGS_SCHEMA = { type: "array", maxItems: 32, uniqueItems: true, items: TAG_SCHEMA } as const;

/**
 * 派发任务的请求体（需求派发与条目派发共用）。每次返回新对象：Fastify 编译时会在 schema 上做标记，
 * protocol 里的 schema 是冻结对象，所以 resources 用副本。
 */
export function dispatchBodySchema(): Record<string, unknown> {
  return {
    type: "object", additionalProperties: false, required: ["kind", "executor"],
    properties: {
      kind: { enum: ["review", "triage", "followup", "fix", "rework"] },
      executor: { enum: ["sandbox", "vm"] },
      resources: structuredClone(RESOURCE_BUDGET_SCHEMA),
      model_pool: {
        type: "array", minItems: 1, maxItems: 8,
        items: { type: "object", additionalProperties: false, required: ["model", "effort"], properties: { model: { type: "string", minLength: 1, maxLength: 200 }, effort: { type: "string", minLength: 1, maxLength: 32 } } },
      },
    },
  };
}
