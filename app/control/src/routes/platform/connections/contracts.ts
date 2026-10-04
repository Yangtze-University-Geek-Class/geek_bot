/** 平台连接端点的输入输出协议。凭据只写不读：请求里有，响应里永远只有 secret_configured。 */
import type { ConnectionCredentials, ConnectionProvider } from "@geek-bot/protocol";
import { CONNECTION_OUT, EMPTY_BODY, ID_PARAMS, LIST_QUERY_PROPS, listOf, responses } from "../../../platform/schemas.js";

const secret = { type: "string", minLength: 1, maxLength: 4096 } as const;
const CREDENTIALS = {
  type: "object", additionalProperties: false, maxProperties: 7,
  properties: {
    token: secret, app_id: { type: "string", minLength: 1, maxLength: 200 }, app_secret: secret, verification_token: secret, encrypt_key: secret, signing_secret: secret,
    webhook_url: { type: "string", minLength: 1, maxLength: 500 },
  },
} as const;

export interface ListQuery { readonly limit?: string; readonly cursor?: string }
export const LIST_SCHEMA = {
  querystring: { type: "object", additionalProperties: false, properties: LIST_QUERY_PROPS },
  response: responses({ 200: listOf(CONNECTION_OUT) }),
};

export interface CreateBody { readonly provider: ConnectionProvider; readonly name: string; readonly base_url: string; readonly credentials?: ConnectionCredentials }
export const CREATE_SCHEMA = {
  body: {
    type: "object", additionalProperties: false, required: ["provider", "name", "base_url"],
    properties: {
      provider: { enum: ["github", "gitlab", "feishu", "webhook"] },
      name: { type: "string", minLength: 1, maxLength: 80, pattern: "\\S" },
      base_url: { type: "string", maxLength: 300 },
      credentials: CREDENTIALS,
    },
  },
  response: responses({ 201: CONNECTION_OUT, 200: CONNECTION_OUT }),
};

export interface IdParams { readonly id: string }
export const GET_SCHEMA = { params: ID_PARAMS, response: responses({ 200: CONNECTION_OUT }) };

export interface PatchBody { readonly name?: string; readonly base_url?: string; readonly enabled?: boolean; readonly credentials?: ConnectionCredentials }
export const PATCH_SCHEMA = {
  params: ID_PARAMS,
  body: {
    type: "object", additionalProperties: false, minProperties: 1,
    properties: { name: { type: "string", minLength: 1, maxLength: 80, pattern: "\\S" }, base_url: { type: "string", maxLength: 300 }, enabled: { type: "boolean" }, credentials: CREDENTIALS },
  },
  response: responses({ 200: CONNECTION_OUT }),
};

export const ACTION_SCHEMA = { params: ID_PARAMS, body: EMPTY_BODY, response: responses({ 200: CONNECTION_OUT }) };
export const DISCOVER_SCHEMA = {
  params: ID_PARAMS,
  body: EMPTY_BODY,
  response: responses({ 200: { type: "object", additionalProperties: false, required: ["discovered", "lost"], properties: { discovered: { type: "integer" }, lost: { type: "integer" } } } }),
};
export const SYNC_SCHEMA = {
  params: ID_PARAMS,
  body: EMPTY_BODY,
  response: responses({ 200: { type: "object", additionalProperties: false, required: ["projects", "items"], properties: { projects: { type: "integer" }, items: { type: "integer" } } } }),
};
