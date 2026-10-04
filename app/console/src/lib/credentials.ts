/**
 * 连接凭据表单与请求体之间的转换。凭据只写不读：只提交当前平台用到、并且填了值的字段，
 * 更新时留空的字段不出现在请求里，control 保留原值。本文件不导入 Vue。
 */
import type { ConnectionCredentials, ConnectionProvider } from "@geek-bot/protocol";

export type CredentialDraft = Record<keyof ConnectionCredentials, string>;

/** 每个平台的凭据字段与创建时是否必填。GitHub 走 OAuth 绑定，没有可填的凭据。 */
export const CREDENTIAL_FIELDS: Readonly<Record<ConnectionProvider, readonly { key: keyof ConnectionCredentials; required: boolean }[]>> = {
  github: [],
  gitlab: [{ key: "token", required: true }],
  feishu: [
    { key: "app_id", required: true },
    { key: "app_secret", required: true },
    { key: "verification_token", required: true },
    { key: "encrypt_key", required: false },
  ],
  webhook: [
    { key: "signing_secret", required: true },
    { key: "webhook_url", required: false },
  ],
};

/** 平台 API 的默认地址；GitHub 企业版、自建 GitLab 改成自己的地址。签名 Webhook 没有平台地址。 */
export const DEFAULT_BASE_URL: Readonly<Record<ConnectionProvider, string>> = {
  github: "https://api.github.com",
  gitlab: "https://gitlab.com",
  feishu: "https://open.feishu.cn",
  webhook: "",
};

export function emptyCredentialDraft(): CredentialDraft {
  return { token: "", app_id: "", app_secret: "", verification_token: "", encrypt_key: "", signing_secret: "", webhook_url: "" };
}

/** 只取这个平台的、填了值的字段；没有任何字段时返回 null（不提交 credentials）。 */
export function credentialsPayload(provider: ConnectionProvider, draft: CredentialDraft): ConnectionCredentials | null {
  const entries = CREDENTIAL_FIELDS[provider].map(field => [field.key, draft[field.key].trim()] as const).filter(([, value]) => value !== "");
  return entries.length === 0 ? null : Object.fromEntries(entries);
}

/** 创建时必填的凭据是否都填了。 */
export function credentialsComplete(provider: ConnectionProvider, draft: CredentialDraft): boolean {
  return CREDENTIAL_FIELDS[provider].every(field => !field.required || draft[field.key].trim() !== "");
}
