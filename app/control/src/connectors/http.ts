import { ConnectorError, type FetchLike } from "./types.js";

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConnectorError("upstream_invalid", "渠道返回的对象格式不正确");
  return value as Record<string, unknown>;
}
export function string(value: unknown, fallback = ""): string { return typeof value === "string" ? value : fallback; }
export function identifier(value: unknown): string {
  if (typeof value === "string" && value.length > 0 && value.length <= 256) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  throw new ConnectorError("upstream_invalid", "渠道返回的资源标识不正确");
}
export function integer(value: unknown, fallback = 0): number { return typeof value === "number" && Number.isSafeInteger(value) ? value : fallback; }
export function timestamp(value: unknown): string {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed)) throw new ConnectorError("upstream_invalid", "渠道返回的时间格式不正确");
  return new Date(parsed).toISOString();
}
export function publicBaseUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ConnectorError("connection_invalid", "渠道地址不是合法的 URL", 422); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new ConnectorError("connection_invalid", "渠道地址不能带账号、密码、查询串或片段", 422);
  url.pathname = url.pathname.replace(/\/+$/, "") + "/";
  return url;
}

export async function boundedBody(response: Response, maximum = 16 * 1024 * 1024): Promise<Buffer> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maximum) throw new ConnectorError("upstream_too_large", "渠道响应超过允许大小");
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maximum) { await reader.cancel(); throw new ConnectorError("upstream_too_large", "渠道响应超过允许大小"); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, bytes);
}

/** 不追随认证请求的重定向；Link 分页必须仍在管理员指定的同一 API 起点下。 */
export class ApiTransport {
  readonly base: URL;
  constructor(baseUrl: string, private readonly headers: Readonly<Record<string, string>>, private readonly fetchImpl: FetchLike = globalThis.fetch) { this.base = publicBaseUrl(baseUrl); }
  url(path: string): URL {
    const url = new URL(path, this.base);
    if (url.origin !== this.base.origin || !url.pathname.startsWith(this.base.pathname) || url.username || url.password || url.hash) throw new ConnectorError("upstream_redirect_rejected", "渠道请求离开了配置的 API 范围");
    return url;
  }
  async response(path: string, init: RequestInit = {}): Promise<Response> {
    const url = this.url(path);
    const supplied = new Headers(init.headers);
    for (const [key, value] of Object.entries(this.headers)) if (key.toLowerCase() === "authorization" || !supplied.has(key)) supplied.set(key, value);
    const timer = AbortSignal.timeout(30_000);
    const signal = init.signal ? AbortSignal.any([timer, init.signal]) : timer;
    let response: Response;
    try { response = await this.fetchImpl(url, { ...init, headers: supplied, redirect: "manual", signal }); }
    catch (error) {
      if (signal.aborted) throw new ConnectorError("upstream_timeout", "渠道请求超时", 504);
      throw new ConnectorError("upstream_unavailable", "渠道连接失败");
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) throw new ConnectorError("connection_unauthorized", "渠道令牌无效或已失效", 401);
      if (response.status === 403) throw new ConnectorError("connection_forbidden", "渠道权限不足或请求被限流", 403);
      if (response.status === 404) throw new ConnectorError("upstream_not_found", "渠道资源不存在或不再可访问", 404);
      if (response.status >= 300 && response.status < 400) throw new ConnectorError("upstream_redirect_rejected", "渠道返回重定向，请管理员更新连接地址", 409);
      throw new ConnectorError("upstream_error", `渠道返回 HTTP ${response.status}`);
    }
    return response;
  }
  async json(path: string, init: RequestInit = {}): Promise<{ data: unknown; response: Response }> {
    const response = await this.response(path, init);
    const bytes = await boundedBody(response);
    let data: unknown;
    try { data = JSON.parse(bytes.toString("utf8")); } catch { throw new ConnectorError("upstream_invalid", "渠道返回的不是合法 JSON"); }
    return { data, response };
  }
  async get(path: string): Promise<unknown> { return (await this.json(path)).data; }
  async pages(path: string): Promise<readonly Record<string, unknown>[]> {
    const collected: Record<string, unknown>[] = [];
    let next: string | null = path;
    const seen = new Set<string>();
    for (let page = 0; next !== null; page++) {
      if (page >= 1000 || seen.has(this.url(next).href)) throw new ConnectorError("upstream_pagination_invalid", "渠道分页没有收敛");
      seen.add(this.url(next).href);
      const { data, response } = await this.json(next);
      if (!Array.isArray(data)) throw new ConnectorError("upstream_invalid", "渠道列表不是数组");
      for (const row of data) collected.push(object(row));
      const links = response.headers.get("link") ?? "";
      const linked = /<([^>]+)>\s*;\s*rel="next"/.exec(links)?.[1];
      const gitlabNext = response.headers.get("x-next-page");
      if (linked) next = this.url(linked).href;
      else if (gitlabNext && /^[1-9][0-9]*$/.test(gitlabNext)) { const target = this.url(next); target.searchParams.set("page", gitlabNext); next = target.href; }
      else if (gitlabNext !== null || data.length < 100) next = null;
      else { const target = this.url(next); target.searchParams.set("page", String(Number(target.searchParams.get("page") ?? "1") + 1)); next = target.href; }
    }
    return collected;
  }
}
