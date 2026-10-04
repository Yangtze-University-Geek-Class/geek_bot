/**
 * 共享平台各服务共用的依赖（库、时钟、配置、密钥、打码、审计、事件总线、出网 fetch）与两项共用规则：
 * 限速和创建类请求的幂等记录（API.md「幂等」「限速」）。
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import type { Alerts } from "../db/alerts.js";
import type { Auditor } from "../db/audit.js";
import type { Db } from "../db/database.js";
import type { Logger } from "../log/logger.js";
import type { Redactor } from "../log/redact.js";
import type { PlatformConfig, PlatformSecrets } from "./config.js";
import type { EventBus } from "./events.js";
import { canonicalJson, PlatformError, sha256Hex, type CookieSigner } from "./http.js";

export type FetchImpl = typeof fetch;

export interface PlatformContext {
  readonly db: Db;
  readonly clock: () => number;
  readonly config: PlatformConfig;
  readonly secrets: PlatformSecrets;
  readonly masterKey: Buffer;
  readonly redactor: Redactor;
  readonly logger: Logger;
  readonly auditor: Auditor;
  readonly alerts: Alerts;
  readonly bus: EventBus;
  readonly fetchImpl: FetchImpl;
  readonly signer: CookieSigner;
  readonly limiter: RateLimiter;
  readonly idempotency: IdempotencyStore;
  /** 只封装 control 自己的短期数据（device_code）的 AES-256-GCM；连接凭据由 connectors 的 sealCredentials 处理。 */
  readonly vault: LocalVault;
}

// ---------------------------------------------------------------------------
// 限速：固定窗口计数，按键（来源地址、会话、节点）隔离；超额 429 并带 Retry-After。
// ---------------------------------------------------------------------------

export interface RateLimiter {
  /** 记一次；超额时抛 429 rate_limited。 */
  hit(key: string, limit: number, windowMs: number): void;
}

export function createRateLimiter(clock: () => number): RateLimiter {
  const windows = new Map<string, { start: number; count: number }>();
  let lastSweep = 0;
  return {
    hit(key, limit, windowMs) {
      const now = clock();
      if (now - lastSweep > 60_000) {
        for (const [name, window] of windows) if (now - window.start > 3_600_000) windows.delete(name);
        lastSweep = now;
      }
      const current = windows.get(key);
      if (!current || now - current.start >= windowMs) {
        windows.set(key, { start: now, count: 1 });
        return;
      }
      current.count += 1;
      if (current.count > limit) {
        const retry = Math.max(1, Math.ceil((current.start + windowMs - now) / 1000));
        throw new PlatformError(429, "rate_limited", "请求过于频繁，稍后再试", { "Retry-After": String(retry) });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 幂等：按「会话账号 + 路由 + key」保存第一次的响应 24 小时；返回一次性密钥的端点重放 409 secret_already_issued。
// ---------------------------------------------------------------------------

export const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;

export interface IdempotentResult {
  readonly status: number;
  readonly body: unknown;
  /** 响应里含一次性密钥：不保存响应体，重放时拒绝。 */
  readonly secret?: boolean;
}

export interface IdempotencyStore {
  /** key 为 null 时直接执行；否则同 key 同请求体回放，同 key 不同请求体 409。handler 在同一事务里执行。 */
  run(actor: number, route: string, key: string | null, requestBody: unknown, handler: () => IdempotentResult): IdempotentResult;
  /** handler 含外部请求（不能放进事务）时：先查重，执行完再登记；同一 key 并发的第二个请求 409。 */
  runAsync(actor: number, route: string, key: string | null, requestBody: unknown, handler: () => Promise<IdempotentResult>): Promise<IdempotentResult>;
}

export function createIdempotencyStore(db: Db, clock: () => number): IdempotencyStore {
  const find = db.prepare("SELECT request_hash, status, response_json, created_at FROM idempotency_keys WHERE github_id = ? AND route = ? AND key = ?");
  const insert = db.prepare("INSERT INTO idempotency_keys (github_id, route, key, request_hash, status, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const purge = db.prepare("DELETE FROM idempotency_keys WHERE created_at < ?");
  const remove = db.prepare("DELETE FROM idempotency_keys WHERE github_id = ? AND route = ? AND key = ?");
  const inflight = new Set<string>();
  const replay = (actor: number, route: string, key: string, hash: string): IdempotentResult | null => {
    purge.run(clock() - IDEMPOTENCY_TTL_MS);
    const existing = find.get(actor, route, key) as { request_hash: string; status: number; response_json: string | null } | undefined;
    if (!existing) return null;
    if (existing.request_hash !== hash) throw new PlatformError(409, "idempotency_key_reused", "同一个 Idempotency-Key 配了不同的请求内容");
    if (existing.response_json === null) throw new PlatformError(409, "secret_already_issued", "这次请求的一次性密钥已经发出过，不会再次显示，也不会生成第二枚");
    return { status: existing.status, body: JSON.parse(existing.response_json) as unknown };
  };
  return {
    async runAsync(actor, route, key, requestBody, handler) {
      if (key === null) return handler();
      const hash = sha256Hex(canonicalJson(requestBody));
      const previous = replay(actor, route, key, hash);
      if (previous) return previous;
      const slot = `${actor}\0${route}\0${key}`;
      if (inflight.has(slot)) throw new PlatformError(409, "idempotency_in_progress", "同一个 Idempotency-Key 的请求正在处理");
      inflight.add(slot);
      try {
        const result = await handler();
        if (result.status < 300) insert.run(actor, route, key, hash, result.status, result.secret ? null : JSON.stringify(result.body), clock());
        return result;
      } finally {
        inflight.delete(slot);
      }
    },
    run(actor, route, key, requestBody, handler) {
      if (key === null) return db.transaction(handler)();
      const hash = sha256Hex(canonicalJson(requestBody));
      return db.transaction((): IdempotentResult => {
        const now = clock();
        const previous = replay(actor, route, key, hash);
        if (previous) return previous;
        const result = handler();
        if (result.status < 300) insert.run(actor, route, key, hash, result.status, result.secret ? null : JSON.stringify(result.body), now);
        else remove.run(actor, route, key);
        return result;
      })();
    },
  };
}

// ---------------------------------------------------------------------------
// control 自用的短期密文（device_code）：AES-256-GCM，密钥由 master key 按用途派生。
// ---------------------------------------------------------------------------

export interface LocalVault {
  seal(plain: string): string;
  open(sealed: string): string;
}

export function createLocalVault(masterKey: Buffer, purpose: string): LocalVault {
  const key = createHmac("sha256", masterKey).update(`geek-bot/${purpose}/v1`).digest();
  return {
    seal(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
    },
    open(sealed) {
      const [version, iv, tag, body] = sealed.split(".");
      if (version !== "v1" || !iv || !tag || body === undefined) throw new Error("密文格式不对");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
    },
  };
}
