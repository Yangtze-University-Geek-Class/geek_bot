import { createCipheriv, createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ConnectionCredentials } from "../../packages/protocol/src/index.js";
import { sealCredentials, openCredentials, mergeSealedCredentials, requiredCredentialsMissing } from "../../app/control/src/connectors/credentials.js";

const secret = (label: string) => createHash("sha256").update(`credential-regression:${label}`).digest("hex");
const key = () => createHash("sha256").update("credential-regression:master").digest();
function failure(run: () => unknown): unknown {
  try { run(); } catch (error) { return error; }
  throw new Error("Expected credential operation to reject");
}
const invalid = { code: "credentials_invalid", statusCode: 422 };
const unavailable = { code: "credentials_unavailable", statusCode: 503 };

// Produce authenticated but invalid stored plaintext through real AES-GCM.
function authenticatedPacket(value: unknown): string {
  const iv = Buffer.alloc(12, 7);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from("geek-bot.connection.v1"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url")}`;
}

describe("sealed connection credentials", () => {
  it("recovers Unicode credentials and merges a partial rotation without losing other secrets", () => {
    const original = { token: secret("old-token"), app_id: "fixture-app", app_secret: secret("app"), verification_token: secret("verification"), signing_secret: secret("signing"), encrypt_key: `密钥-${secret("encrypt")}`, webhook_url: "https://callback.example.test/result" };
    const sealed = sealCredentials(key(), original);
    expect(openCredentials(key(), sealed)).toEqual(original);
    const rotated = mergeSealedCredentials(key(), sealed, { token: secret("new-token"), app_secret: "" });
    expect(openCredentials(key(), rotated)).toEqual({ ...original, token: secret("new-token") });
    expect(openCredentials(key(), sealed)).toEqual(original);
  });

  it("merges into an unconfigured connection and reports required fields from decrypted content", () => {
    const sealed = mergeSealedCredentials(key(), null, { app_id: "fixture-app", verification_token: secret("verify") });
    expect(requiredCredentialsMissing("feishu", key(), sealed)).toEqual(["app_secret"]);
    const complete = mergeSealedCredentials(key(), sealed, { app_secret: secret("app") });
    expect(requiredCredentialsMissing("feishu", key(), complete)).toEqual([]);
    expect(requiredCredentialsMissing("github", key(), complete)).toEqual(["token"]);
  });

  it.each([
    ["unknown field", { token: secret("token"), unexpected: "value" }],
    ["non-string field", { token: 42 }],
    ["array", []],
    ["null", null],
    ["oversized field", { token: "x".repeat(8193) }],
  ])("rejects %s during sealing and merging", (_name, value) => {
    const credentials = value as ConnectionCredentials;
    expect(failure(() => sealCredentials(key(), credentials))).toMatchObject(invalid);
    const existing = sealCredentials(key(), { token: secret("existing") });
    expect(failure(() => mergeSealedCredentials(key(), existing, credentials))).toMatchObject(invalid);
  });

  it("accepts the credential field size boundary without truncation", () => {
    const token = "界".repeat(8192);
    expect(openCredentials(key(), sealCredentials(key(), { token }))).toEqual({ token });
  });

  it.each([0, 12, 28])("refuses modified packet byte %s for reads, merges and readiness checks", (offset) => {
    const sealed = sealCredentials(key(), { token: secret("tamper") });
    const packet = Buffer.from(sealed.slice(3), "base64url");
    packet[offset] ^= 1;
    const modified = `v1.${packet.toString("base64url")}`;
    expect(failure(() => openCredentials(key(), modified))).toMatchObject(unavailable);
    expect(failure(() => mergeSealedCredentials(key(), modified, { token: secret("replacement") }))).toMatchObject(unavailable);
    expect(failure(() => requiredCredentialsMissing("github", key(), modified))).toMatchObject(unavailable);
  });

  it("refuses wrong keys, unsupported envelopes and truncated packets", () => {
    const sealed = sealCredentials(key(), { token: secret("stored") });
    const otherKey = createHash("sha256").update("credential-regression:other-master").digest();
    expect(failure(() => openCredentials(otherKey, sealed))).toMatchObject(unavailable);
    expect(failure(() => openCredentials(Buffer.alloc(31), sealed))).toMatchObject(unavailable);
    expect(failure(() => sealCredentials(Buffer.alloc(31), { token: secret("token") }))).toMatchObject(unavailable);
    for (const malformed of [sealed.replace(/^v1/, "v2"), `v1.${Buffer.alloc(29).toString("base64url")}`, `${sealed}!`]) {
      expect(failure(() => openCredentials(key(), malformed))).toMatchObject(unavailable);
    }
  });

  it.each([null, [], { unknown: "value" }, { token: 5 }])("refuses authenticated invalid plaintext %#", (value) => {
    expect(failure(() => openCredentials(key(), authenticatedPacket(value)))).toMatchObject(unavailable);
  });
});
