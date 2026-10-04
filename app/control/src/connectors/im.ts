import { createDecipheriv, createHash, createHmac, timingSafeEqual } from "node:crypto";
import { ApiTransport, boundedBody, object, publicBaseUrl, string } from "./http.js";
import { ConnectorError, type ImConnector, type ImConnectorOptions, type IntakeVerification } from "./types.js";

function header(headers: Readonly<Record<string, string | string[] | undefined>>, name: string): string {
  const value = headers[name.toLowerCase()] ?? headers[name];
  return typeof value === "string" ? value : "";
}
function equalSecret(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}
function withinWindow(value: string, now: number): boolean {
  return /^[0-9]{10,13}$/.test(value) && Math.abs(now - Number(value) * (value.length === 13 ? 1 : 1000)) <= 300_000;
}

export class FeishuConnector implements ImConnector {
  private readonly api: ApiTransport;
  constructor(private readonly options: ImConnectorOptions) {
    const base = publicBaseUrl(options.baseUrl || "https://open.feishu.cn");
    if (!/\/open-apis\/$/.test(base.pathname)) base.pathname += "open-apis/";
    this.api = new ApiTransport(base.href, { "Content-Type": "application/json; charset=utf-8" }, options.fetchImpl);
  }
  verifyEvent(headers: Readonly<Record<string, string | string[] | undefined>>, body: unknown, rawBody: Buffer, now = Date.now()): IntakeVerification {
    const outer = object(body);
    let payload = outer;
    const encryptKey = this.options.credentials.encrypt_key;
    if (outer.encrypt !== undefined) {
      if (!encryptKey || typeof outer.encrypt !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(outer.encrypt)) throw new ConnectorError("intake_verification_failed", "飞书事件验证失败", 403);
      try {
        const packet = Buffer.from(outer.encrypt, "base64");
        if (packet.length < 32 || (packet.length - 16) % 16 !== 0) throw new Error();
        const key = createHash("sha256").update(encryptKey).digest();
        const decipher = createDecipheriv("aes-256-cbc", key, packet.subarray(0, 16));
        payload = object(JSON.parse(Buffer.concat([decipher.update(packet.subarray(16)), decipher.final()]).toString("utf8")));
      } catch { throw new ConnectorError("intake_verification_failed", "飞书事件验证失败", 403); }
    } else if (encryptKey) {
      throw new ConnectorError("intake_verification_failed", "已配置加密的飞书渠道不能接收明文事件", 403);
    }
    const meta = payload.header && typeof payload.header === "object" ? object(payload.header) : {};
    const verificationToken = string(meta.token, string(payload.token));
    if (!equalSecret(verificationToken, this.options.credentials.verification_token ?? "")) throw new ConnectorError("intake_verification_failed", "飞书事件验证失败", 403);
    // 官方URL验证请求不要求事件签名，但仍必须通过Verification Token与配置的解密。
    if (payload.type === "url_verification") {
      if (typeof payload.challenge !== "string" || payload.challenge.length > 1024) throw new ConnectorError("intake_invalid", "飞书验证请求格式不正确", 400);
      return { type: "challenge", response: { challenge: payload.challenge } };
    }
    if (encryptKey) {
      const time = header(headers, "x-lark-request-timestamp");
      const nonce = header(headers, "x-lark-request-nonce");
      const received = header(headers, "x-lark-signature");
      if (!withinWindow(time, now) || !nonce || nonce.length > 256 || !/^[a-f0-9]{64}$/i.test(received)) throw new ConnectorError("intake_verification_failed", "飞书事件签名或时间不合法", 403);
      const digest = createHash("sha256").update(time + nonce + encryptKey).update(rawBody).digest("hex");
      if (!equalSecret(received.toLowerCase(), digest)) throw new ConnectorError("intake_verification_failed", "飞书事件验证失败", 403);
    }
    if (meta.app_id && meta.app_id !== this.options.credentials.app_id) throw new ConnectorError("intake_verification_failed", "飞书事件不属于此应用", 403);
    const event = object(payload.event ?? {});
    if (meta.event_type !== "im.message.receive_v1") return { type: "ignored" };
    const sender = object(event.sender ?? {});
    if (sender.sender_type !== "user") return { type: "ignored" };
    const message = object(event.message);
    const eventId = string(meta.event_id);
    const messageId = string(message.message_id);
    if (!eventId || !/^om_[A-Za-z0-9_-]{1,200}$/.test(messageId)) throw new ConnectorError("intake_invalid", "飞书消息标识不合法", 400);
    let content: Record<string, unknown>;
    try { content = object(JSON.parse(string(message.content))); } catch { throw new ConnectorError("intake_invalid", "飞书消息内容不是合法 JSON", 400); }
    let text = "";
    if (message.message_type === "text") text = string(content.text);
    else if (message.message_type === "post") {
      const pieces: string[] = [];
      for (const locale of Object.values(content)) {
        if (!locale || typeof locale !== "object") continue;
        const post = object(locale);
        if (typeof post.title === "string") pieces.push(post.title);
        if (Array.isArray(post.content)) for (const row of post.content) if (Array.isArray(row)) for (const span of row) {
          const part = object(span);
          if (typeof part.text === "string") pieces.push(part.text);
          if (part.tag === "a" && typeof part.href === "string") pieces.push(part.href);
        }
        if (pieces.length) break;
      }
      text = pieces.join("\n");
    } else return { type: "ignored" };
    if (!text.trim() || text.length > 60000) throw new ConnectorError("intake_invalid", "需求内容为空或超过允许长度", 422);
    return { type: "event", event_id: eventId, source_ref: messageId, title: text.split(/\r?\n/, 1)[0].slice(0, 200), body: text };
  }
  async sendMessage(target: string, text: string, idempotencyKey: string): Promise<string> {
    if (!/^om_[A-Za-z0-9_-]{1,200}$/.test(target) || idempotencyKey.length > 50) throw new ConnectorError("publish_target_rejected", "飞书回传目标不合法", 422);
    const credentials = this.options.credentials;
    const auth = object((await this.api.json("auth/v3/tenant_access_token/internal", { method: "POST", body: JSON.stringify({ app_id: credentials.app_id, app_secret: credentials.app_secret }) })).data);
    if (auth.code !== 0 || typeof auth.tenant_access_token !== "string") throw new ConnectorError("connection_unauthorized", "飞书应用授权失败", 401);
    this.options.redactor?.addKnownSecret(auth.tenant_access_token);
    const result = object((await this.api.json(`im/v1/messages/${encodeURIComponent(target)}/reply`, { method: "POST", headers: { Authorization: `Bearer ${auth.tenant_access_token}` }, body: JSON.stringify({ msg_type: "text", content: JSON.stringify({ text }), uuid: idempotencyKey }) })).data);
    if (result.code !== 0) throw new ConnectorError("im_publish_failed", "飞书拒绝回传消息，请核对应用权限与消息可见范围");
    const data = object(result.data);
    if (typeof data.message_id !== "string") throw new ConnectorError("upstream_invalid", "飞书未返回已发送消息的标识");
    return data.message_id;
  }
}

