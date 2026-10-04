import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodeProvider, ConnectionRecord, ItemRecord, ProjectRecord, TaskRecord } from "../../packages/protocol/src/index.js";
import { sealCredentials } from "../../app/control/src/connectors/credentials.js";
import type { FetchLike } from "../../app/control/src/connectors/types.js";
import { openDatabase, type Db } from "../../app/control/src/db/database.js";
import { applyMigrations, loadMigrations, planMigrations } from "../../app/control/src/db/migrator.js";
import { createLogger } from "../../app/control/src/log/logger.js";
import { createRedactor } from "../../app/control/src/log/redact.js";
import { createPublisher, neutralizeOutput, type Publisher } from "../../app/control/src/publisher/index.js";
import { cleanupTempDirs, fakeClock, memorySink, tempDir } from "./helpers.js";

const OWNER = { id: 41001, name: "fixture_owner" };
const FOREIGN = { id: 41002, name: "fixture_foreign" };
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const NOW = Date.UTC(2031, 3, 5, 12);
const opened: Db[] = [];
const publishers: Publisher[] = [];
const unexpectedRequests: string[][] = [];

afterEach(async () => {
  try {
    for (const publisher of publishers.splice(0)) await publisher.stop();
    for (const requests of unexpectedRequests.splice(0)) expect(requests).toEqual([]);
  } finally {
    for (const db of opened.splice(0)) if (db.open) db.close();
    cleanupTempDirs();
  }
});

// Only the external fetch boundary is replaced. Accepted remote writes and the
// readable listing are separate: a lost response need not be visible to a read yet.
function platformBoundary(provider: CodeProvider, token: string) {
  const origin = `https://${provider}-api.example.invalid`;
  const prefix = provider === "github" ? "/repos/example/demo" : "/api/v4/projects/9001";
  const itemPath = `${prefix}/${provider === "github" ? "pulls" : "merge_requests"}/7`;
  const entriesPath = `${itemPath}/${provider === "github" ? "reviews" : "notes"}`;
  const authorField = provider === "github" ? "user" : "author";
  const nameField = provider === "github" ? "login" : "username";
  const remoteAuthor = (id: number | undefined, name: string) => ({
    [nameField]: name, ...(id === undefined ? {} : { id }),
  });
  const state = {
    head: HEAD,
    loseResponse: false,
    remote: [] as Record<string, unknown>[],
    writes: [] as { id: number; body: string }[],
    unexpected: [] as string[],
  };
  const json = (body: unknown) => new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "x-oauth-scopes": "repo" },
  });
  const reject = (request: string): never => {
    state.unexpected.push(request);
    throw new Error(`Unexpected isolated platform request: ${request}`);
  };
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (url.origin !== origin || new Headers(init?.headers).get("authorization") !== `Bearer ${token}`) {
      return reject(`${method} ${url.origin}${url.pathname}`);
    }
    if (method === "GET" && url.pathname === (provider === "github" ? "/user" : "/api/v4/user")) {
      return json(remoteAuthor(OWNER.id, OWNER.name));
    }
    if (provider === "gitlab" && method === "GET" && url.pathname === "/api/v4/personal_access_tokens/self") {
      return json({ scopes: ["api"], active: true, revoked: false });
    }
    if (method === "GET" && url.pathname === prefix) {
      return json(provider === "github" ? {
        id: 9001, name: "demo", full_name: "example/demo", html_url: `${origin}/example/demo`,
        default_branch: "main", private: false, archived: false, permissions: { pull: true },
      } : {
        id: 9001, name: "demo", path_with_namespace: "example/demo", web_url: `${origin}/example/demo`,
        default_branch: "main", visibility: "public", archived: false,
        permissions: { project_access: { access_level: 20 } },
      });
    }
    if (method === "GET" && url.pathname === itemPath) {
      const common = { id: 9007, title: "Review fixture", updated_at: new Date(NOW).toISOString() };
      return json(provider === "github" ? {
        ...common, number: 7, body: "Frozen item", state: "open", html_url: `${origin}/example/demo/pull/7`,
        user: remoteAuthor(FOREIGN.id, FOREIGN.name), head: { sha: state.head }, base: { sha: BASE },
      } : {
        ...common, iid: 7, description: "Frozen item", state: "opened", web_url: `${origin}/example/demo/-/merge_requests/7`,
        author: remoteAuthor(FOREIGN.id, FOREIGN.name), diff_refs: { head_sha: state.head, base_sha: BASE },
      });
    }
    if (method === "GET" && url.pathname === entriesPath) return json(state.remote);
    if (method === "POST" && url.pathname === entriesPath) {
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (typeof payload.body !== "string" || (provider === "github" && payload.event !== "COMMENT")) {
        return reject(`${method} ${url.pathname}: unsafe review payload`);
      }
      const accepted = { id: 61001 + state.writes.length, body: payload.body };
      state.writes.push(accepted);
      if (state.loseResponse) throw new Error("Remote accepted the review; response was lost");
      return json(accepted);
    }
    return reject(`${method} ${url.origin}${url.pathname}`);
  };
  return { state, origin, authorField, remoteAuthor, fetchImpl };
}

