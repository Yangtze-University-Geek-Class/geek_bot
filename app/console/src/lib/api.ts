/**
 * 调用 control 后台 API 的客户端（docs/architecture/API.md「约定」）。本目录不导入 Vue，可以直接在 Node 里测试。
 *
 * - 只发同源请求，带 cookie；浏览器里没有任何令牌。写请求由浏览器自动带 Origin，请求体一律是 JSON。
 * - 配置类读取带回 ETag（`"<revision>"`），更新时作为 If-Match 发回；创建类带 Idempotency-Key。
 * - 错误统一变成 ApiError：HTTP 错误带状态码、机器码和 X-Request-Id；连不上服务端是 network。
 * - fetch 由调用方注入：样板数据模式注入页面内的打桩实现，测试注入假实现，不发真实请求。
 */
import type { ApiErrorBody } from "@geek-bot/protocol";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** 错误的大类：http 是服务端回了错误响应；network 是请求没有得到响应；invalid_response 是回了看不懂的内容。 */
export type ApiErrorKind = "http" | "network" | "invalid_response";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  /** HTTP 状态码；network 时为 null。 */
  readonly status: number | null;
  /** API.md 错误格式里的 code；取不到时为 null。 */
  readonly code: string | null;
  /** 响应头 X-Request-Id；取不到时为 null。 */
  readonly requestId: string | null;

  constructor(kind: ApiErrorKind, message: string, detail: { status?: number | null; code?: string | null; requestId?: string | null } = {}) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = detail.status ?? null;
    this.code = detail.code ?? null;
    this.requestId = detail.requestId ?? null;
  }
}

export type WriteMethod = "POST" | "PATCH" | "PUT" | "DELETE";

export interface ReadOptions {
  readonly signal?: AbortSignal;
}

