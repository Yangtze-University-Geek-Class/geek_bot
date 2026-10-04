/**
 * 共享平台路由共用的 HTTP 约定（API.md「约定」）：业务错误、cookie、游标分页、ETag/If-Match、随机 id 与哈希。
 * 路由模块只经这里拿到这些约定，不各自复制一份。
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { errorBody } from "../http/errors.js";

/** 业务错误：路由与服务抛出，统一错误处理转成 API.md 的错误体。message 是中文，不含密钥和原始请求值。 */
export class PlatformError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "PlatformError";
  }
}

export function sendPlatformError(reply: FastifyReply, error: PlatformError): FastifyReply {
  for (const [name, value] of Object.entries(error.headers)) reply.header(name, value);
  return reply.code(error.status).send(errorBody(error.code, error.message));
}

export const notFound = (what = "资源"): PlatformError => new PlatformError(404, "not_found", `${what}不存在`);

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** 256 位随机值的 base64url。 */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** control 生成的不透明 id：前缀加 128 位随机数。 */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function isoOrNull(ms: number | null | undefined): string | null {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// cookie：值是「随机值.HMAC」，先验签再查库（S-09）。
// ---------------------------------------------------------------------------

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (/^[A-Za-z0-9_-]{1,64}$/.test(name) && !cookies.has(name)) cookies.set(name, value);
  }
  return cookies;
}

export interface CookieSigner {
  /** 生成随机值并签名，返回 cookie 值与要入库的哈希。 */
  issue(purpose: string): { value: string; hash: string };
  /** 验签：通过时返回随机值的哈希（用于查库），否则 null。 */
  verify(purpose: string, value: string | undefined): string | null;
}

export function createCookieSigner(key: Buffer): CookieSigner {
  const mac = (purpose: string, raw: string) => createHmac("sha256", key).update(`${purpose}\0${raw}`).digest("base64url");
  return {
    issue(purpose) {
      const raw = randomToken(32);
      return { value: `${raw}.${mac(purpose, raw)}`, hash: sha256Hex(raw) };
    },
    verify(purpose, value) {
      if (!value || value.length > 200) return null;
      const dot = value.indexOf(".");
      if (dot <= 0) return null;
      const raw = value.slice(0, dot);
      const given = Buffer.from(value.slice(dot + 1));
      const expected = Buffer.from(mac(purpose, raw));
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
      return sha256Hex(raw);
    },
  };
}

export interface CookieOptions {
  readonly maxAgeS: number;
  readonly sameSite: "Strict" | "Lax";
  readonly secure: boolean;
}

export function setCookie(reply: FastifyReply, name: string, value: string, options: CookieOptions): void {
  const parts = [`${name}=${value}`, "Path=/", "HttpOnly", `SameSite=${options.sameSite}`, `Max-Age=${Math.max(0, Math.floor(options.maxAgeS))}`];
  if (options.secure) parts.push("Secure");
  const existing = reply.getHeader("Set-Cookie");
  const list = existing === undefined ? [] : Array.isArray(existing) ? existing.map(String) : [String(existing)];
  reply.header("Set-Cookie", [...list, parts.join("; ")]);
}

export function clearCookie(reply: FastifyReply, name: string, secure: boolean): void {
  setCookie(reply, name, "", { maxAgeS: 0, sameSite: "Strict", secure });
}

// ---------------------------------------------------------------------------
// 分页：游标是 base64url(JSON)，携带排序键与过滤条件的哈希；换了过滤条件拿旧游标返回 400。
// ---------------------------------------------------------------------------

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  if (!/^[0-9]{1,3}$/.test(raw)) throw new PlatformError(400, "validation_failed", "查询参数 limit 必须是 1 到 200 的整数");
  const value = Number(raw);
  if (value < 1 || value > MAX_LIMIT) throw new PlatformError(400, "validation_failed", "查询参数 limit 必须是 1 到 200 的整数");
  return value;
}

export type CursorKey = readonly (string | number)[];

export function encodeCursor(filters: string, key: CursorKey): string {
  return Buffer.from(JSON.stringify({ f: sha256Hex(filters).slice(0, 16), k: key })).toString("base64url");
}

export function decodeCursor(filters: string, raw: string | undefined, arity: number): CursorKey | null {
  if (raw === undefined) return null;
  const invalid = new PlatformError(400, "validation_failed", "查询参数 cursor 无效：游标只在同一排序和同一组过滤条件下有效");
  if (raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw invalid;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw invalid;
  }
  const value = parsed as { f?: unknown; k?: unknown };
  if (value.f !== sha256Hex(filters).slice(0, 16) || !Array.isArray(value.k) || value.k.length !== arity) throw invalid;
  if (!value.k.every(part => typeof part === "string" || (typeof part === "number" && Number.isFinite(part)))) throw invalid;
  return value.k as CursorKey;
}

/** 取 limit+1 行判断是否还有下一页；next_cursor 用最后一行的排序键。 */
export function pageOf<Row, Item>(rows: readonly Row[], limit: number, filters: string, keyOf: (row: Row) => CursorKey, serialize: (row: Row) => Item): { items: Item[]; next_cursor: string | null } {
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return { items: page.map(serialize), next_cursor: rows.length > limit && last !== undefined ? encodeCursor(filters, keyOf(last)) : null };
}

// ---------------------------------------------------------------------------
// 乐观并发与幂等键。
// ---------------------------------------------------------------------------

export function etag(revision: number): string {
  return `"${revision}"`;
}

/** PATCH/PUT 必须带 If-Match；不符 412，没带 428。 */
export function requireIfMatch(request: FastifyRequest, revision: number): void {
  const header = request.headers["if-match"];
  if (header === undefined || header === "") throw new PlatformError(428, "revision_required", "缺少 If-Match：先读取资源拿到 ETag 再更新");
  const value = Array.isArray(header) ? header.join(",") : header;
  const accepted = value.split(",").map(part => part.trim().replace(/^W\//, ""));
  if (!accepted.includes(etag(revision))) throw new PlatformError(412, "revision_mismatch", "资源已被别人改过：重新读取后再改");
}

export function idempotencyKeyOf(request: FastifyRequest): string | null {
  const header = request.headers["idempotency-key"];
  if (header === undefined) return null;
  if (Array.isArray(header) || !/^[A-Za-z0-9_-]{1,64}$/.test(header)) {
    throw new PlatformError(400, "validation_failed", "Idempotency-Key 只能是 1 到 64 位的字母、数字、下划线或连字符");
  }
  return header;
}

/** 规范 JSON：对象键排序，用于请求体哈希。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

/** JSON 列读取：库里的值由本进程写入，解析失败视为数据损坏。 */
export function parseJsonColumn<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback;
  return JSON.parse(text) as T;
}
