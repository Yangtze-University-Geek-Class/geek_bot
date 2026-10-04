/** 项目与条目端点的输入输出协议。 */
import type { Executor, ModelPoolEntry, ResourceBudget, TaskKind, WriteMode } from "@geek-bot/protocol";
import { dispatchBodySchema, EMPTY_BODY, ID_PARAMS, ITEM_OUT, LIST_QUERY_PROPS, listOf, PROJECT_OUT, responses, TAGS_SCHEMA, TASK_OUT } from "../../../platform/schemas.js";

const OPAQUE_ID = { type: "string", minLength: 1, maxLength: 80, pattern: "^[A-Za-z0-9_-]+$" } as const;

export interface ListQuery { readonly limit?: string; readonly cursor?: string; readonly connection_id?: string; readonly search?: string }
export const LIST_SCHEMA = {
  querystring: { type: "object", additionalProperties: false, properties: { ...LIST_QUERY_PROPS, connection_id: OPAQUE_ID, search: { type: "string", maxLength: 200 } } },
  response: responses({ 200: listOf(PROJECT_OUT) }),
};

export interface IdParams { readonly id: string }
export const GET_SCHEMA = { params: ID_PARAMS, response: responses({ 200: PROJECT_OUT }) };

export interface PatchBody {
  readonly enabled?: boolean;
  readonly write_mode?: WriteMode;
  readonly review_enabled?: boolean;
  readonly triage_enabled?: boolean;
  readonly fix_enabled?: boolean;
  readonly rework_enabled?: boolean;
  readonly machine_ids?: string[];
  readonly tags?: string[];
}
export const PATCH_SCHEMA = {
  params: ID_PARAMS,
  body: {
    type: "object", additionalProperties: false, minProperties: 1,
    properties: {
      enabled: { type: "boolean" },
      write_mode: { enum: ["off", "dry_run", "on"] },
      review_enabled: { type: "boolean" },
      triage_enabled: { type: "boolean" },
      fix_enabled: { type: "boolean" },
      rework_enabled: { type: "boolean" },
      machine_ids: { type: "array", maxItems: 64, uniqueItems: true, items: OPAQUE_ID },
      tags: TAGS_SCHEMA,
    },
  },
  response: responses({ 200: PROJECT_OUT }),
};

export interface ItemsQuery { readonly limit?: string; readonly cursor?: string; readonly kind?: "issue" | "change" }
export const ITEMS_SCHEMA = {
  params: ID_PARAMS,
  querystring: { type: "object", additionalProperties: false, properties: { ...LIST_QUERY_PROPS, kind: { enum: ["issue", "change"] } } },
  response: responses({ 200: listOf(ITEM_OUT) }),
};

export interface ItemParams { readonly id: string; readonly item_id: string }
export interface ItemDispatchBody { readonly kind: TaskKind; readonly executor: Executor; readonly resources?: ResourceBudget; readonly model_pool?: ModelPoolEntry[] }
export const ITEM_DISPATCH_SCHEMA = {
  params: { type: "object", additionalProperties: false, required: ["id", "item_id"], properties: { id: OPAQUE_ID, item_id: OPAQUE_ID } },
  body: dispatchBodySchema(),
  response: responses({ 201: TASK_OUT, 200: TASK_OUT }),
};

export const SYNC_SCHEMA = {
  params: ID_PARAMS,
  body: EMPTY_BODY,
  response: responses({ 200: { type: "object", additionalProperties: false, required: ["items"], properties: { items: { type: "integer" } } } }),
};
