import { randomBytes, createHash } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NODE_PROTOCOL_VERSION } from "../../packages/protocol/src/index.js";
import { startControl, type ControlHandle } from "../../app/control/src/services.js";
import type { FetchImpl } from "../../app/control/src/platform/context.js";
import { cleanupTempDirs, fixture, fakeClock, memorySink, writeKey } from "./helpers.js";

const ORIGIN = "https://control.example.invalid";
const WEB = "https://github.example.invalid";
const API = "https://github-api.example.invalid";
const CLIENT = "integration-client";
const OWNER = { id: 41001, login: "fixture-owner" };
const VIEWER = { id: 41002, login: "fixture-viewer" };
const synthetic = () => randomBytes(32).toString("base64url");
type Identity = { id: number; login: string };
type Method = "GET" | "POST" | "PATCH" | "DELETE";
type Reply = {
  statusCode: number;
  headers: { [key: string]: string | string[] | number | undefined };
  json(): any;
};

// A browser jar, populated only by actual HTTP Set-Cookie responses.
class Browser {
  readonly cookies = new Map<string, string>();
  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }
  absorb(response: Reply): void {
    const raw = response.headers["set-cookie"];
    const lines = raw === undefined ? [] : Array.isArray(raw) ? raw : [String(raw)];
    for (const line of lines) {
      const pair = line.split(";", 1)[0]!;
      const equal = pair.indexOf("=");
      const name = pair.slice(0, equal);
      const value = pair.slice(equal + 1);
      if (value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  copy(): Browser {
    const result = new Browser();
    for (const [name, value] of this.cookies) result.cookies.set(name, value);
    return result;
  }
}

function githubBoundary() {
  const identities: Identity[] = [];
  const devices = new Map<string, Identity>();
  const tokens = new Map<string, Identity>();
  const json = (body: unknown) => new Response(JSON.stringify(body), {
    status: 200, headers: { "content-type": "application/json", "x-oauth-scopes": "" },
  });
  const fetchImpl: FetchImpl = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = new Headers(init?.headers);
    if (method === "POST" && url.href === `${WEB}/login/device/code`) {
      const body = JSON.parse(String(init?.body));
      if (body.client_id !== CLIENT || body.scope !== "") throw new Error("Unexpected OAuth device request");
      const identity = identities.shift();
      if (!identity) throw new Error("No identity queued for this device flow");
      const device = synthetic();
      devices.set(device, identity);
      return json({ device_code: device, user_code: randomBytes(4).toString("hex"),
        verification_uri: `${WEB}/login/device`, interval: 1, expires_in: 600 });
    }
    if (method === "POST" && url.href === `${WEB}/login/oauth/access_token`) {
      const body = JSON.parse(String(init?.body));
      const identity = devices.get(body.device_code);
      if (!identity || body.client_id !== CLIENT || body.grant_type !== "urn:ietf:params:oauth:grant-type:device_code") {
        throw new Error("Unexpected OAuth exchange request");
      }
      devices.delete(body.device_code);
      const token = synthetic();
      tokens.set(token, identity);
      return json({ access_token: token, token_type: "bearer", scope: "" });
    }
    if (method === "GET" && url.href === `${API}/user`) {
      const identity = tokens.get((headers.get("authorization") ?? "").replace(/^Bearer /, ""));
      if (!identity) throw new Error("Unexpected GitHub identity request");
      return json(identity);
    }
    if (method === "DELETE" && url.href === `${API}/applications/${CLIENT}/token`) {
      const body = JSON.parse(String(init?.body));
      if (!tokens.delete(body.access_token)) throw new Error("Unexpected OAuth revocation token");
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected external request: ${method} ${url.origin}${url.pathname}`);
  };
  return { fetchImpl, as: (identity: Identity) => identities.push(identity) };
}

// No listen(): inject exercises the real registered Fastify routes and SQLite,
// without starting periodic polling, publisher reconciliation, or lease timers.
describe("shared platform HTTP security and mutation contracts", () => {
  let handle: ControlHandle;
  let clock: ReturnType<typeof fakeClock>;
  let network: ReturnType<typeof githubBoundary>;

  beforeEach(async () => {
    const f = fixture();
    const oauth = writeKey(f.dir, "oauth-client");
    clock = fakeClock(Date.UTC(2031, 3, 5, 12));
    network = githubBoundary();
    handle = await startControl({
      env: { ...f.env, GEEK_BOT_PUBLIC_ORIGIN: ORIGIN,
        GEEK_BOT_GITHUB_WEB_URL: WEB, GEEK_BOT_GITHUB_API_URL: API,
        GEEK_BOT_GITHUB_CLIENT_ID: CLIENT, GEEK_BOT_OAUTH_CLIENT_SECRET_FILE: oauth.path },
      clock, sink: memorySink(), dailyJobs: false, opsChannel: false,
      fetchImpl: network.fetchImpl,
    });
  });

  afterEach(async () => {
    try { if (handle) await handle.shutdown("HTTP integration test cleanup"); }
    finally { cleanupTempDirs(); }
  });

  async function request(browser: Browser, method: Method, url: string, body?: unknown,
    overrides: Record<string, string | undefined> = {}): Promise<Reply> {
    const headers: Record<string, string> = {
      host: new URL(ORIGIN).host, cookie: browser.header(),
      ...(method === "GET" ? {} : { origin: ORIGIN, "content-type": "application/json", "sec-fetch-site": "same-origin" }),
    };
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete headers[key];
      else headers[key] = value;
    }
    const response = await handle.app.inject({ method, url, headers,
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
    browser.absorb(response);
    return response;
  }
  function error(response: Reply, status: number, code: string): void {
    expect(response.statusCode).toBe(status);
    // Only the documented business code is pinned, not localized error prose.
    expect(response.json()).toMatchObject({ error: { code } });
  }
  async function flow(browser: Browser, purpose: "claim" | "login" | "reauth", identity: Identity) {
    network.as(identity);
    const started = await request(browser, "POST", "/api/v1/auth/device", { purpose });
    expect(started.statusCode).toBe(200);
    return started.json().flow_id as string;
  }
  async function finish(browser: Browser, id: string): Promise<Reply> {
    return request(browser, "POST", `/api/v1/auth/device/${id}/poll`, {});
  }
  async function authorize(browser: Browser, purpose: "claim" | "login" | "reauth", identity = OWNER) {
    const id = await flow(browser, purpose, identity);
    const done = await finish(browser, id);
    expect(done.statusCode).toBe(200);
    expect(done.json()).toEqual({ status: "done" });
  }
  async function owner(): Promise<Browser> {
    const browser = new Browser();
    const code = handle.platform!.bootstrapCode().code;
    expect((await request(browser, "POST", "/api/v1/auth/claim", { code })).statusCode).toBe(204);
    await authorize(browser, "claim");
    await authorize(browser, "reauth");
    return browser;
  }
  const machineBody = (name: string) => ({ name, trust: "standard", tags: ["integration"],
    slots: { sandbox: 1, vm: 1 }, capacity: { cpu: 4, memory_mib: 8192 } });
  async function createMachine(browser: Browser, name: string, key?: string) {
    const response = await request(browser, "POST", "/api/v1/machines", machineBody(name),
      key ? { "idempotency-key": key } : {});
    expect(response.statusCode).toBe(201);
    return response.json();
  }
  async function node(machine: { name: string }, token: string, url: string, body: unknown) {
    return handle.app.inject({ method: "POST", url, headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json",
      "x-geek-bot-node": machine.name, "x-geek-bot-protocol": String(NODE_PROTOCOL_VERSION),
    }, payload: JSON.stringify(body) });
  }

  it("rejects cross-origin and rebound-host writes before they create a machine", async () => {
    const browser = await owner();
    const before = (await request(browser, "GET", "/api/v1/machines")).json();
    const privateHost = [10, ...randomBytes(3)].join(".");
    const cases = [
      { name: "missing Origin", headers: { origin: undefined }, status: 403, code: "csrf_rejected" },
      { name: "wrong Origin", headers: { origin: "https://attacker.example.invalid" }, status: 403, code: "csrf_rejected" },
      { name: "wrong Host", headers: { host: privateHost }, status: 421, code: "bad_host" },
      { name: "cross-site fetch", headers: { "sec-fetch-site": "cross-site" }, status: 403, code: "csrf_rejected" },
    ];
    for (const row of cases) {
      const denied = await request(browser, "POST", "/api/v1/machines", machineBody("blocked-node"), row.headers);
      error(denied, row.status, row.code);
      expect((await request(browser, "GET", "/api/v1/machines")).json(), row.name).toEqual(before);
    }
    // Positive control: this same valid mutation must work through the guard.
    const created = await createMachine(browser, "blocked-node");
    expect((await request(browser, "GET", `/api/v1/machines/${created.machine.id}`)).json())
      .toMatchObject({ name: "blocked-node", status: "pending" });
  });

  it("requires a browser claim grant, consumes bootstrap code once, and binds the flow to its browser", async () => {
    const browser = new Browser();
    error(await request(browser, "POST", "/api/v1/auth/device", { purpose: "claim" }), 403, "claim_required");
    error(await request(browser, "GET", "/api/v1/machines"), 409, "not_claimed");
    const code = handle.platform!.bootstrapCode().code;
    expect((await request(browser, "POST", "/api/v1/auth/claim", { code })).statusCode).toBe(204);
    error(await request(new Browser(), "POST", "/api/v1/auth/claim", { code }), 403, "claim_code_invalid");
    const id = await flow(browser, "claim", OWNER);
    error(await finish(new Browser(), id), 404, "not_found");
    const done = await finish(browser, id);
    expect(done.statusCode).toBe(200);
    expect(done.json()).toEqual({ status: "done" });
    expect((await request(browser, "GET", "/api/v1/me")).json())
      .toMatchObject({ github_id: OWNER.id, login: OWNER.login, role: "owner" });
    error(await request(browser, "POST", "/api/v1/auth/claim", { code }), 409, "already_claimed");
    expect((await request(browser, "GET", "/api/v1/admins")).json().items.map((a: Identity) => a.id ?? (a as any).github_id))
      .toEqual([OWNER.id]);
  });

  it("uses numeric GitHub identity, rejects a recycled login, and isolates signed sessions on logout", async () => {
    const first = await owner();
    const intruder = new Browser();
    const bad = await flow(intruder, "login", { id: OWNER.id + 100, login: OWNER.login });
    error(await finish(intruder, bad), 403, "not_an_admin");
    error(await request(intruder, "GET", "/api/v1/me"), 401, "unauthenticated");
    const second = new Browser();
    await authorize(second, "login", { id: OWNER.id, login: "renamed-owner" });
    expect((await request(second, "GET", "/api/v1/me")).json())
      .toMatchObject({ github_id: OWNER.id, login: "renamed-owner", role: "owner" });
    const cookie = second.cookies.get("gb_session")!;
    const hashOnly = second.copy();
    hashOnly.cookies.set("gb_session", createHash("sha256").update(cookie.split(".")[0]!).digest("hex"));
    error(await request(hashOnly, "GET", "/api/v1/me"), 401, "unauthenticated");
    const tampered = second.copy();
    tampered.cookies.set("gb_session", `${cookie.slice(0, -1)}${cookie.endsWith("A") ? "B" : "A"}`);
    error(await request(tampered, "GET", "/api/v1/me"), 401, "unauthenticated");
    const replay = first.copy();
    expect((await request(first, "POST", "/api/v1/auth/logout", {})).statusCode).toBe(204);
    error(await request(replay, "GET", "/api/v1/me"), 401, "unauthenticated");
    expect((await request(second, "GET", "/api/v1/me")).json())
      .toMatchObject({ github_id: OWNER.id, role: "owner" });
  });

  it("allows viewer reads but refuses resource configuration without changing the resource", async () => {
    const admin = await owner();
    expect((await request(admin, "POST", "/api/v1/admins", { github_id: VIEWER.id, role: "viewer" })).statusCode).toBe(201);
    const created = await createMachine(admin, "viewer-protected");
    const viewer = new Browser();
    await authorize(viewer, "login", VIEWER);
    const url = `/api/v1/machines/${created.machine.id}`;
    const read = await request(viewer, "GET", url);
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual(created.machine);
    error(await request(viewer, "PATCH", url, { capacity: { cpu: 8, memory_mib: 16384 } },
      { "if-match": String(read.headers.etag) }), 403, "forbidden");
    error(await request(viewer, "POST", "/api/v1/machines", machineBody("viewer-created")), 403, "forbidden");
    expect((await request(admin, "GET", url)).json()).toEqual(read.json());
    expect((await request(admin, "GET", "/api/v1/machines")).json().items).toEqual([read.json()]);
  });

  it("refuses missing and stale If-Match rather than overwriting a committed resource change", async () => {
    const browser = await owner();
    const created = await createMachine(browser, "revision-node");
    const url = `/api/v1/machines/${created.machine.id}`;
    const initial = await request(browser, "GET", url);
    error(await request(browser, "PATCH", url, { name: "missing-revision" }), 428, "revision_required");
    expect((await request(browser, "GET", url)).json()).toEqual(initial.json());
    const changed = await request(browser, "PATCH", url, { name: "committed-name" }, { "if-match": String(initial.headers.etag) });
    expect(changed.statusCode).toBe(200);
    error(await request(browser, "PATCH", url, { name: "stale-overwrite" }, { "if-match": String(initial.headers.etag) }), 412, "revision_mismatch");
    expect((await request(browser, "GET", url)).json()).toEqual(changed.json());
    // A rename has a downstream authentication effect, not just a setter echo.
    const heartbeat = { ...machineBody("committed-name"), protocol_version: NODE_PROTOCOL_VERSION, health: {} };
    delete (heartbeat as Partial<typeof heartbeat>).trust;
    error(await node({ name: "revision-node" }, created.node_token, "/api/node/v1/heartbeat", heartbeat), 401, "unauthenticated");
  });

  it("never reissues a one-time node token or creates an extra machine on idempotency replay", async () => {
    const browser = await owner();
    const key = synthetic();
    const created = await createMachine(browser, "once-node", key);
    const before = (await request(browser, "GET", "/api/v1/machines")).json();
    const replay = await request(browser, "POST", "/api/v1/machines", machineBody("once-node"), { "idempotency-key": key });
    error(replay, 409, "secret_already_issued");
    expect(replay.json()).not.toHaveProperty("node_token");
    expect(JSON.stringify(replay.json())).not.toContain(created.node_token);
    expect((await request(browser, "GET", "/api/v1/machines")).json()).toEqual(before);
    const heartbeat = { name: created.machine.name, protocol_version: NODE_PROTOCOL_VERSION,
      capacity: machineBody("once-node").capacity, slots: machineBody("once-node").slots, tags: ["integration"],
      health: { boot_id: synthetic(), seq: 1 } };
    const registered = await node(created.machine, created.node_token, "/api/node/v1/heartbeat", heartbeat);
    expect(registered.statusCode).toBe(200);
    expect(registered.json()).toMatchObject({ machine_id: created.machine.id, status: "cordoned" });
  });

  it("fails closed on missing self-check and refuses configured capacity beyond the node's declaration", async () => {
    const browser = await owner();
    const created = await createMachine(browser, "declared-node");
    const url = `/api/v1/machines/${created.machine.id}`;
    const boot = synthetic();
    const heartbeat = { name: created.machine.name, protocol_version: NODE_PROTOCOL_VERSION,
      capacity: { cpu: 4, memory_mib: 8192 }, slots: { sandbox: 1, vm: 1 }, tags: ["integration"],
      health: { boot_id: boot, seq: 1, disk_free_percent: 50, disk_free_mib: 32768, mem_available_mib: 8192 } };
    expect((await node(created.machine, created.node_token, "/api/node/v1/heartbeat", heartbeat)).statusCode).toBe(200);
    error(await request(browser, "POST", `${url}/uncordon`, {}), 409, "self_check_failed");
    expect((await request(browser, "GET", url)).json().status).toBe("cordoned");
    const healthy = { ...heartbeat, health: { ...heartbeat.health, seq: 2,
      self_check: { passed: true, omp_version: "integration", sandbox_ready: true, vm_ready: true, model_ready: true } } };
    expect((await node(created.machine, created.node_token, "/api/node/v1/heartbeat", healthy)).statusCode).toBe(200);
    const ready = await request(browser, "POST", `${url}/uncordon`, {});
    expect(ready.statusCode).toBe(200);
    expect(ready.json().status).toBe("ready");
    const before = await request(browser, "GET", url);
    for (const patch of [ { slots: { sandbox: 2, vm: 1 } }, { capacity: { cpu: 5, memory_mib: 8192 } },
      { capacity: { cpu: 4, memory_mib: 8193 } } ]) {
      error(await request(browser, "PATCH", url, patch, { "if-match": String(before.headers.etag) }), 422, "slots_exceed_declared");
      expect((await request(browser, "GET", url)).json()).toEqual(before.json());
    }
  });

  it("refuses dispatch of an unassociated demand without advancing its state", async () => {
    const browser = await owner();
    const made = await request(browser, "POST", "/api/v1/demands", { title: "Needs association", body: "Read this request before dispatch." });
    expect(made.statusCode).toBe(201);
    const demand = made.json();
    error(await request(browser, "POST", `/api/v1/demands/${demand.id}/dispatch`, {
      kind: "triage", executor: "sandbox", resources: { cpu: 1, memory_mib: 1024 },
    }), 409, "project_required");
    expect((await request(browser, "GET", `/api/v1/demands/${demand.id}`)).json()).toEqual(demand);
  });
});