/** 通用IM桥：签名原始字节，事件id去重由control事务完成；目的地址只能由管理员配置。 */
export class WebhookConnector implements ImConnector {
  constructor(private readonly options: ImConnectorOptions) {}
  verifyEvent(headers: Readonly<Record<string, string | string[] | undefined>>, body: unknown, rawBody: Buffer, now = Date.now()): IntakeVerification {
    const time = header(headers, "x-geek-bot-timestamp");
    const signature = header(headers, "x-geek-bot-signature").replace(/^sha256=/, "");
    const secret = this.options.credentials.signing_secret;
    if (!secret || !withinWindow(time, now) || !/^[a-f0-9]{64}$/i.test(signature)) throw new ConnectorError("intake_verification_failed", "IM桥签名或时间不合法", 403);
    const expected = createHmac("sha256", secret).update(time + ".").update(rawBody).digest("hex");
    if (!equalSecret(signature.toLowerCase(), expected)) throw new ConnectorError("intake_verification_failed", "IM桥事件验证失败", 403);
    const event = object(body);
    if (Object.keys(event).some(key => !["event_id", "title", "body", "source_ref", "project_id"].includes(key))) throw new ConnectorError("intake_invalid", "IM桥事件含未知字段", 400);
    if (typeof event.event_id !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(event.event_id) || typeof event.title !== "string" || !event.title.trim() || event.title.length > 200 || typeof event.body !== "string" || event.body.length > 60000) throw new ConnectorError("intake_invalid", "IM桥需求字段不合法", 422);
    if (event.project_id !== undefined && event.project_id !== null && (typeof event.project_id !== "string" || event.project_id.length > 128)) throw new ConnectorError("intake_invalid", "IM桥项目标识不合法", 422);
    return { type: "event", event_id: event.event_id, title: event.title, body: event.body, source_ref: string(event.source_ref, event.event_id), ...(typeof event.project_id === "string" ? { project_hint: event.project_id } : {}) };
  }
  async sendMessage(target: string, text: string, idempotencyKey: string): Promise<string> {
    const configured = this.options.credentials.webhook_url;
    const secret = this.options.credentials.signing_secret;
    if (!configured || !secret) throw new ConnectorError("im_reply_unconfigured", "此IM桥尚未配置结果回传地址", 409);
    let url: URL;
    try { url = new URL(configured); } catch { throw new ConnectorError("im_reply_unconfigured", "IM桥回传地址不合法", 422); }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new ConnectorError("im_reply_unconfigured", "IM桥回传地址必须使用 HTTPS", 422);
    if (url.username || url.password || url.hash) throw new ConnectorError("im_reply_unconfigured", "IM桥回传地址不能带账号、密码或片段", 422);
    const time = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ source_ref: target, text, event_id: idempotencyKey });
    const signature = createHmac("sha256", secret).update(time + "." + body).digest("hex");
    const response = await (this.options.fetchImpl ?? globalThis.fetch)(url, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(30_000), headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey, "X-Geek-Bot-Timestamp": time, "X-Geek-Bot-Signature": `sha256=${signature}` }, body });
    await boundedBody(response, 1024 * 1024);
    if (!response.ok) throw new ConnectorError("im_publish_failed", `IM桥回传返回 HTTP ${response.status}`);
    return idempotencyKey;
  }
}
