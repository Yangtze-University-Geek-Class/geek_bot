/** 机器端点的输入输出协议。node_token 只出现在登记与重置令牌的那一次响应里。 */
import { EXECUTOR_SLOTS_SCHEMA, RESOURCE_BUDGET_SCHEMA, type ExecutorSlots, type ResourceBudget } from "@geek-bot/protocol";
import { EMPTY_BODY, ID_PARAMS, LIST_QUERY_PROPS, listOf, MACHINE_OUT, MACHINE_SECRET_OUT, responses, TAGS_SCHEMA } from "../../../platform/schemas.js";

const NAME = { type: "string", minLength: 1, maxLength: 63, pattern: "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$" } as const;

export interface ListQuery { readonly limit?: string; readonly cursor?: string }
export const LIST_SCHEMA = {
  querystring: { type: "object", additionalProperties: false, properties: LIST_QUERY_PROPS },
  response: responses({ 200: listOf(MACHINE_OUT) }),
};

export interface CreateBody { readonly name: string; readonly trust: "standard" | "high"; readonly tags: string[]; readonly slots: ExecutorSlots; readonly capacity: ResourceBudget }
export const CREATE_SCHEMA = {
  body: {
    type: "object", additionalProperties: false, required: ["name", "trust", "tags", "slots", "capacity"],
    properties: { name: NAME, trust: { enum: ["standard", "high"] }, tags: TAGS_SCHEMA, slots: structuredClone(EXECUTOR_SLOTS_SCHEMA), capacity: structuredClone(RESOURCE_BUDGET_SCHEMA) },
  },
  response: responses({ 201: MACHINE_SECRET_OUT, 200: MACHINE_SECRET_OUT }),
};

export interface IdParams { readonly id: string }
export const GET_SCHEMA = { params: ID_PARAMS, response: responses({ 200: MACHINE_OUT }) };

export type PatchBody = Partial<CreateBody>;
export const PATCH_SCHEMA = {
  params: ID_PARAMS,
  body: {
    type: "object", additionalProperties: false, minProperties: 1,
    properties: { name: NAME, trust: { enum: ["standard", "high"] }, tags: TAGS_SCHEMA, slots: structuredClone(EXECUTOR_SLOTS_SCHEMA), capacity: structuredClone(RESOURCE_BUDGET_SCHEMA) },
  },
  response: responses({ 200: MACHINE_OUT }),
};

export const ACTION_SCHEMA = { params: ID_PARAMS, body: EMPTY_BODY, response: responses({ 200: MACHINE_OUT }) };
export const RESET_SCHEMA = { params: ID_PARAMS, body: EMPTY_BODY, response: responses({ 200: MACHINE_SECRET_OUT }) };
