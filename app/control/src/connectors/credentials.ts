import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { ConnectionCredentials, ConnectionProvider } from "@geek-bot/protocol";
import type { Db } from "../db/database.js";
import type { Redactor } from "../log/redact.js";
import { ConnectorError } from "./types.js";

const FIELD_NAMES: readonly (keyof ConnectionCredentials)[] = ["token", "app_id", "app_secret", "verification_token", "encrypt_key", "signing_secret", "webhook_url"];
const AAD = Buffer.from("geek-bot.connection.v1", "utf8");
function checked(value: unknown): ConnectionCredentials {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConnectorError("credentials_invalid", "渠道凭据必须是对象", 422);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!FIELD_NAMES.includes(key as keyof ConnectionCredentials) || typeof item !== "string" || item.length > 8192) throw new ConnectorError("credentials_invalid", "渠道凭据字段不合法", 422);
    if (item !== "") result[key] = item;
  }
  return result;
}
export function sealCredentials(masterKey: Buffer, credentials: ConnectionCredentials): string {
  if (masterKey.length !== 32) throw new ConnectorError("credentials_unavailable", "渠道密钥不可用", 503);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  cipher.setAAD(AAD);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(checked(credentials)), "utf8"), cipher.final()]);
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url")}`;
}
/** 仅读取适配器和 publisher 调用；不从公共 index 导出明文获取方法。 */
export function openCredentials(masterKey: Buffer, sealed: string): ConnectionCredentials {
  try {
    if (masterKey.length !== 32 || !/^v1\.[A-Za-z0-9_-]+$/.test(sealed)) throw new Error();
    const packet = Buffer.from(sealed.slice(3), "base64url");
    if (packet.length < 30) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", masterKey, packet.subarray(0, 12));
    decipher.setAAD(AAD);
    decipher.setAuthTag(packet.subarray(12, 28));
    const plaintext = Buffer.concat([decipher.update(packet.subarray(28)), decipher.final()]);
    return checked(JSON.parse(plaintext.toString("utf8")));
  } catch { throw new ConnectorError("credentials_unavailable", "渠道凭据无法解密，请管理员重新配置", 503); }
}
export function mergeSealedCredentials(masterKey: Buffer, existingCt: string | null, patch: ConnectionCredentials): string {
  return sealCredentials(masterKey, { ...(existingCt ? openCredentials(masterKey, existingCt) : {}), ...checked(patch) });
}
export function requiredCredentialsMissing(provider: ConnectionProvider, masterKey: Buffer, sealed: string | null): string[] {
  const required: Partial<Record<ConnectionProvider, readonly (keyof ConnectionCredentials)[]>> = {
    github: ["token"], gitlab: ["token"], feishu: ["app_id", "app_secret", "verification_token"], webhook: ["signing_secret"],
  };
  const present = sealed ? openCredentials(masterKey, sealed) : {};
  return (required[provider] ?? []).filter(field => !present[field]);
}
export function storedCredentials(db: Db, masterKey: Buffer, connectionId: string, redactor?: Redactor): ConnectionCredentials {
  const row = db.prepare("SELECT credentials_ct FROM connection_credentials WHERE connection_id = ?").get(connectionId) as { credentials_ct: string } | undefined;
  if (!row) throw new ConnectorError("connection_unconfigured", "渠道尚未配置凭据", 409);
  const credentials = openCredentials(masterKey, row.credentials_ct);
  if (redactor) for (const [key, value] of Object.entries(credentials)) if (value && key !== "app_id") redactor.addKnownSecret(value);
  return credentials;
}
