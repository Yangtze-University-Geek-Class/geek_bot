/** 任务端点的输入输出协议。 */
import type { TaskStatus } from "@geek-bot/protocol";
import { EMPTY_BODY, ID_PARAMS, LIST_QUERY_PROPS, listOf, responses, TASK_EVENT_OUT, TASK_OUT } from "../../../platform/schemas.js";

const OPAQUE_ID = { type: "string", minLength: 1, maxLength: 80, pattern: "^[A-Za-z0-9_-]+$" } as const;

export interface ListQuery { readonly limit?: string; readonly cursor?: string; readonly status?: TaskStatus; readonly project_id?: string; readonly demand_id?: string }
export const LIST_SCHEMA = {
  querystring: {
    type: "object", additionalProperties: false,
    properties: {
      ...LIST_QUERY_PROPS,
      status: { enum: ["queued", "running", "awaiting_publish", "completed", "failed", "cancelled", "superseded"] },
      project_id: OPAQUE_ID,
      demand_id: OPAQUE_ID,
    },
  },
  response: responses({ 200: listOf(TASK_OUT) }),
};

export interface IdParams { readonly id: string }
export const GET_SCHEMA = { params: ID_PARAMS, response: responses({ 200: TASK_OUT }) };

export interface EventsQuery { readonly limit?: string; readonly cursor?: string }
export const EVENTS_SCHEMA = {
  params: ID_PARAMS,
  querystring: { type: "object", additionalProperties: false, properties: LIST_QUERY_PROPS },
  response: responses({ 200: listOf(TASK_EVENT_OUT) }),
};

export const ACTION_SCHEMA = { params: ID_PARAMS, body: EMPTY_BODY, response: responses({ 200: TASK_OUT }) };
