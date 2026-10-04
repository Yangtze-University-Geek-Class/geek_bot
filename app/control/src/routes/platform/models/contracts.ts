/** 模型目录与模型池端点的输入输出协议（A-46、A-47；按 TaskKind 分池）。 */
import type { ModelPoolEntry, TaskKind } from "@geek-bot/protocol";
import { responses } from "../../../platform/schemas.js";

const ENTRY = { type: "object", additionalProperties: false, required: ["model", "effort"], properties: { model: { type: "string" }, effort: { type: "string" } } } as const;
const POOL = { type: "object", additionalProperties: false, required: ["kind", "entries", "revision"], properties: { kind: { type: "string" }, entries: { type: "array", items: ENTRY }, revision: { type: "integer" } } } as const;

export const GET_SCHEMA = {
  response: responses({
    200: {
      type: "object", additionalProperties: false, required: ["catalog", "pools"],
      properties: {
        catalog: {
          type: "object", additionalProperties: false, required: ["models", "error"],
          properties: {
            models: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "name", "efforts"], properties: { id: { type: "string" }, name: { type: "string" }, efforts: { type: "array", items: { type: "string" } } } } },
            error: { type: ["string", "null"] },
          },
        },
        pools: { type: "array", items: POOL },
      },
    },
  }),
};

export interface KindParams { readonly kind: TaskKind }
export interface PatchBody { readonly entries: ModelPoolEntry[] }
export const PATCH_SCHEMA = {
  params: { type: "object", additionalProperties: false, required: ["kind"], properties: { kind: { enum: ["review", "triage", "followup", "fix", "rework"] } } },
  body: {
    type: "object", additionalProperties: false, required: ["entries"],
    properties: {
      entries: {
        type: "array", minItems: 1, maxItems: 8,
        items: { type: "object", additionalProperties: false, required: ["model", "effort"], properties: { model: { type: "string", minLength: 1, maxLength: 200 }, effort: { type: "string", minLength: 1, maxLength: 32 } } },
      },
    },
  },
  response: responses({ 200: POOL }),
};

export const OVERVIEW_SCHEMA = {
  response: responses({
    200: {
      type: "object", additionalProperties: false, required: ["projects", "demands", "machines", "queued", "running", "awaiting_publish", "failed", "connections"],
      properties: {
        projects: { type: "integer" }, demands: { type: "integer" }, machines: { type: "integer" }, queued: { type: "integer" }, running: { type: "integer" },
        awaiting_publish: { type: "integer" }, failed: { type: "integer" }, connections: { type: "integer" },
      },
    },
  }),
};