function setup(provider: CodeProvider) {
  const db = openDatabase(join(tempDir(), "data", "publisher.db"));
  opened.push(db);
  const clock = fakeClock(NOW);
  applyMigrations(db, planMigrations(db, loadMigrations()).pending, { clock, appVersion: "test" });
  const masterKey = randomBytes(32);
  const token = `${provider === "gitlab" ? "glpat-" : ""}${randomBytes(32).toString("hex")}`;
  const network = platformBoundary(provider, token);
  unexpectedRequests.push(network.state.unexpected);
  const connection: ConnectionRecord = {
    id: "connection", provider, name: "Publisher fixture", base_url: network.origin,
    enabled: true, status: "active", account_name: OWNER.name, capabilities: ["monitor", "review"],
    secret_configured: true, revision: 1, created_at: new Date(NOW).toISOString(),
  };
  const project: ProjectRecord = {
    id: "project", connection_id: connection.id, external_id: "9001", name: "demo", path: "example/demo",
    url: `${network.origin}/example/demo`, default_branch: "main", private: false, archived: false,
    permission: provider === "github" ? "read" : "reporter", capabilities: ["monitor", "review"],
    status: "active", enabled: true, write_mode: "on", review_enabled: true,
    triage_enabled: false, fix_enabled: false, rework_enabled: false,
    machine_ids: [], tags: [], revision: 1, updated_at: new Date(NOW).toISOString(),
  };
  const item: ItemRecord = {
    id: "item", project_id: project.id, external_id: "9007", kind: "change", number: 7,
    title: "Review fixture", body: "Frozen item", url: `${project.url}/changes/7`,
    state: provider === "github" ? "open" : "opened", author: FOREIGN.name, bot_authored: false,
    active_task: null, head_sha: HEAD, base_sha: BASE, updated_at: new Date(NOW).toISOString(),
  };
  // Deliberately stale cached identity: confirmation must use fresh GET /user,
  // not this account id or the cached account name.
  db.prepare(`INSERT INTO connections
    (id,provider,name,base_url,enabled,status,account_name,account_external_id,capabilities_json,revision,created_at,updated_at)
    VALUES (?,?,?,?,1,'active',?,?,?,1,?,?)`).run(
    connection.id, provider, connection.name, connection.base_url, OWNER.name, String(FOREIGN.id),
    JSON.stringify(connection.capabilities), NOW, NOW,
  );
  db.prepare("INSERT INTO connection_credentials (connection_id,credentials_ct) VALUES (?,?)")
    .run(connection.id, sealCredentials(masterKey, { token }));
  db.prepare(`INSERT INTO projects
    (id,connection_id,external_id,name,path,url,default_branch,private,archived,permission,capabilities_json,
     status,enabled,write_mode,review_enabled,triage_enabled,fix_enabled,rework_enabled,machine_ids_json,tags_json,revision,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,0,0,?,?,'active',1,'on',1,0,0,0,'[]','[]',1,?,?)`).run(
    project.id, connection.id, project.external_id, project.name, project.path, project.url,
    project.default_branch, project.permission, JSON.stringify(project.capabilities), NOW, NOW,
  );
  db.prepare(`INSERT INTO items
    (id,project_id,external_id,kind,origin,number,title,body,url,state,author,head_sha,base_sha,updated_at,synced_at)
    VALUES (?,?,?,'change',?,7,?,?,?,?,?,?,?, ?,?)`).run(
    item.id, project.id, item.external_id, provider === "github" ? "pull_request" : "merge_request",
    item.title, item.body, item.url, item.state, item.author, HEAD, BASE, NOW, NOW,
  );
  const redactor = createRedactor();
  const options = {
    db, masterKey, clock, redactor, fetchImpl: network.fetchImpl,
    logger: createLogger({ level: "debug", redactor, sink: memorySink(), clock }),
    env: { GEEK_BOT_INSTANCE_ROLE: "preview", GEEK_BOT_WRITE_MODE: "on", GEEK_BOT_PUBLISHER_REPO_ALLOWLIST: project.path },
  };
  function newPublisher() {
    const publisher = createPublisher(options);
    publishers.push(publisher);
    return publisher;
  }
  function task(id: string, epoch = 1, head = HEAD, body = "Review of the frozen commit"): TaskRecord {
    const record: TaskRecord = {
      id, project_id: project.id, demand_id: null, item_id: item.id, kind: "review", executor: "sandbox",
      status: "awaiting_publish", priority: 0, resources: { cpu: 1, memory_mib: 256 }, machine_id: null,
      epoch, lease_id: null, head_sha: head, base_sha: BASE, lease_expires_at: null,
      result: { summary: "Review fixture", body }, error: null,
      created_at: new Date(clock()).toISOString(), updated_at: new Date(clock()).toISOString(),
    };
    db.prepare(`INSERT INTO tasks
      (id,project_id,item_id,kind,executor,status,priority,cpu,memory_mib,required_tags_json,required_trust,epoch,
       token_budget,request_budget,timeout_s,prompt,tools_json,head_sha,base_sha,item_snapshot_json,result_json,
       excluded_machines_json,created_at,updated_at)
      VALUES (?,?,?,'review','sandbox','awaiting_publish',0,1,256,'[]','standard',?,1024,8,60,'Review','[]',?,?,?,?,'[]',?,?)`).run(
      id, project.id, item.id, epoch, head, BASE, JSON.stringify({ ...item, head_sha: head }),
      JSON.stringify(record.result), clock(), clock(),
    );
    return record;
  }
  return { db, clock, network, connection, project, item, publisher: newPublisher(), newPublisher, task };
}