export interface WriteOptions {
  readonly body?: unknown;
  /** 配置更新的乐观并发：GET 拿到的 ETag，原样作为 If-Match 发回。 */
  readonly ifMatch?: string | null;
  /** 创建类请求的幂等键（1–64 位 `[A-Za-z0-9_-]`）；同一次用户动作重试时复用。 */
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

/** 读取单个资源的结果：数据与 ETag（没有时为 null）。 */
export interface Versioned<T> {
  readonly data: T;
  readonly etag: string | null;
}

export interface ApiClient {
  get<T>(path: string, options?: ReadOptions): Promise<T>;
  /** 读取并带回 ETag，供随后的 PATCH / PUT 作为 If-Match。 */
  getVersioned<T>(path: string, options?: ReadOptions): Promise<Versioned<T>>;
  /** 写请求；204 返回 undefined。 */
  send<T>(method: WriteMethod, path: string, options?: WriteOptions): Promise<T>;
}

/** 字面上只允许以 `/` 开头的后台 API 路径（不接受完整 URL 与 `//` 开头的协议相对地址，防止请求被带到别的源）。 */
const API_PATH_RE = /^\/api\/(?:v1\/[A-Za-z0-9_\-/.?=&%:,]*|release)$/;
/** 占位源：只用来按浏览器的规则（WHATWG URL）规范化路径，不会真的发请求。 */
const NORMALIZE_BASE = "http://geek-bot.invalid";

/** 点段的各种写法：字面的 `..` 与百分号编码的点。浏览器不折叠的写法（例如 `..%2f`）服务端解码后仍可能当作点段。 */
const DOT_SEGMENT_RE = /\.\.|%2e/i;

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 路径是否仍是后台 API：不含任何写法的点段；按浏览器的规则（WHATWG URL）规范化后，
 * 路径仍在 `/api/v1/` 下或等于 `/api/release`，并且和原样一致，没有被改写成别的路径。
 */
export function isApiPath(path: string): boolean {
  if (!API_PATH_RE.test(path) || DOT_SEGMENT_RE.test(path)) return false;
  const url = new URL(path, NORMALIZE_BASE);
  if (url.origin !== NORMALIZE_BASE) return false;
  const inScope = url.pathname === "/api/release" || url.pathname.startsWith("/api/v1/");
  return inScope && `${url.pathname}${url.search}` === path;
}

/** 生成一次用户动作的幂等键：同一个表单重试时复用，提交成功后换新的。 */
export function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

/** 把记录里的 revision 写成 If-Match 用的 ETag 形状；GET 没带 ETag 头时用它兜底。 */
export function etagOf(revision: number): string {
  return `"${revision}"`;
}

export function createApiClient(fetchImpl: FetchLike): ApiClient {
  async function perform(method: "GET" | WriteMethod, path: string, init: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal }) {
    if (!isApiPath(path)) throw new TypeError(`不是后台 API 的路径：${path}`);
    const headers: Record<string, string> = { Accept: "application/json", ...init.headers };
    let body: string | undefined;
    if (method !== "GET") {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.body ?? {});
    }
    let response: Response;
    try {
      response = await fetchImpl(path, { method, credentials: "same-origin", headers, body, signal: init.signal });
    } catch (cause) {
      if (init.signal?.aborted) throw cause;
      throw new ApiError("network", "没有收到控制面的响应");
    }
    const requestId = response.headers.get("X-Request-Id");
    if (response.status === 204) return { response, requestId, data: undefined as unknown };
    const data = await readJson(response, init.signal);
    if (!response.ok) {
      const error = errorBodyOf(data);
      throw new ApiError("http", error?.message ?? `请求失败（HTTP ${response.status}）`, {
        status: response.status,
        code: error?.code ?? null,
        requestId,
      });
    }
    if (data === undefined) throw new ApiError("invalid_response", "控制面返回的不是 JSON", { status: response.status, requestId });
    return { response, requestId, data };
  }

  return {
    async get<T>(path: string, options: ReadOptions = {}): Promise<T> {
      const { data } = await perform("GET", path, { signal: options.signal });
      return data as T;
    },
    async getVersioned<T>(path: string, options: ReadOptions = {}): Promise<Versioned<T>> {
      const { data, response } = await perform("GET", path, { signal: options.signal });
      return { data: data as T, etag: response.headers.get("ETag") };
    },
    async send<T>(method: WriteMethod, path: string, options: WriteOptions = {}): Promise<T> {
      const headers: Record<string, string> = {};
      if (options.ifMatch) headers["If-Match"] = options.ifMatch;
      if (options.idempotencyKey !== undefined) {
        if (!IDEMPOTENCY_KEY_RE.test(options.idempotencyKey)) throw new TypeError("Idempotency-Key 只能是 1 到 64 位的字母、数字、下划线或连字符");
        headers["Idempotency-Key"] = options.idempotencyKey;
      }
      const { data } = await perform(method, path, { body: options.body, headers, signal: options.signal });
      return data as T;
    },
  };
}

/** 拼查询串：跳过 undefined、null 和空字符串；值按 URL 规则编码。 */
export function withQuery(path: string, query: Readonly<Record<string, string | number | null | undefined>>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

/** 响应体解析不了时返回 undefined；读的过程中被取消则原样抛出取消，不改写成「不是 JSON」。 */
async function readJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    if (signal?.aborted) throw cause;
    return undefined;
  }
}

function errorBodyOf(body: unknown): ApiErrorBody["error"] | null {
  if (typeof body !== "object" || body === null || !("error" in body)) return null;
  const error = (body as { error: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  const { code, message } = error as Record<string, unknown>;
  return typeof code === "string" && typeof message === "string" ? { code, message } : null;
}

/**
 * 失败状态里给维护者看的一行：`HTTP 状态 · 机器码 · request id`（DESIGN「文案」）。
 * 缺的部分写明缺了，不省略，方便对照服务端日志。
 */
export function describeError(error: ApiError): string {
  if (error.kind === "network") return "网络错误 · 没有响应";
  const status = error.status === null ? "HTTP ?" : `HTTP ${error.status}`;
  return [status, error.code ?? "无机器码", error.requestId ?? "无 request id"].join(" · ");
}

/** 任意异常转成 ApiError，页面与操作反馈统一处理。 */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError("invalid_response", error instanceof Error ? error.message : String(error));
}
