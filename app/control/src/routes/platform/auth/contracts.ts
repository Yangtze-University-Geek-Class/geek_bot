/** 认领、登录与会话端点的输入输出协议（API.md A-01…A-04、A-07、A-08）。 */
import { EMPTY_BODY, responses } from "../../../platform/schemas.js";

export const AUTH_STATE_SCHEMA = {
  response: responses({
    200: {
      type: "object", additionalProperties: false, required: ["claimed", "login_methods", "insecure_context", "bot_bound"],
      properties: { claimed: { type: "boolean" }, login_methods: { type: "array", items: { type: "string" } }, insecure_context: { type: "boolean" }, bot_bound: { type: "boolean" } },
    },
  }),
};

export interface ClaimBody { readonly code: string }
export const CLAIM_SCHEMA = {
  body: { type: "object", additionalProperties: false, required: ["code"], properties: { code: { type: "string", minLength: 1, maxLength: 64 } } },
  response: responses({}),
};

export interface DeviceBody { readonly purpose: "claim" | "login" | "reauth" | "connection"; readonly connection_id?: string }
export const DEVICE_SCHEMA = {
  body: {
    type: "object", additionalProperties: false, required: ["purpose"],
    properties: { purpose: { enum: ["claim", "login", "reauth", "connection"] }, connection_id: { type: "string", minLength: 1, maxLength: 80, pattern: "^[A-Za-z0-9_-]+$" } },
  },
  response: responses({
    200: {
      type: "object", additionalProperties: false, required: ["flow_id", "user_code", "verification_uri", "expires_in_s", "interval_s"],
      properties: { flow_id: { type: "string" }, user_code: { type: "string" }, verification_uri: { type: "string" }, expires_in_s: { type: "integer" }, interval_s: { type: "integer" } },
    },
  }),
};

export interface PollParams { readonly flow_id: string }
export const POLL_SCHEMA = {
  params: { type: "object", additionalProperties: false, required: ["flow_id"], properties: { flow_id: { type: "string", minLength: 1, maxLength: 80, pattern: "^[A-Za-z0-9_-]+$" } } },
  body: EMPTY_BODY,
  response: responses({ 200: { type: "object", additionalProperties: false, required: ["status"], properties: { status: { enum: ["pending", "slow_down", "expired", "denied", "done"] } } } }),
};

export const LOGOUT_SCHEMA = { body: EMPTY_BODY, response: responses({}) };

export const ME_SCHEMA = {
  response: responses({
    200: {
      type: "object", additionalProperties: false, required: ["github_id", "login", "role", "is_bot_account", "reauth_valid_until", "session_expires_at"],
      properties: {
        github_id: { type: "integer" }, login: { type: "string" }, role: { type: "string" }, is_bot_account: { type: "boolean" },
        reauth_valid_until: { type: ["string", "null"] }, session_expires_at: { type: "string" },
      },
    },
  }),
};