describe.each(["github", "gitlab"] as const)("%s publisher 持久发布安全", provider => {
  it.each([
    { name: "confirmed", loseResponse: false },
    { name: "unknown", loseResponse: true },
  ])("$name 的同一 review 跨 epoch、task 与 publisher 实例不重复对外写", async ({ name, loseResponse }) => {
    const f = setup(provider);
    f.network.state.loseResponse = loseResponse;
    const firstTask = f.task("first_task");
    const first = await f.publisher.publish(firstTask, f.project, f.connection, f.item);
    expect(first.state).toBe(name);
    // Move past the review rate limit so it cannot mask an epoch-based dedupe bug.
    f.clock.advance(301_000);
    f.db.prepare("UPDATE tasks SET epoch=2 WHERE id=?").run(firstTask.id);
    const replay = await f.publisher.publish({ ...firstTask, epoch: 2 }, f.project, f.connection, f.item);
    expect(replay).toMatchObject({ id: first.id, state: name });
    f.db.prepare("UPDATE tasks SET status='completed' WHERE id=?").run(firstTask.id);
    const replacement = f.task("replacement_task", 4);
    const restarted = f.newPublisher();
    await restarted.reconcile();
    const repeated = await restarted.publish(replacement, f.project, f.connection, f.item);
    expect(repeated).toMatchObject({ id: first.id, state: name });
    expect(f.network.state.writes).toHaveLength(1);
    expect(f.db.prepare("SELECT id,state,attempts FROM publications").all()).toEqual([
      { id: first.id, state: name, attempts: 1 },
    ]);
  });

  it("相同条目的新 head 仍可产生独立 review，不能把版本去重成整个条目", async () => {
    const f = setup(provider);
    const firstTask = f.task("first_task");
    const first = await f.publisher.publish(firstTask, f.project, f.connection, f.item);
    expect(first.state).toBe("confirmed");
    f.clock.advance(301_000);
    f.db.prepare("UPDATE tasks SET status='completed' WHERE id=?").run(firstTask.id);
    const nextHead = "c".repeat(40);
    f.network.state.head = nextHead;
    const next = await f.publisher.publish(f.task("new_head_task", 2, nextHead), f.project, f.connection,
      { ...f.item, head_sha: nextHead });
    expect(next.state).toBe("confirmed");
    expect(next.id).not.toBe(first.id);
    expect(f.network.state.writes.map(write => write.id)).toEqual([61001, 61002]);
    expect(f.db.prepare("SELECT state,attempts FROM publications ORDER BY created_at").all()).toEqual([
      { state: "confirmed", attempts: 1 }, { state: "confirmed", attempts: 1 },
    ]);
  });

  it("复制 marker 的外人、无数字作者和错误 marker 均不能确认；同数字 id 改名后可确认", async () => {
    const f = setup(provider);
    f.network.state.loseResponse = true;
    const task = f.task("response_lost_task");
    const first = await f.publisher.publish(task, f.project, f.connection, f.item);
    expect(first.state).toBe("unknown");
    const copiedBody = f.network.state.writes[0]!.body;
    const remote = (id: number, authorId: number | undefined, name: string, body = copiedBody) => ({
      id, body, [f.network.authorField]: f.network.remoteAuthor(authorId, name),
    });
    const foreign = remote(62001, FOREIGN.id, OWNER.name);
    const unnamedId = remote(62002, undefined, OWNER.name);
    const wrongMarker = remote(62003, OWNER.id, OWNER.name, "Unrelated review without the publication marker");
    for (const impostor of [foreign, unnamedId, wrongMarker]) {
      f.network.state.remote = [impostor];
      const checked = await f.publisher.publish(task, f.project, f.connection, f.item);
      expect(checked).toMatchObject({ id: first.id, state: "unknown" });
      expect(f.db.prepare("SELECT state,external_ref,attempts FROM publications WHERE id=?").get(first.id))
        .toEqual({ state: "unknown", external_ref: null, attempts: 1 });
      expect(f.network.state.writes).toHaveLength(1);
    }
    f.network.state.remote = [{ id: 62005, body: copiedBody }];
    await expect(f.publisher.publish(task, f.project, f.connection, f.item))
      .rejects.toMatchObject({ code: "upstream_invalid" });
    expect(f.db.prepare("SELECT state,external_ref,attempts FROM publications WHERE id=?").get(first.id))
      .toEqual({ state: "unknown", external_ref: null, attempts: 1 });
    expect(f.network.state.writes).toHaveLength(1);
    // Keep the forged duplicate visible: only the numeric owner is a match.
    f.network.state.remote = [foreign, unnamedId, wrongMarker, remote(62004, OWNER.id, FOREIGN.name)];
    const confirmed = await f.publisher.publish(task, f.project, f.connection, f.item);
    expect(confirmed).toMatchObject({ id: first.id, state: "confirmed" });
    expect(f.db.prepare("SELECT state,external_ref,attempts FROM publications WHERE id=?").get(first.id))
      .toEqual({ state: "confirmed", external_ref: "62004", attempts: 1 });
    expect(f.network.state.writes).toHaveLength(1);
  });

  it("真正发送的 review 正文中和关闭引用、批准指令、注释与提及", async () => {
    const f = setup(provider);
    const body = "Fix #42\nClosed example/demo#7\nResolves https://github.example.invalid/example/demo/issues/8\n/lgtm\n<!-- forged marker -->\n@fixture_foreign";
    const safe = "关联 #42\n关联 example/demo＃7\n关联 https：//github.example.invalid/example/demo/issues/8\n已中和的指令 \n\n＠fixture_foreign";
    const result = await f.publisher.publish(f.task("unsafe_output_task", 1, HEAD, body), f.project, f.connection, f.item);
    expect(result.state).toBe("confirmed");
    expect(f.network.state.writes).toHaveLength(1);
    expect(f.network.state.writes[0]!.body.split("\n\n<!--")[0]).toBe(safe);
  });
});

