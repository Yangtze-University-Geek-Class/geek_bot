/**
 * 样板数据模式：在页面内替代 fetch，全部数据虚构，不发任何网络请求（DESIGN、TESTING「隔离」）。
 * 只在 `vite --mode sample` / `vite build --mode sample` 时被动态导入；正式构建里这段代码会被整段去掉，
 * 真实模式只走同源的 control，不可能落到这里。
 *
 * 测试范围：只读页面、各数据状态与界面规则（浏览器回归）。所有写请求一律返回 405，界面按真实失败显示，不假装成功；
 * 写操作、认领与登录的真实行为只在连着 control 的真实模式里验证。
 *
 * 用地址栏的 `?sample=<场景>` 切换数据端点的响应，外壳用的 `/api/v1/me`、`/api/v1/auth/state`、`/api/release` 不受影响：
 * ok（默认）、empty（列表为空）、slow（1.5 秒后返回）、error（500）、forbidden（403）、unauthenticated（401）、offline（没有响应）。
 */
import type { ApiErrorBody } from "@geek-bot/protocol";
import type { FetchLike } from "../lib/api.js";
import { SAMPLE_AUTH_STATE, SAMPLE_DETAILS, SAMPLE_ME, SAMPLE_RELEASE, SAMPLE_RESOURCES, sampleSubList } from "./data.js";

export const SAMPLE_SCENARIOS = Object.freeze(["ok", "empty", "slow", "error", "forbidden", "unauthenticated", "offline"] as const);
export type SampleScenario = (typeof SAMPLE_SCENARIOS)[number];

/** slow 场景的延迟：足够看到加载状态，又不拖慢回归。 */
export const SLOW_DELAY_MS = 1_500;

/** 从地址栏的查询串读出场景；不认识的值当作 ok。 */
export function readScenario(search: string): SampleScenario {
  const value = new URLSearchParams(search).get("sample");
  return (SAMPLE_SCENARIOS as readonly string[]).includes(value ?? "") ? (value as SampleScenario) : "ok";
}

export interface SampleFetchOptions {
  readonly scenario: SampleScenario;
  readonly sleep?: (ms: number) => Promise<void>;
}

const SHELL_PATHS: Readonly<Record<string, unknown>> = {
  "/api/release": SAMPLE_RELEASE,
  "/api/v1/me": SAMPLE_ME,
  "/api/v1/auth/state": SAMPLE_AUTH_STATE,
};

/** 解析出的样板响应：list 是要分页、筛选的记录；record 是单个对象（带 revision 时给 ETag）。 */
type Resolved = { readonly kind: "list"; readonly items: readonly unknown[] } | { readonly kind: "record"; readonly body: unknown };

function resolve(pathname: string): Resolved | null {
  const top = SAMPLE_RESOURCES[pathname];
  if (Array.isArray(top)) return { kind: "list", items: top };
  if (top !== undefined) return { kind: "record", body: top };
  const match = /^(\/api\/v1\/[a-z-]+)\/([^/]+)(?:\/([a-z]+))?$/.exec(pathname);
  if (!match) return null;
  const [, collection, rawId, sub] = match;
  const id = decodeURIComponent(rawId);
  const records = SAMPLE_DETAILS[collection];
  if (!records) return null;
  const record = records.find(candidate => candidate.id === id);
  if (!record) return null;
  if (!sub) return { kind: "record", body: record };
  const items = sampleSubList(collection, id, sub);
  return items ? { kind: "list", items } : null;
}

/** 按查询参数做等值筛选（status、project_id、demand_id、connection_id、kind 等），search 匹配名称或路径；limit 截断。 */
function filterList(items: readonly unknown[], params: URLSearchParams): { items: unknown[]; next_cursor: null } {
  const filtered = items.filter(item => {
    if (typeof item !== "object" || item === null) return false;
    const fields: Readonly<Record<string, unknown>> = { ...item };
    for (const [key, value] of params) {
      if (key === "limit" || key === "cursor") continue;
      if (key === "search") {
        const text = `${String(fields.name ?? "")} ${String(fields.path ?? "")}`.toLowerCase();
        if (!text.includes(value.toLowerCase())) return false;
        continue;
      }
      if (key in fields && String(fields[key]) !== value) return false;
    }
    return true;
  });
  const limit = Number(params.get("limit") ?? "50");
  return { items: filtered.slice(0, Number.isFinite(limit) && limit > 0 ? limit : 50), next_cursor: null };
}

export function createSampleFetch(options: SampleFetchOptions): FetchLike {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(done => setTimeout(done, ms)));
  let counter = 0;
  const nextRequestId = () => `sample-req-${String(++counter).padStart(4, "0")}`;

  return async (input: string, init?: RequestInit) => {
    const url = new URL(input, "http://sample.invalid");
    const method = (init?.method ?? "GET").toUpperCase();
    const requestId = nextRequestId();
    if (method !== "GET") return errorResponse(405, "sample_read_only", "样板数据模式只读：写操作没有发出，需要在连着控制面的真实后台里操作", requestId);

    if (url.pathname in SHELL_PATHS) return jsonResponse(200, SHELL_PATHS[url.pathname], requestId);
    const resolved = resolve(url.pathname);
    if (!resolved) return errorResponse(404, "not_found", "资源或路由不存在", requestId);

    switch (options.scenario) {
      case "slow":
        await sleep(SLOW_DELAY_MS);
        break;
      case "empty":
        if (resolved.kind === "list") return jsonResponse(200, { items: [], next_cursor: null }, requestId);
        break;
      case "error":
        return errorResponse(500, "internal_error", "内部错误", requestId);
      case "forbidden":
        return errorResponse(403, "forbidden", "当前角色不能查看这些数据", requestId);
      case "unauthenticated":
        return errorResponse(401, "unauthenticated", "没有会话或会话已过期", requestId);
      case "offline":
        // 与浏览器里断网时 fetch 的表现一致：抛 TypeError，没有响应。
        throw new TypeError("Failed to fetch");
      default:
        break;
    }
    if (resolved.kind === "list") return jsonResponse(200, filterList(resolved.items, url.searchParams), requestId);
    const body = resolved.body;
    const revision = typeof body === "object" && body !== null && "revision" in body ? body.revision : undefined;
    return jsonResponse(200, body, requestId, typeof revision === "number" ? `"${revision}"` : null);
  };
}

function jsonResponse(status: number, body: unknown, requestId: string, etag: string | null = null): Response {
  const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8", "X-Request-Id": requestId };
  if (etag) headers.ETag = etag;
  return new Response(JSON.stringify(body), { status, headers });
}

function errorResponse(status: number, code: string, message: string, requestId: string): Response {
  const body: ApiErrorBody = { error: { code, message } };
  return jsonResponse(status, body, requestId);
}
