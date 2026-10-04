import { createCipheriv, createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FeishuConnector, WebhookConnector } from "../../app/control/src/connectors/im.js";

const now = 1_740_000_000_000;
const secret = (label: string) => createHash("sha256").update(`im-regression:${label}`).digest("hex");
const token = secret("verification");
const encryptKey = secret("encryption");
const signingSecret = secret("signing");
const appId = "fixture-app";
const raw = (body: unknown) => Buffer.from(JSON.stringify(body), "utf8");
function failure(run: () => unknown): unknown {
  try { run(); } catch (error) { return error; }
  throw new Error("Expected callback rejection");
}
const refused = { code: "intake_verification_failed", statusCode: 403 };
const feishu = (encrypted = false) => new FeishuConnector({ baseUrl: "https://feishu.example.test", credentials: { app_id: appId, verification_token: token, ...(encrypted ? { encrypt_key: encryptKey } : {}) } });
const message = () => ({
  header: { token, app_id: appId, event_type: "im.message.receive_v1", event_id: "event-1" },
  event: { sender: { sender_type: "user" }, message: { message_id: "om_fixture_1", message_type: "text", content: JSON.stringify({ text: "第一行\r\nsecond line" }) } },
});
function encrypt(payload: unknown): { encrypt: string } {
  const iv = Buffer.alloc(16, 11);
  const cipher = createCipheriv("aes-256-cbc", createHash("sha256").update(encryptKey).digest(), iv);
  return { encrypt: Buffer.concat([iv, cipher.update(raw(payload)), cipher.final()]).toString("base64") };
}
function larkHeaders(bytes: Buffer, time = String(now / 1000), nonce = "fixture-nonce") {
  return {
    "x-lark-request-timestamp": time,
    "x-lark-request-nonce": nonce,
    "x-lark-signature": createHash("sha256").update(time + nonce + encryptKey).update(bytes).digest("hex"),
  };
}

 describe("Feishu callback verification", () => {
  it("answers token-authenticated plaintext and encrypted challenges without an event signature", () => {
    const challenge = { type: "url_verification", token, challenge: "fixture-challenge" };
    expect(feishu().verifyEvent({}, challenge, raw(challenge), now)).toEqual({ type: "challenge", response: { challenge: "fixture-challenge" } });
    const envelope = encrypt(challenge);
    expect(feishu(true).verifyEvent({}, envelope, raw(envelope), now)).toEqual({ type: "challenge", response: { challenge: "fixture-challenge" } });
  });

  it("requires challenge authentication and validates the challenge size boundary", () => {
    for (const wrongToken of ["", secret("other-verification")]) {
      const body = { type: "url_verification", token: wrongToken, challenge: "fixture" };
      expect(failure(() => feishu().verifyEvent({}, body, raw(body), now))).toMatchObject(refused);
    }
    const accepted = { type: "url_verification", token, challenge: "x".repeat(1024) };
    expect(feishu().verifyEvent({}, accepted, raw(accepted), now)).toEqual({ type: "challenge", response: { challenge: accepted.challenge } });
    for (const challenge of [42, "x".repeat(1025)]) {
      const body = { type: "url_verification", token, challenge };
      expect(failure(() => feishu().verifyEvent({}, body, raw(body), now))).toMatchObject({ code: "intake_invalid", statusCode: 400 });
    }
  });

  it("extracts a signed encrypted user message after decryption", () => {
    const envelope = encrypt(message());
    const bytes = raw(envelope);
    expect(feishu(true).verifyEvent(larkHeaders(bytes), envelope, bytes, now)).toEqual({ type: "event", event_id: "event-1", source_ref: "om_fixture_1", title: "第一行", body: "第一行\r\nsecond line" });
  });

  it("rejects plaintext downgrade, invalid ciphertext and encrypted callbacks without a configured key", () => {
    const body = message();
    expect(failure(() => feishu(true).verifyEvent({}, body, raw(body), now))).toMatchObject(refused);
    for (const encryptValue of ["!", Buffer.alloc(31).toString("base64"), Buffer.alloc(32).toString("base64")]) {
      const envelope = { encrypt: encryptValue };
      expect(failure(() => feishu(true).verifyEvent({}, envelope, raw(envelope), now))).toMatchObject(refused);
    }
    const envelope = encrypt(body);
    expect(failure(() => feishu().verifyEvent({}, envelope, raw(envelope), now))).toMatchObject(refused);
  });

  it("binds encrypted events to token, application, original bytes and signature headers", () => {
    const wrongToken = message();
    wrongToken.header.token = secret("wrong-token");
    const wrongApp = message();
    wrongApp.header.app_id = "different-app";
    for (const payload of [wrongToken, wrongApp]) {
      const envelope = encrypt(payload);
      const bytes = raw(envelope);
      expect(failure(() => feishu(true).verifyEvent(larkHeaders(bytes), envelope, bytes, now))).toMatchObject(refused);
    }
    const envelope = encrypt(message());
    const bytes = raw(envelope);
    const valid = larkHeaders(bytes);
    for (const headers of [
      {},
      { ...valid, "x-lark-signature": secret("wrong-signature") },
      { ...valid, "x-lark-request-nonce": "changed" },
      larkHeaders(bytes, String((now - 300_001) / 1000)),
      larkHeaders(bytes, String(now), "x".repeat(257)),
    ]) {
      expect(failure(() => feishu(true).verifyEvent(headers, envelope, bytes, now))).toMatchObject(refused);
    }
    expect(failure(() => feishu(true).verifyEvent(valid, envelope, Buffer.concat([bytes, Buffer.from(" ")]), now))).toMatchObject(refused);
  });

  it("ignores bot messages and unrelated events instead of admitting requirements", () => {
    const bot = message();
    bot.event.sender.sender_type = "app";
    const unrelated = message();
    unrelated.header.event_type = "other.event";
    for (const body of [bot, unrelated]) expect(feishu().verifyEvent({}, body, raw(body), now)).toEqual({ type: "ignored" });
  });

  it("extracts rich-post text and links from the first populated locale", () => {
    const body = message();
    body.event.message.message_type = "post";
    body.event.message.content = JSON.stringify({ en_us: { title: "Proposal", content: [[{ tag: "text", text: "Details" }, { tag: "a", text: "Spec", href: "https://docs.example.test/spec" }]] }, zh_cn: { title: "Duplicate", content: [] } });
    expect(feishu().verifyEvent({}, body, raw(body), now)).toEqual({ type: "event", event_id: "event-1", source_ref: "om_fixture_1", title: "Proposal", body: "Proposal\nDetails\nSpec\nhttps://docs.example.test/spec" });
  });

  it("rejects invalid message identifiers, malformed content and empty text", () => {
    const badId = message();
    badId.event.message.message_id = "not-a-message";
    const badContent = message();
    badContent.event.message.content = "{";
    for (const body of [badId, badContent]) expect(failure(() => feishu().verifyEvent({}, body, raw(body), now))).toMatchObject({ code: "intake_invalid", statusCode: 400 });
    for (const text of [" \n\t", "x".repeat(60001)]) {
      const body = message();
      body.event.message.content = JSON.stringify({ text });
      expect(failure(() => feishu().verifyEvent({}, body, raw(body), now))).toMatchObject({ code: "intake_invalid", statusCode: 422 });
    }
  });
});

