/** 节点 API（/api/node/v1）的输入协议：拒绝未知字段，长度都有上限。schema 来自 @geek-bot/protocol 的副本。 */
import { EXECUTOR_SLOTS_SCHEMA, LEASE_FENCE_SCHEMA, RESOURCE_BUDGET_SCHEMA, TASK_RESULT_SCHEMA } from "@geek-bot/protocol";
import { FAILURE_CODES } from "../../../platform/tasks.js";
import { TAGS_SCHEMA } from "../../../platform/schemas.js";

export const EVENTS_BODY_LIMIT = 256 * 1024;
export const RESULT_BODY_LIMIT = 1024 * 1024;

const LEASE_ID = { type: "string", minLength: 1, maxLength: 128 } as const;
const EPOCH = { type: "integer", minimum: 1 } as const;
export const TASK_PARAMS = { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string", minLength: 1, maxLength: 80, pattern: "^[A-Za-z0-9_-]+$" } } } as const;

export const HEARTBEAT_SCHEMA = {
  body: {
    type: "object", additionalProperties: false, required: ["name", "protocol_version", "capacity", "slots", "tags", "health"],
    properties: {
      name: { type: "string", minLength: 1, maxLength: 64 },
      protocol_version: { type: "integer", minimum: 0, maximum: 1000 },
      capacity: structuredClone(RESOURCE_BUDGET_SCHEMA),
      slots: structuredClone(EXECUTOR_SLOTS_SCHEMA),
      tags: TAGS_SCHEMA,
      health: { type: "object", maxProperties: 64 },
    },
  },
};

export const LEASE_SCHEMA = {
  body: {
    type: "object", additionalProperties: false, required: ["available", "resources", "wait_s"],
    properties: { available: structuredClone(EXECUTOR_SLOTS_SCHEMA), resources: structuredClone(RESOURCE_BUDGET_SCHEMA), wait_s: { type: "integer", minimum: 0, maximum: 25 } },
  },
};

export const RENEW_SCHEMA = { params: TASK_PARAMS, body: structuredClone(LEASE_FENCE_SCHEMA) };

export const BUNDLE_SCHEMA = {
  params: TASK_PARAMS,
  querystring: { type: "object", additionalProperties: false, required: ["lease_id", "epoch"], properties: { lease_id: LEASE_ID, epoch: { type: "string", pattern: "^[1-9][0-9]{0,15}$" } } },
};

export const EVENTS_SCHEMA = {
  params: TASK_PARAMS,
  body: {
    type: "object", additionalProperties: false, required: ["lease_id", "epoch", "events"],
    properties: {
      lease_id: LEASE_ID,
      epoch: EPOCH,
      events: {
        type: "array", maxItems: 500,
        items: {
          type: "object", additionalProperties: false, required: ["seq", "at", "kind", "text"],
          properties: { seq: { type: "integer", minimum: 1 }, at: { type: "string", maxLength: 40 }, kind: { enum: ["text", "tool", "error", "retry", "model"] }, text: { type: "string", maxLength: 65536 } },
        },
      },
    },
  },
};

export const RESULT_SCHEMA = {
  params: TASK_PARAMS,
  body: { type: "object", additionalProperties: false, required: ["lease_id", "epoch", "result"], properties: { lease_id: LEASE_ID, epoch: EPOCH, result: structuredClone(TASK_RESULT_SCHEMA) } },
};

export const FAILURE_SCHEMA = {
  params: TASK_PARAMS,
  body: {
    type: "object", additionalProperties: false, required: ["lease_id", "epoch", "code", "message"],
    properties: { lease_id: LEASE_ID, epoch: EPOCH, code: { enum: [...FAILURE_CODES] }, message: { type: "string", maxLength: 4000 } },
  },
};

export const SELF_CHECK_MODEL_SCHEMA = {
  body: { type: "object", additionalProperties: false, properties: {} },
  response: {
    200: {
      type: "object", additionalProperties: false, required: ["ok", "checked_at", "models"],
      properties: { ok: { type: "boolean" }, checked_at: { type: "string" }, models: { type: "integer" }, error: { type: "string" } },
    },
  },
};