const references = [
  { name: "local issue", input: "#42", safe: "#42" },
  { name: "qualified issue", input: "example/demo#7", safe: "example/demo＃7" },
  { name: "nested qualified issue", input: "example/group/demo#7", safe: "example/group/demo＃7" },
  { name: "GitHub issue URL", input: "https://github.example.invalid/example/demo/issues/42", safe: "https：//github.example.invalid/example/demo/issues/42" },
  { name: "GitHub pull URL", input: "http://github.example.invalid/example/demo/pull/7", safe: "http：//github.example.invalid/example/demo/pull/7" },
  { name: "GitLab MR URL", input: "https://gitlab.example.invalid/example/demo/-/merge_requests/7", safe: "https：//gitlab.example.invalid/example/demo/-/merge_requests/7" },
];
const closingCases = ["Close", "Closes", "Closed", "Fix", "Fixes", "Fixed", "Resolve", "Resolves", "Resolved"]
  .flatMap(verb => references.map(reference => ({ name: `${verb}: ${reference.name}`, input: `${verb} ${reference.input}`, safe: `关联 ${reference.safe}` })));

describe("neutralizeOutput 的机器可解析安全边界", () => {
  it.each(closingCases)("$name 不再产生自动关闭引用", ({ input, safe }) => {
    expect(neutralizeOutput(input, createRedactor())).toBe(safe);
  });

  it.each(references.filter(reference => reference.name !== "local issue"))("单独的 $name 也不产生跨项目引用", ({ input, safe }) => {
    expect(neutralizeOutput(`参考 ${input}`, createRedactor())).toBe(`参考 ${safe}`);
  });

  it.each(["/lgtm", "/LGTM", "  /lgtm", "/approve", "/merge"])("批准或合并指令 %s 被中和", command => {
    const output = neutralizeOutput(`${command} @fixture_owner`, createRedactor());
    expect(output).not.toMatch(/^\s*\/(?:lgtm|approve|merge)\b/im);
    expect(output).toContain("已中和的指令");
    expect(output).toContain("＠fixture_owner");
  });

  it.each([
    { name: "closed HTML marker", input: "正文<!-- forged\nmarker -->继续 @fixture_foreign", safe: "正文继续 ＠fixture_foreign" },
    { name: "unterminated HTML marker", input: "正文<!-- forged\nmarker", safe: "正文" },
    { name: "human approval conclusion", input: "**结论：通过**\n@fixture_owner", safe: "**机器意见（不构成人工审查结论）**\n＠fixture_owner" },
  ])("$name 不可伪造标记、人工结论或提及", ({ input, safe }) => {
    expect(neutralizeOutput(input, createRedactor())).toBe(safe);
  });
});