const webhook = () => new WebhookConnector({ baseUrl: "https://bridge.example.test", credentials: { signing_secret: signingSecret } });
const bridgeEvent = () => ({ event_id: "event:fixture-1", title: "Proposal", body: "Full requirement\nSecond line", source_ref: "thread-fixture", project_id: "project-fixture" });
function bridgeHeaders(bytes: Buffer, time = String(now / 1000)) {
  return { "x-geek-bot-timestamp": time, "x-geek-bot-signature": `sha256=${createHmac("sha256", signingSecret).update(time + ".").update(bytes).digest("hex")}` };
}

describe("generic HMAC callback verification", () => {
  it("extracts the signed event and maps the supplied project to a project hint", () => {
    const body = bridgeEvent();
    const bytes = raw(body);
    expect(webhook().verifyEvent(bridgeHeaders(bytes), body, bytes, now)).toEqual({ type: "event", event_id: body.event_id, title: body.title, body: body.body, source_ref: body.source_ref, project_hint: body.project_id });
  });

  it.each([-300000, 300000])("accepts the inclusive timestamp boundary %s in seconds and milliseconds", offset => {
    const body = bridgeEvent();
    const bytes = raw(body);
    for (const time of [String((now + offset) / 1000), String(now + offset)]) {
      const headers = bridgeHeaders(bytes, time);
      headers["x-geek-bot-signature"] = headers["x-geek-bot-signature"].slice(7).toUpperCase();
      expect(webhook().verifyEvent(headers, body, bytes, now)).toEqual({ type: "event", event_id: body.event_id, title: body.title, body: body.body, source_ref: body.source_ref, project_hint: body.project_id });
    }
  });

  it.each([String(now - 300001), String(now + 300001), String(now / 1000 - 301), String(now / 1000 + 301), "1740000000.0", "not-time"])("rejects out-of-window or malformed timestamp %s even with a correct HMAC", time => {
    const body = bridgeEvent();
    const bytes = raw(body);
    expect(failure(() => webhook().verifyEvent(bridgeHeaders(bytes, time), body, bytes, now))).toMatchObject(refused);
  });

  it("rejects changed raw bytes, changed timestamps, wrong secrets and malformed signatures", () => {
    const body = bridgeEvent();
    const bytes = raw(body);
    const headers = bridgeHeaders(bytes);
    expect(failure(() => webhook().verifyEvent(headers, body, Buffer.concat([bytes, Buffer.from("\n")]), now))).toMatchObject(refused);
    expect(failure(() => webhook().verifyEvent({ ...headers, "x-geek-bot-timestamp": String(now / 1000 + 1) }, body, bytes, now))).toMatchObject(refused);
    const other = new WebhookConnector({ baseUrl: "https://bridge.example.test", credentials: { signing_secret: secret("other-signing") } });
    expect(failure(() => other.verifyEvent(headers, body, bytes, now))).toMatchObject(refused);
    for (const signature of ["", "z".repeat(64), secret("wrong-hmac"), [headers["x-geek-bot-signature"]]]) {
      expect(failure(() => webhook().verifyEvent({ ...headers, "x-geek-bot-signature": signature }, body, bytes, now))).toMatchObject(refused);
    }
  });

  it.each(["callback_url", "credentials", "unexpected"])("rejects authenticated unknown field %s", field => {
    const body = { ...bridgeEvent(), [field]: "fixture-value" };
    const bytes = raw(body);
    expect(failure(() => webhook().verifyEvent(bridgeHeaders(bytes), body, bytes, now))).toMatchObject({ code: "intake_invalid", statusCode: 400 });
  });

  it.each([
    ["invalid event ID", { event_id: "contains space" }],
    ["empty title", { title: " \t" }],
    ["oversized title", { title: "x".repeat(201) }],
    ["oversized body", { body: "x".repeat(60001) }],
    ["non-string body", { body: 42 }],
    ["non-string project", { project_id: 42 }],
    ["oversized project", { project_id: "x".repeat(129) }],
  ])("rejects authenticated %s", (_name, patch) => {
    const body = { ...bridgeEvent(), ...patch };
    const bytes = raw(body);
    expect(failure(() => webhook().verifyEvent(bridgeHeaders(bytes), body, bytes, now))).toMatchObject({ code: "intake_invalid", statusCode: 422 });
  });

  it("preserves exact accepted field-length boundaries", () => {
    const body = { event_id: "e".repeat(200), title: "t".repeat(200), body: "b".repeat(60000), source_ref: "fixture-source", project_id: "p".repeat(128) };
    const bytes = raw(body);
    expect(webhook().verifyEvent(bridgeHeaders(bytes), body, bytes, now)).toEqual({ type: "event", event_id: body.event_id, title: body.title, body: body.body, source_ref: body.source_ref, project_hint: body.project_id });
  });
});
