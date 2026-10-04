/** 需求端点与 IM 入站回调的输入输出协议。 */
import type { DemandStatus, Executor, ModelPoolEntry, ResourceBudget, TaskKind } from "@geek-bot/protocol";
import { DEMAND_OUT, dispatchBodySchema, ID_PARAMS, LIST_QUERY_PROPS, listOf, responses, TASK_OUT } from "../../../platform/schemas.js";

const OPAQUE_ID = { type: "string", minLength: 1, maxLength: 80, pattern: "^[A-Za-z0-9_-]+$" } as const;
const TITLE = { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" } as const;
const BODY = { type: "string", maxLength: 20000 } as const;

export interface ListQuery { readonly limit?: string; readonly cursor?: string; readonly status?: DemandStatus; readonly project_id?: string }
export const LIST_SCHEMA = {
  querystring: {
    type: "object", additionalProperties: false,
    properties: { ...LIST_QUERY_PROPS, status: { enum: ["new", "blocked", "queued", "running", "completed", "failed"] }, project_id: OPAQUE_ID },
  },
  response: responses({ 200: listOf(DEMAND_OUT) }),
};

export interface CreateBody { readonly title: string; readonly body: string; readonly project_id?: string }
export const CREATE_SCHEMA = {
  body: { type: "object", additionalProperties: false, required: ["title", "body"], properties: { title: TITLE, body: BODY, project_id: OPAQUE_ID } },
  response: responses({ 201: DEMAND_OUT, 200: DEMAND_OUT }),
};

export interface IdParams { readonly id: string }
export const GET_SCHEMA = { params: ID_PARAMS, response: responses({ 200: DEMAND_OUT }) };

export interface PatchBody { readonly title?: string; readonly body?: string; readonly project_id?: string | null }
export const PATCH_SCHEMA = {
  params: ID_PARAMS,
  body: { type: "object", additionalProperties: false, minProperties: 1, properties: { title: TITLE, body: BODY, project_id: { anyOf: [OPAQUE_ID, { type: "null" }] } } },
  response: responses({ 200: DEMAND_OUT }),
};

export interface DispatchBody { readonly kind: TaskKind; readonly executor: Executor; readonly resources?: ResourceBudget; readonly model_pool?: ModelPoolEntry[] }
export const DISPATCH_SCHEMA = {
  params: ID_PARAMS,
  body: dispatchBodySchema(),
  response: responses({ 201: TASK_OUT, 200: TASK_OUT }),
};

export interface IntakeParams { readonly connection_id: string }
export const INTAKE_SCHEMA = {
  params: { type: "object", additionalProperties: false, required: ["connection_id"], properties: { connection_id: OPAQUE_ID } },
};
