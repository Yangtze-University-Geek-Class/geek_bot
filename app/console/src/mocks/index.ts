/**
 * 样板数据模式：在页面内替代 fetch，全部数据虚构，不发任何网络请求（DESIGN、TESTING「隔离」）。
 * 只在 `vite --mode sample` / `vite build --mode sample` 时被动态导入；正式构建里这段代码会被整段去掉。
 *
 * 用地址栏的 `?sample=<场景>` 切换页面数据端点的响应，外壳用的 `/api/v1/me` 与 `/api/release` 不受影响：
 * ok（默认）、empty（列表为空）、slow（1.5 秒后返回）、error（500）、forbidden（403）、unauthenticated（401）、offline（没有响应）。
 */
import type { ApiErrorBody } from "@geek-bot/protocol";
import type { FetchLike } from "../lib/api.js";
import { SAMPLE_ME, SAMPLE_RELEASE, SAMPLE_RESOURCES } from "./data.js";

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
};

export function createSampleFetch(options: SampleFetchOptions): FetchLike {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let counter = 0;
  const nextRequestId = () => `sample-req-${String(++counter).padStart(4, "0")}`;

  return async (input: string, init?: RequestInit) => {
    const url = new URL(input, "http://sample.invalid");
    const method = (init?.method ?? "GET").toUpperCase();
    const requestId = nextRequestId();
    if (method !== "GET") return errorResponse(405, "method_not_allowed", "样板数据模式只支持读取", requestId);

    if (url.pathname in SHELL_PATHS) return jsonResponse(200, SHELL_PATHS[url.pathname], requestId);
    if (!(url.pathname in SAMPLE_RESOURCES)) return errorResponse(404, "not_found", "资源或路由不存在", requestId);

    switch (options.scenario) {
      case "slow":
        await sleep(SLOW_DELAY_MS);
        return jsonResponse(200, SAMPLE_RESOURCES[url.pathname], requestId);
      case "empty": {
        const data = SAMPLE_RESOURCES[url.pathname];
        const isList = typeof data === "object" && data !== null && "items" in data;
        return jsonResponse(200, isList ? { items: [], next_cursor: null } : data, requestId);
      }
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
        return jsonResponse(200, SAMPLE_RESOURCES[url.pathname], requestId);
    }
  };
}

function jsonResponse(status: number, body: unknown, requestId: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "X-Request-Id": requestId },
  });
}

function errorResponse(status: number, code: string, message: string, requestId: string): Response {
  const body: ApiErrorBody = { error: { code, message } };
  return jsonResponse(status, body, requestId);
}
