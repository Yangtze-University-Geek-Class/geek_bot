/** 管理员端点的输入输出协议（API.md A-09…A-11）。 */
import { ADMIN_OUT, EMPTY_BODY, LIST_QUERY_PROPS, listOf, responses } from "../../../platform/schemas.js";

export interface ListQuery { readonly limit?: string; readonly cursor?: string }
export const LIST_SCHEMA = {
  querystring: { type: "object", additionalProperties: false, properties: LIST_QUERY_PROPS },
  response: responses({ 200: listOf(ADMIN_OUT) }),
};

export interface InviteBody { readonly github_id: number; readonly role: "operator" | "viewer"; readonly note?: string }
export const INVITE_SCHEMA = {
  body: {
    type: "object", additionalProperties: false, required: ["github_id", "role"],
    properties: { github_id: { type: "integer", minimum: 1, maximum: 9007199254740991 }, role: { enum: ["operator", "viewer"] }, note: { type: "string", maxLength: 500 } },
  },
  response: responses({ 201: ADMIN_OUT, 200: ADMIN_OUT }),
};

export interface RemoveParams { readonly github_id: string }
export const REMOVE_SCHEMA = {
  params: { type: "object", additionalProperties: false, required: ["github_id"], properties: { github_id: { type: "string", pattern: "^[1-9][0-9]{0,15}$" } } },
  body: EMPTY_BODY,
  response: responses({}),
};
