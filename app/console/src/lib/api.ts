/**
 * 调用 control 后台 API 的客户端（docs/architecture/API.md「约定」）。本目录不导入 Vue，可以直接在 Node 里测试。
 *
 * - 只发同源请求，带 cookie；浏览器里没有任何令牌。
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

export interface ApiClient {
  get<T>(path: string, options?: { signal?: AbortSignal }): Promise<T>;
}

/** 只允许后台 API 的路径：`/api/v1/*`、`/api/release`；不接受完整 URL（防止请求被带到别的源），也不接受 `..`（浏览器会把它规范化成别的路径）。 */
const API_PATH_RE = /^\/api\/(?:v1\/[A-Za-z0-9_\-/.?=&%:,]*|release)$/;

export function createApiClient(fetchImpl: FetchLike): ApiClient {
  return {
    async get<T>(path: string, options: { signal?: AbortSignal } = {}): Promise<T> {
      if (!API_PATH_RE.test(path) || path.includes("..")) throw new TypeError(`不是后台 API 的路径：${path}`);
      let response: Response;
      try {
        response = await fetchImpl(path, {
          method: "GET",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
          signal: options.signal,
        });
      } catch (cause) {
        if (options.signal?.aborted) throw cause;
        throw new ApiError("network", "没有收到控制面的响应");
      }
      const requestId = response.headers.get("X-Request-Id");
      const body = await readJson(response);
      if (!response.ok) {
        const error = errorBodyOf(body);
        throw new ApiError("http", error?.message ?? `请求失败（HTTP ${response.status}）`, {
          status: response.status,
          code: error?.code ?? null,
          requestId,
        });
      }
      if (body === undefined) throw new ApiError("invalid_response", "控制面返回的不是 JSON", { status: response.status, requestId });
      return body as T;
    },
  };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
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
