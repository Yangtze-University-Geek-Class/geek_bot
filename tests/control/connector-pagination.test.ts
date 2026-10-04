import { describe, expect, it } from "vitest";
import { ApiTransport, boundedBody } from "../../app/control/src/connectors/http.js";
import type { FetchLike } from "../../app/control/src/connectors/types.js";

const base = "https://api.example.test/api/v4/";
const json = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", ...headers } });

describe("bounded API pagination", () => {
  it("collects ordered records from same-origin Link pages without dropping their query parameters", async () => {
    const pages = new Map([
      [`${base}items?scope=owned`, () => json([{ id: 1 }], { Link: `<${base}items?scope=owned&page=2>; rel="next"` })],
      [`${base}items?scope=owned&page=2`, () => json([{ id: 2 }, { id: 3 }])],
    ]);
    const fetchImpl: FetchLike = async input => {
      const respond = pages.get(String(input));
      if (!respond) throw new Error("Unexpected pagination URL");
      return respond();
    };
    await expect(new ApiTransport(base, {}, fetchImpl).pages("items?scope=owned")).resolves.toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it("follows GitLab page headers while retaining the resource filter", async () => {
    const fetchImpl: FetchLike = async input => {
      const url = new URL(String(input));
      if (url.searchParams.get("state") !== "opened") throw new Error("Lost filter");
      if (!url.searchParams.has("page")) return json([{ id: "first" }], { "X-Next-Page": "7" });
      if (url.searchParams.get("page") === "7") return json([{ id: "seventh" }], { "X-Next-Page": "" });
      throw new Error("Unexpected page");
    };
    await expect(new ApiTransport(base, {}, fetchImpl).pages("items?state=opened")).resolves.toEqual([{ id: "first" }, { id: "seventh" }]);
  });

  it("continues a full unlinked page and stops on a short page", async () => {
    const first = Array.from({ length: 100 }, (_, id) => ({ id }));
    const fetchImpl: FetchLike = async input => {
      const page = new URL(String(input)).searchParams.get("page");
      if (page === null) return json(first);
      if (page === "2") return json([{ id: 100 }]);
      throw new Error("Read past the final page");
    };
    await expect(new ApiTransport(base, {}, fetchImpl).pages("items")).resolves.toEqual([...first, { id: 100 }]);
  });

  const privateHost = [10, 23, 45, 67].join(".");
  const malicious = [
    ["different origin", "https://outside.example.test/api/v4/items"],
    ["protocol-relative origin", "//outside.example.test/api/v4/items"],
    ["private network", `http://${privateHost}/api/v4/items`],
    ["API sibling", "/api/v40/items"],
    ["parent traversal", "../admin"],
    ["encoded parent traversal", "%2e%2e/admin"],
    ["credentials", "https://fixture:fixture@api.example.test/api/v4/items"],
    ["fragment", "items?page=2#fragment"],
    ["scheme downgrade", "http://api.example.test/api/v4/items"],
  ];
  it.each(malicious)("refuses %s next links before any second credentialed request", async (_name, next) => {
    let requests = 0;
    const fetchImpl: FetchLike = async () => {
      requests++;
      return json([{ id: 1 }], { Link: `<${next}>; rel="next"` });
    };
    const transport = new ApiTransport(base, { Authorization: "Bearer fixture" }, fetchImpl);
    await expect(transport.pages("items")).rejects.toMatchObject({ code: "upstream_redirect_rejected" });
    expect(requests).toBe(1);
  });

  it("rejects cycles using canonical URLs before revisiting a page", async () => {
    let requests = 0;
    const fetchImpl: FetchLike = async () => {
      requests++;
      return json([{ id: requests }], { Link: `<${base}items>; rel="next"` });
    };
    await expect(new ApiTransport(base, {}, fetchImpl).pages("items")).rejects.toMatchObject({ code: "upstream_pagination_invalid" });
    expect(requests).toBe(1);
  });

  it("bounds non-cyclic pagination at 1000 pages", async () => {
    let requests = 0;
    const fetchImpl: FetchLike = async () => {
      requests++;
      return json([{ id: requests }], { "X-Next-Page": String(requests + 1) });
    };
    await expect(new ApiTransport(base, {}, fetchImpl).pages("items?page=1")).rejects.toMatchObject({ code: "upstream_pagination_invalid" });
    expect(requests).toBe(1000);
  });

  it.each([{ items: [] }, [null], ["not a record"], [[]]])("rejects malformed list data %# instead of returning partial records", async body => {
    const fetchImpl: FetchLike = async () => json(body);
    await expect(new ApiTransport(base, {}, fetchImpl).pages("items")).rejects.toMatchObject({ code: "upstream_invalid" });
  });

  it("does not follow a redirect response", async () => {
    let requests = 0;
    const fetchImpl: FetchLike = async (_input, init) => {
      requests++;
      // A real fetch would follow unless manual redirects were requested.
      if (init?.redirect !== "manual") return json([{ id: "leaked" }]);
      return new Response(null, { status: 302, headers: { Location: "https://outside.example.test/items" } });
    };
    await expect(new ApiTransport(base, {}, fetchImpl).pages("items")).rejects.toMatchObject({ code: "upstream_redirect_rejected", statusCode: 409 });
    expect(requests).toBe(1);
  });
});

describe("bounded response bytes", () => {
  it("accepts an exact byte budget and rejects both declared and streamed overflow", async () => {
    await expect(boundedBody(new Response(Buffer.from([1, 2, 3, 4])), 4)).resolves.toEqual(Buffer.from([1, 2, 3, 4]));
    await expect(boundedBody(new Response("x", { headers: { "Content-Length": "5" } }), 4)).rejects.toMatchObject({ code: "upstream_too_large" });
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Buffer.from([1, 2, 3])); controller.enqueue(Buffer.from([4, 5])); },
      cancel() { cancelled = true; },
    });
    await expect(boundedBody(new Response(body, { headers: { "Content-Length": "1" } }), 4)).rejects.toMatchObject({ code: "upstream_too_large" });
    expect(cancelled).toBe(true);
  });
});
