import { describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient, describeError, isApiPath, type FetchLike } from "../../app/console/src/lib/api.js";
import { isEmptyResult, stateFromData, stateFromError } from "../../app/console/src/lib/page-state.js";

const json = (status: number, body: unknown, requestId: string | null = "req-1") =>
  new Response(JSON.stringify(body), {
    status,
    headers: requestId ? { "Content-Type": "application/json", "X-Request-Id": requestId } : { "Content-Type": "application/json" },
  });

describe("createApiClient", () => {
  it("同源 GET，带 cookie，返回 JSON", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => json(200, { items: [1], next_cursor: null }));
    const api = createApiClient(fetchImpl);
    await expect(api.get("/api/v1/tasks")).resolves.toEqual({ items: [1], next_cursor: null });
    expect(fetchImpl).toHaveBeenCalledWith("/api/v1/tasks", expect.objectContaining({ method: "GET", credentials: "same-origin" }));
  });

  it("按 API.md 的错误格式取出状态码、机器码、说明与 X-Request-Id", async () => {
    const api = createApiClient(async () => json(403, { error: { code: "forbidden", message: "角色不够" } }, "req-42"));
    const error = await api.get("/api/v1/repos").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ kind: "http", status: 403, code: "forbidden", message: "角色不够", requestId: "req-42" });
  });

  it("错误响应不是约定的格式时，保留状态码，机器码为空", async () => {
    const api = createApiClient(async () => new Response("<html>bad gateway</html>", { status: 502 }));
    const error = await api.get("/api/v1/overview").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: "http", status: 502, code: null, requestId: null });
  });

  it("fetch 抛错（断网、连不上）变成 network 错误", async () => {
    const api = createApiClient(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(api.get("/api/v1/overview")).rejects.toMatchObject({ kind: "network", status: null });
  });

  it("成功响应不是 JSON 时报 invalid_response，不当成空数据", async () => {
    const api = createApiClient(async () => new Response("ok", { status: 200, headers: { "X-Request-Id": "req-7" } }));
    await expect(api.get("/api/v1/overview")).rejects.toMatchObject({ kind: "invalid_response", requestId: "req-7" });
  });

  it("读响应体时被取消，原样抛出取消，不改写成 invalid_response", async () => {
    const controller = new AbortController();
    const api = createApiClient(async () => {
      const body = new ReadableStream({
        start(stream) {
          stream.enqueue(new TextEncoder().encode("{"));
          controller.abort();
          stream.error(new DOMException("aborted", "AbortError"));
        },
      });
      return new Response(body, { status: 200 });
    });
    const error = await api.get("/api/v1/overview", { signal: controller.signal }).catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(ApiError);
  });

  it("主动取消时原样抛出取消，不改写成 network", async () => {
    const controller = new AbortController();
    const api = createApiClient(async (_input, init) => {
      controller.abort();
      throw init?.signal?.reason ?? new Error("aborted");
    });
    const error = await api.get("/api/v1/overview", { signal: controller.signal }).catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(ApiError);
  });

  it("只接受后台 API 路径：完整 URL、别的前缀直接拒绝，不发请求", async () => {
    const fetchImpl = vi.fn<FetchLike>();
    const api = createApiClient(fetchImpl);
    for (const path of ["https://geek-bot.example.com/api/v1/me", "//evil.example.com/api/v1/me", "/healthz", "/api/v2/me", "api/v1/me", "/api/v1/../healthz", "/api/v1/tasks/..%2f"]) {
      await expect(api.get(path)).rejects.toThrow(TypeError);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(api.get("/api/release")).rejects.toBeDefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("isApiPath", () => {
  it("接受后台 API 路径与查询串", () => {
    for (const path of ["/api/v1/me", "/api/release", "/api/v1/tasks?state=queued&limit=50", "/api/v1/stream?topics=overview,task%3At1"]) {
      expect(isApiPath(path), path).toBe(true);
    }
  });

  it("拒绝点段（含百分号编码）、完整 URL、协议相对地址与别的前缀", () => {
    for (const path of [
      "/api/v1/../healthz",
      "/api/v1/%2e%2e/%2e%2e/healthz",
      "/api/v1/.%2e/node/v1/tasks",
      "/api/v1/%2E%2E/release",
      "/api/v1/./me",
      "/api/v1/tasks/..%2f",
      "/api/v1/tasks/%2E",
      "https://geek-bot.example.com/api/v1/me",
      "//evil.example.com/api/v1/me",
      "/api/node/v1/tasks",
      "/api/releases",
    ]) {
      expect(isApiPath(path), path).toBe(false);
    }
  });
});

describe("describeError", () => {
  it("写成 `HTTP 状态 · 机器码 · request id`，缺的部分写明缺了", () => {
    expect(describeError(new ApiError("http", "x", { status: 500, code: "internal_error", requestId: "req-1" }))).toBe("HTTP 500 · internal_error · req-1");
    expect(describeError(new ApiError("http", "x", { status: 502 }))).toBe("HTTP 502 · 无机器码 · 无 request id");
    expect(describeError(new ApiError("network", "x"))).toBe("网络错误 · 没有响应");
  });
});

describe("页面状态", () => {
  it("只有列表响应没有条目时算空", () => {
    expect(isEmptyResult({ items: [], next_cursor: null })).toBe(true);
    expect(isEmptyResult({ items: [1], next_cursor: null })).toBe(false);
    expect(isEmptyResult({ nodes: 0 })).toBe(false);
    expect(isEmptyResult(null)).toBe(false);
    expect(stateFromData({ items: [] })).toEqual({ kind: "empty" });
    expect(stateFromData({ bound: true })).toEqual({ kind: "ready", data: { bound: true } });
  });

  it("401 → 未登录，403 → 无权限，没有响应 → 离线，其余 → 失败", () => {
    expect(stateFromError(new ApiError("http", "x", { status: 401 })).kind).toBe("unauthenticated");
    expect(stateFromError(new ApiError("http", "x", { status: 403, code: "reauth_required" })).kind).toBe("forbidden");
    expect(stateFromError(new ApiError("network", "x")).kind).toBe("offline");
    expect(stateFromError(new ApiError("http", "x", { status: 500 })).kind).toBe("error");
    expect(stateFromError(new ApiError("invalid_response", "x")).kind).toBe("error");
  });

  it("不是 ApiError 的异常也落到失败状态，不丢失说明", () => {
    const state = stateFromError(new Error("意外"));
    expect(state).toMatchObject({ kind: "error", error: { kind: "invalid_response", message: "意外" } });
  });
});
