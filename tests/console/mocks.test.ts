import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../app/console/src/lib/api.js";
import { SAMPLE_RESOURCES } from "../../app/console/src/mocks/data.js";
import { SAMPLE_SCENARIOS, SLOW_DELAY_MS, createSampleFetch, readScenario } from "../../app/console/src/mocks/index.js";
import { CONSOLE_PAGES } from "../../app/console/src/shell/pages.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("样板数据模式", () => {
  it("从 ?sample= 读场景，不认识的值当作 ok", () => {
    expect(readScenario("?sample=error")).toBe("error");
    expect(readScenario("?sample=bogus")).toBe("ok");
    expect(readScenario("")).toBe("ok");
    expect([...SAMPLE_SCENARIOS]).toEqual(["ok", "empty", "slow", "error", "forbidden", "unauthenticated", "offline"]);
  });

  it("每个页面的数据端点都有样板响应", () => {
    for (const page of CONSOLE_PAGES) expect(Object.keys(SAMPLE_RESOURCES)).toContain(page.endpoint);
  });

  it("任何场景都不调用真实的 fetch", async () => {
    const realFetch = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", realFetch);
    for (const scenario of SAMPLE_SCENARIOS) {
      const api = createApiClient(createSampleFetch({ scenario, sleep: async () => {} }));
      for (const page of CONSOLE_PAGES) await api.get(page.endpoint).catch(() => undefined);
      await api.get("/api/v1/me");
    }
    expect(realFetch).not.toHaveBeenCalled();
  });

  it("各场景返回约定的状态与机器码，request id 递增", async () => {
    const cases = [
      ["error", 500, "internal_error"],
      ["forbidden", 403, "forbidden"],
      ["unauthenticated", 401, "unauthenticated"],
    ] as const;
    for (const [scenario, status, code] of cases) {
      const api = createApiClient(createSampleFetch({ scenario }));
      await expect(api.get("/api/v1/tasks")).rejects.toMatchObject({ kind: "http", status, code, requestId: "sample-req-0001" });
      await expect(api.get("/api/v1/tasks")).rejects.toMatchObject({ requestId: "sample-req-0002" });
    }
    const offline = createApiClient(createSampleFetch({ scenario: "offline" }));
    await expect(offline.get("/api/v1/tasks")).rejects.toMatchObject({ kind: "network" });
  });

  it("empty 场景只把列表清空，外壳用的 me 与 release 照常返回", async () => {
    const api = createApiClient(createSampleFetch({ scenario: "empty" }));
    await expect(api.get("/api/v1/tasks")).resolves.toEqual({ items: [], next_cursor: null });
    await expect(api.get("/api/v1/bot-account")).resolves.toMatchObject({ bound: true });
    await expect(api.get("/api/v1/me")).resolves.toMatchObject({ role: "owner" });
    await expect(api.get("/api/release")).resolves.toMatchObject({ display: "本地开发 · 未发布" });
  });

  it("slow 场景先等待再返回", async () => {
    const sleep = vi.fn(async () => {});
    const api = createApiClient(createSampleFetch({ scenario: "slow", sleep }));
    await expect(api.get("/api/v1/nodes")).resolves.toMatchObject({ items: expect.any(Array) });
    expect(sleep).toHaveBeenCalledWith(SLOW_DELAY_MS);
  });

  it("未知路径 404、写请求 405", async () => {
    const fetchImpl = createSampleFetch({ scenario: "ok" });
    expect((await fetchImpl("/api/v1/unknown")).status).toBe(404);
    expect((await fetchImpl("/api/v1/tasks", { method: "POST" })).status).toBe(405);
  });
});

describe("页面清单", () => {
  it("名称、路径唯一，路径与数据端点形状正确，图标来自 Carbon 图标集", () => {
    const names = CONSOLE_PAGES.map(page => page.name);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(CONSOLE_PAGES.map(page => page.path)).size).toBe(names.length);
    for (const page of CONSOLE_PAGES) {
      expect(page.path).toBe(`/${page.name}`);
      expect(page.endpoint).toMatch(/^\/api\/v1\/[a-z-]+$/);
      expect(page.icon).toMatch(/^i-carbon-[a-z0-9-]+$/);
    }
  });
});
