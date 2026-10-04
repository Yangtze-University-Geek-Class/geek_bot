/**
 * 平台连接、项目发现与条目同步（#34）。
 *
 * - 凭据只写不读：Core 只把 connectors 的 sealCredentials / mergeSealedCredentials 生成的密文写进 connection_credentials，
 *   从不解密；解密只在 connectors（只读适配器）与 publisher 里（S-01）。
 * - 发现：项目 id 由连接 id 与平台项目 id 稳定派生；这次没发现的记为 lost；新项目默认不启用、写入模式 off、四个任务开关全关。
 * - 外部请求不放进数据库事务：先取数据，再在一个事务里落库。
 * - 同步落库之后交给条目策略（intake.ts）自动入队：定时同步等它跑完再同步下一个项目，管理员触发的同步不等。
 */
import type {
  Capability,
  ConnectionCredentials,
  ConnectionProvider,
  ConnectionRecord,
  DiscoverResponse,
  ItemRecord,
  ProjectRecord,
  ProjectSyncResponse,
  SyncResponse,
  WriteMode,
} from "@geek-bot/protocol";
import { ConnectorError, connectorForConnection, mergeSealedCredentials, requiredCredentialsMissing, sealCredentials } from "../connectors/index.js";
import type { PlatformContext } from "./context.js";
import { CONNECTION_SCOPE_ALLOWLIST } from "./auth.js";
import { decodeCursor, newId, notFound, PlatformError, pageOf, parseJsonColumn, sha256Hex } from "./http.js";
import { ACTIVE_TASK_SQL, CONNECTION_SELECT, connectionRecord, itemRecord, projectRecord, type ActiveTaskView, type ConnectionRow, type ItemRow, type ProjectRow } from "./records.js";
import { SWITCH_FIELDS, WRITE_RANK, type SwitchField } from "./intake.js";
import { roleAtLeast } from "./security.js";
import type { SessionInfo } from "./auth.js";

export const CODE_PROVIDERS: readonly ConnectionProvider[] = ["github", "gitlab"];
/** 每个平台允许写入的凭据字段；GitHub 只经 OAuth device flow 绑定，不接受手填令牌。 */
export const CREDENTIAL_KEYS: Readonly<Record<ConnectionProvider, readonly (keyof ConnectionCredentials)[]>> = {
  github: [],
  gitlab: ["token"],
  feishu: ["app_id", "app_secret", "verification_token", "encrypt_key"],
  webhook: ["signing_secret", "webhook_url"],
};

export function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${sha256Hex(parts.join("\0")).slice(0, 32)}`;
}

function validateBaseUrl(provider: ConnectionProvider, raw: string): string {
  if (provider === "webhook" && raw === "") return "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PlatformError(400, "validation_failed", "base_url 不是合法地址");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new PlatformError(400, "validation_failed", "base_url 必须是 https 地址，不带用户信息、查询串和片段");
  }
  return url.href.replace(/\/+$/, "");
}

function validateCredentials(provider: ConnectionProvider, credentials: ConnectionCredentials | undefined): void {
  if (credentials === undefined) return;
  const allowed = new Set<string>(CREDENTIAL_KEYS[provider]);
  const extra = Object.keys(credentials).filter(key => !allowed.has(key));
  if (provider === "github" && Object.keys(credentials).length > 0) throw new PlatformError(400, "validation_failed", "GitHub 连接只能经 OAuth 授权绑定账号，不接受手填凭据");
  if (extra.length > 0) throw new PlatformError(400, "validation_failed", `这个平台不接受这些凭据字段：${extra.join("、")}`);
  if (provider === "webhook" && credentials.webhook_url !== undefined) validateBaseUrl("feishu", credentials.webhook_url);
}

export interface ConnectionsService {
  get(id: string): ConnectionRecord;
  list(query: { limit: number; cursor?: string }): { items: ConnectionRecord[]; next_cursor: string | null };
  create(actor: SessionInfo, input: { provider: ConnectionProvider; name: string; base_url: string; credentials?: ConnectionCredentials }): ConnectionRecord;
  update(actor: SessionInfo, id: string, input: { name?: string; base_url?: string; enabled?: boolean; credentials?: ConnectionCredentials }, ifMatch: (revision: number) => void): ConnectionRecord;
  disable(actor: SessionInfo, id: string): ConnectionRecord;
  discover(actor: { type: "user" | "system"; id: string | null }, id: string): Promise<DiscoverResponse>;
  sync(actor: { type: "user" | "system"; id: string | null }, id: string): Promise<SyncResponse>;
  /** 写操作需要的变更级别：包含凭据、地址或重新启用时要求 owner 重新认证。 */
  updateNeedsReauth(input: { base_url?: string; enabled?: boolean; credentials?: ConnectionCredentials }): boolean;

  getProject(id: string): ProjectRecord;
  listProjects(query: { limit: number; cursor?: string; connection_id?: string; search?: string }): { items: ProjectRecord[]; next_cursor: string | null };
  updateProject(
    actor: SessionInfo,
    id: string,
    patch: { enabled?: boolean; write_mode?: WriteMode; machine_ids?: string[]; tags?: string[] } & { readonly [K in SwitchField]?: boolean },
    ifMatch: (revision: number) => void,
    reauthValid: boolean,
  ): ProjectRecord;
  listItems(projectId: string, query: { limit: number; cursor?: string; kind?: "issue" | "change" }): { items: ItemRecord[]; next_cursor: string | null };
  syncProject(actor: { type: "user" | "system"; id: string | null }, id: string): Promise<ProjectSyncResponse>;
  /** 定时同步：已启用、凭据齐全的代码平台连接。串行执行，一轮没跑完不开下一轮。 */
  startPolling(): void;
  stopPolling(): Promise<void>;
}

export interface ConnectionsHooks {
  /** 条目出现新 head 时，在同一事务里把旧 head 上的任务标为 superseded（由任务服务实现）。 */
  supersedeStale(itemId: string, headSha: string): void;
  /** 一个项目的条目同步落库之后：按项目开关自动入队（由条目策略实现，见 intake.ts）。 */
  itemsSynced(projectId: string): Promise<unknown>;
}

export function createConnectionsService(ctx: PlatformContext, hooks: ConnectionsHooks): ConnectionsService {
  const { db, clock, auditor, bus, logger } = ctx;

  const rowOf = (id: string) => db.prepare(`${CONNECTION_SELECT} WHERE c.id = ?`).get(id) as ConnectionRow | undefined;
  const projectRowOf = (id: string) => db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
  const credentialsOf = (id: string) => (db.prepare("SELECT credentials_ct FROM connection_credentials WHERE connection_id = ?").get(id) as { credentials_ct: string } | undefined)?.credentials_ct ?? null;

  /** 连接状态：disabled、needs_credentials、needs_binding（GitHub 未授权）、ready；error 由发现与同步失败写入。 */
  function statusOf(provider: ConnectionProvider, enabled: boolean, accountExternalId: string | null, ct: string | null): string {
    if (!enabled) return "disabled";
    if (provider === "github") return ct !== null && accountExternalId !== null ? "ready" : "needs_binding";
    if (ct === null) return "needs_credentials";
    return requiredCredentialsMissing(provider, ctx.masterKey, ct).length > 0 ? "needs_credentials" : "ready";
  }

  function publishConnection(id: string): void {
    const row = rowOf(id);
    if (row) bus.publish("connection.updated", ["connections", "overview"], connectionRecord(row));
  }

  /** 能否读取这个代码平台连接；不满足时 409，不算平台故障。 */
  function assertReadable(record: ConnectionRecord): void {
    if (!CODE_PROVIDERS.includes(record.provider)) throw new PlatformError(409, "invalid_state", "这个连接不是代码平台，没有项目可发现");
    if (!record.enabled) throw new PlatformError(409, "invalid_state", "连接已停用");
    if (record.status === "needs_binding") throw new PlatformError(409, "invalid_state", "GitHub 连接还没有经 OAuth 绑定账号");
    if (record.status === "needs_credentials") throw new PlatformError(409, "invalid_state", "连接的凭据不完整");
  }

  function recordFailure(id: string, error: unknown, actor: { type: "user" | "system"; id: string | null }, action: string): never {
    const message = ctx.redactor.redactText(error instanceof Error ? error.message : String(error)).slice(0, 500);
    db.prepare("UPDATE connections SET status = 'error', last_error = ?, updated_at = ? WHERE id = ?").run(message, clock(), id);
    ctx.alerts.raise({ kind: "connection_error", severity: "warning", subject: `connection/${id}`, message: `${action}失败：${message}` });
    auditor.write({ actorType: actor.type, actorId: actor.id, action: `${action}.failed`, target: `connection/${id}`, detail: { message } });
    publishConnection(id);
    if (error instanceof PlatformError) throw error;
    // 适配器的错误码（例如 token_invalid、scope_rejected）原样交给 console；状态码只取 4xx/5xx 范围内的值。
    if (error instanceof ConnectorError) throw new PlatformError(error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 502, error.code, `访问平台失败：${message}`);
    throw new PlatformError(502, "upstream_error", `访问平台失败：${message}`);
  }

  async function discover(actor: { type: "user" | "system"; id: string | null }, id: string): Promise<DiscoverResponse> {
    const row = rowOf(id);
    if (!row) throw notFound("连接");
    const record = connectionRecord(row);
    assertReadable(record);
    let identity;
    let projects;
    try {
      // 读取适配器只拿到公共记录，凭据由 connectors 在内部解密。
      const connector = connectorForConnection({ db, masterKey: ctx.masterKey, connection: record, fetchImpl: ctx.fetchImpl, redactor: ctx.redactor });
      identity = await connector.identity();
      if (row.provider === "github" && row.account_external_id !== null && identity.account_external_id !== row.account_external_id) {
        throw new PlatformError(409, "bot_account_mismatch", "平台返回的账号与绑定时不一致：重新绑定账号");
      }
      // S-11：每次校验都按允许名单核对 GitHub 令牌的 scope；超出就停掉这个连接下全部项目的写入并拒绝。
      const extra = row.provider === "github" ? identity.scopes.filter(scope => !(CONNECTION_SCOPE_ALLOWLIST as readonly string[]).includes(scope)) : [];
      if (extra.length > 0) {
        db.prepare("UPDATE projects SET write_mode = 'off', revision = revision + 1, updated_at = ? WHERE connection_id = ? AND write_mode <> 'off'").run(clock(), id);
        throw new PlatformError(403, "scope_rejected", `令牌带有允许名单以外的 scope：${extra.join("、")}；全部写入已停止，需要重新绑定`);
      }
      projects = await connector.discoverProjects();
    } catch (error) {
      return recordFailure(id, error, actor, "connection.discover");
    }
    const now = clock();
    const result = db.transaction(() => {
      const seen = new Set<string>();
      const capabilities = new Set<Capability>();
      for (const project of projects) {
        const projectId = stableId("prj", id, project.external_id);
        seen.add(projectId);
        for (const capability of project.capabilities) capabilities.add(capability);
        const existing = projectRowOf(projectId);
        if (!existing) {
          db.prepare(
            `INSERT INTO projects (id, connection_id, external_id, name, path, url, default_branch, private, archived, permission, capabilities_json, status, enabled, write_mode, machine_ids_json, tags_json, revision, last_synced_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, 'off', '[]', '[]', 1, NULL, ?, ?)`,
          ).run(projectId, id, project.external_id, project.name, project.path, project.url, project.default_branch, project.private ? 1 : 0, project.archived ? 1 : 0, project.permission, JSON.stringify(project.capabilities), now, now);
        } else {
          // 归档后不能写：写入模式降为 off（只降不升）。
          const writeMode: WriteMode = project.archived ? "off" : existing.write_mode;
          db.prepare(
            `UPDATE projects SET name = ?, path = ?, url = ?, default_branch = ?, private = ?, archived = ?, permission = ?, capabilities_json = ?, status = 'active', write_mode = ?,
               revision = revision + CASE WHEN status <> 'active' OR archived <> ? OR write_mode <> ? OR permission <> ? OR capabilities_json <> ? OR name <> ? OR path <> ? OR url <> ? OR default_branch <> ? OR private <> ? THEN 1 ELSE 0 END,
               updated_at = ? WHERE id = ?`,
          ).run(
            project.name, project.path, project.url, project.default_branch, project.private ? 1 : 0, project.archived ? 1 : 0, project.permission, JSON.stringify(project.capabilities), writeMode,
            project.archived ? 1 : 0, writeMode, project.permission, JSON.stringify(project.capabilities), project.name, project.path, project.url, project.default_branch, project.private ? 1 : 0,
            now, projectId,
          );
        }
      }
      const active = db.prepare("SELECT id FROM projects WHERE connection_id = ? AND status = 'active'").all(id) as { id: string }[];
      let lost = 0;
      for (const project of active) {
        if (seen.has(project.id)) continue;
        db.prepare("UPDATE projects SET status = 'lost', write_mode = 'off', revision = revision + 1, updated_at = ? WHERE id = ?").run(now, project.id);
        lost += 1;
      }
      db.prepare(
        "UPDATE connections SET account_name = ?, account_external_id = COALESCE(account_external_id, ?), capabilities_json = ?, status = 'ready', last_error = NULL, last_synced_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
      ).run(identity.account_name, identity.account_external_id, JSON.stringify([...capabilities].sort()), now, now, id);
      auditor.write({ actorType: actor.type, actorId: actor.id, action: "connection.discover", target: `connection/${id}`, detail: { discovered: projects.length, lost } });
      return { discovered: projects.length, lost };
    })();
    ctx.alerts.resolve("connection_error", `connection/${id}`);
    publishConnection(id);
    bus.publish("projects.changed", ["projects", "repos", "overview"], { connection_id: id });
    return result;
  }

  async function syncProject(actor: { type: "user" | "system"; id: string | null }, id: string): Promise<ProjectSyncResponse> {
    const row = projectRowOf(id);
    if (!row) throw notFound("项目");
    if (row.status !== "active") throw new PlatformError(409, "repo_inactive", "项目已在平台上消失（lost），不能同步");
    const connection = rowOf(row.connection_id);
    if (!connection) throw notFound("连接");
    const connectionView = connectionRecord(connection);
    assertReadable(connectionView);
    const project = projectRecord(row);
    let items;
    try {
      const connector = connectorForConnection({ db, masterKey: ctx.masterKey, connection: connectionView, fetchImpl: ctx.fetchImpl, redactor: ctx.redactor });
      items = await connector.listItems(project);
    } catch (error) {
      return recordFailure(connection.id, error, actor, "project.sync");
    }
    const now = clock();
    db.transaction(() => {
      for (const item of items) {
        const itemId = stableId("itm", id, item.kind, item.external_id);
        const updatedAt = Date.parse(item.updated_at);
        db.prepare(
          `INSERT INTO items (id, project_id, external_id, kind, origin, number, title, body, url, state, author, bot_authored, head_sha, base_sha, head_ref, base_ref, labels_json, assignees_json, updated_at, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (project_id, kind, external_id) DO UPDATE SET origin = excluded.origin, number = excluded.number, title = excluded.title, body = excluded.body, url = excluded.url,
             state = excluded.state, author = excluded.author, bot_authored = excluded.bot_authored, head_sha = excluded.head_sha, base_sha = excluded.base_sha, head_ref = excluded.head_ref,
             base_ref = excluded.base_ref, labels_json = excluded.labels_json, assignees_json = excluded.assignees_json, updated_at = excluded.updated_at, synced_at = excluded.synced_at`,
        ).run(
          itemId, id, item.external_id, item.kind, item.origin, item.number, item.title, item.body, item.url, item.state, item.author, item.bot_authored ? 1 : 0, item.head_sha, item.base_sha,
          item.head_ref ?? null, item.base_ref ?? null, JSON.stringify(item.labels ?? []), JSON.stringify(item.assignees ?? []), Number.isFinite(updatedAt) ? updatedAt : now, now,
        );
        // 平台上的变更有了新 head：旧 head 上还没跑完或没发布的任务作废（superseded）。
        if (item.kind === "change" && item.head_sha !== null) hooks.supersedeStale(itemId, item.head_sha);
      }
      db.prepare("UPDATE projects SET last_synced_at = ? WHERE id = ?").run(now, id);
      auditor.write({ actorType: actor.type, actorId: actor.id, action: "project.sync", target: `project/${id}`, detail: { items: items.length } });
    })();
    bus.publish("project.updated", ["projects", "repos"], { id });
    // 自动入队要逐个下载任务包：定时同步（系统身份）等它跑完，管理员触发的同步只排上就返回。
    const intake = hooks.itemsSynced(id);
    if (actor.type === "system") await intake;
    else intake.catch((error: unknown) => logger.warn({ project_id: id, err: error }, "同步后自动入队失败"));
    return { items: items.length };
  }

  let pollTimer: NodeJS.Timeout | null = null;
  let polling: Promise<void> | null = null;
  let stopped = false;

  async function pollOnce(): Promise<void> {
    const connections = db.prepare("SELECT id FROM connections WHERE enabled = 1 AND provider IN ('github', 'gitlab') AND status IN ('ready', 'error') ORDER BY id").all() as { id: string }[];
    for (const connection of connections) {
      if (stopped) return;
      try {
        await service.sync({ type: "system", id: null }, connection.id);
      } catch (error) {
        logger.warn({ connection_id: connection.id, err: error }, "定时同步连接失败");
      }
    }
  }

  const service: ConnectionsService = {
    get(id) {
      const row = rowOf(id);
      if (!row) throw notFound("连接");
      return connectionRecord(row);
    },

    list({ limit, cursor }) {
      const key = decodeCursor("connections", cursor, 2);
      const rows = (key
        ? db.prepare(`${CONNECTION_SELECT} WHERE (c.created_at, c.id) > (?, ?) ORDER BY c.created_at, c.id LIMIT ?`).all(key[0], key[1], limit + 1)
        : db.prepare(`${CONNECTION_SELECT} ORDER BY c.created_at, c.id LIMIT ?`).all(limit + 1)) as ConnectionRow[];
      return pageOf(rows, limit, "connections", row => [row.created_at, row.id], connectionRecord);
    },

    create(actor, input) {
      const baseUrl = validateBaseUrl(input.provider, input.base_url);
      validateCredentials(input.provider, input.credentials);
      const now = clock();
      const id = newId("con");
      db.transaction(() => {
        if (db.prepare("SELECT 1 FROM connections WHERE name = ?").get(input.name)) throw new PlatformError(409, "name_taken", "已有同名连接");
        const ct = input.credentials && Object.keys(input.credentials).length > 0 ? sealCredentials(ctx.masterKey, input.credentials) : null;
        const status = statusOf(input.provider, true, null, ct);
        db.prepare(
          `INSERT INTO connections (id, provider, name, base_url, enabled, status, account_name, account_external_id, scopes, capabilities_json, last_error, last_synced_at, revision, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, NULL, NULL, NULL, '[]', NULL, NULL, 1, ?, ?, ?)`,
        ).run(id, input.provider, input.name, baseUrl, status, actor.githubId, now, now);
        if (ct !== null) db.prepare("INSERT INTO connection_credentials (connection_id, credentials_ct, key_version) VALUES (?, ?, 1)").run(id, ct);
        auditor.write({
          actorType: "user", actorId: String(actor.githubId), action: "connection.create", target: `connection/${id}`,
          detail: { provider: input.provider, name: input.name, credential_fields: Object.keys(input.credentials ?? {}) }, reauth: true,
        });
      })();
      publishConnection(id);
      return service.get(id);
    },

    updateNeedsReauth(input) {
      return input.credentials !== undefined || input.base_url !== undefined || input.enabled === true;
    },

    update(actor, id, input, ifMatch) {
      db.transaction(() => {
        const row = rowOf(id);
        if (!row) throw notFound("连接");
        ifMatch(row.revision);
        validateCredentials(row.provider, input.credentials);
        const baseUrl = input.base_url === undefined ? row.base_url : validateBaseUrl(row.provider, input.base_url);
        if (row.provider === "github" && baseUrl !== row.base_url && row.account_external_id !== null) {
          throw new PlatformError(409, "invalid_state", "已绑定账号的 GitHub 连接不能改地址：新建一个连接");
        }
        const name = input.name ?? row.name;
        if (name !== row.name && db.prepare("SELECT 1 FROM connections WHERE name = ? AND id <> ?").get(name, id)) throw new PlatformError(409, "name_taken", "已有同名连接");
        let ct = credentialsOf(id);
        if (input.credentials !== undefined && Object.keys(input.credentials).length > 0) {
          ct = mergeSealedCredentials(ctx.masterKey, ct, input.credentials);
          db.prepare("INSERT INTO connection_credentials (connection_id, credentials_ct, key_version) VALUES (?, ?, 1) ON CONFLICT (connection_id) DO UPDATE SET credentials_ct = excluded.credentials_ct, key_version = excluded.key_version").run(id, ct);
        }
        const enabled = input.enabled ?? row.enabled === 1;
        const status = statusOf(row.provider, enabled, row.account_external_id, ct);
        db.prepare("UPDATE connections SET name = ?, base_url = ?, enabled = ?, status = ?, last_error = NULL, revision = revision + 1, updated_at = ? WHERE id = ?").run(name, baseUrl, enabled ? 1 : 0, status, clock(), id);
        if (!enabled) db.prepare("UPDATE projects SET write_mode = 'off', revision = revision + 1, updated_at = ? WHERE connection_id = ? AND write_mode <> 'off'").run(clock(), id);
        auditor.write({
          actorType: "user", actorId: String(actor.githubId), action: "connection.update", target: `connection/${id}`,
          detail: { name: input.name !== undefined, base_url: input.base_url !== undefined, enabled: input.enabled ?? null, credential_fields: Object.keys(input.credentials ?? {}) },
          reauth: service.updateNeedsReauth(input),
        });
      })();
      publishConnection(id);
      return service.get(id);
    },

    disable(actor, id) {
      db.transaction(() => {
        const row = rowOf(id);
        if (!row) throw notFound("连接");
        if (row.enabled === 0) return;
        const now = clock();
        db.prepare("UPDATE connections SET enabled = 0, status = 'disabled', revision = revision + 1, updated_at = ? WHERE id = ?").run(now, id);
        // 停用连接即停止它所有项目的写入（只降不升）。
        db.prepare("UPDATE projects SET write_mode = 'off', revision = revision + 1, updated_at = ? WHERE connection_id = ? AND write_mode <> 'off'").run(now, id);
        auditor.write({ actorType: "user", actorId: String(actor.githubId), action: "connection.disable", target: `connection/${id}` });
      })();
      publishConnection(id);
      return service.get(id);
    },

    discover,

    async sync(actor, id) {
      const { discovered } = await discover(actor, id);
      const projects = db.prepare("SELECT id FROM projects WHERE connection_id = ? AND status = 'active' AND enabled = 1 ORDER BY path").all(id) as { id: string }[];
      let items = 0;
      for (const project of projects) items += (await syncProject(actor, project.id)).items;
      return { projects: discovered, items };
    },

    getProject(id) {
      const row = projectRowOf(id);
      if (!row) throw notFound("项目");
      return projectRecord(row);
    },

    listProjects({ limit, cursor, connection_id, search }) {
      const filters = JSON.stringify({ connection_id: connection_id ?? null, search: search ?? null });
      const key = decodeCursor(`projects:${filters}`, cursor, 2);
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (connection_id !== undefined) {
        where.push("connection_id = ?");
        params.push(connection_id);
      }
      if (search !== undefined && search !== "") {
        where.push("(name LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\')");
        const like = `%${search.replace(/[\\%_]/g, char => `\\${char}`)}%`;
        params.push(like, like);
      }
      if (key) {
        where.push("(path, id) > (?, ?)");
        params.push(String(key[0]), String(key[1]));
      }
      const sql = `SELECT * FROM projects ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY path, id LIMIT ?`;
      const rows = db.prepare(sql).all(...params, limit + 1) as ProjectRow[];
      return pageOf(rows, limit, `projects:${filters}`, row => [row.path, row.id], projectRecord);
    },

    updateProject(actor, id, patch, ifMatch, reauthValid) {
      db.transaction(() => {
        const row = projectRowOf(id);
        if (!row) throw notFound("项目");
        ifMatch(row.revision);
        const enabled = patch.enabled ?? row.enabled === 1;
        const writeMode = patch.write_mode ?? row.write_mode;
        const raising = WRITE_RANK[writeMode] > WRITE_RANK[row.write_mode];
        const switches = Object.fromEntries(SWITCH_FIELDS.map(field => [field, patch[field] ?? row[field] === 1])) as Record<SwitchField, boolean>;
        // 打开任一任务开关（false→true）与调高写入模式同级：只归 owner 并要求重新认证；关掉开关 operator 即可。
        const opened = SWITCH_FIELDS.filter(field => switches[field] && row[field] !== 1);
        if (raising || opened.length > 0) {
          // 调高写入模式（包括关闭 dry_run）只归 owner 并要求重新认证（S-09 第 2 项）。
          if (actor.role !== "owner") throw new PlatformError(403, "forbidden", raising ? "只有 owner 能调高写入模式" : "只有 owner 能打开项目的任务开关");
          if (!reauthValid) throw new PlatformError(403, "reauth_required", raising ? "调高写入模式前需要在 10 分钟内重新认证" : "打开任务开关前需要在 10 分钟内重新认证");
          if (row.status !== "active" || row.archived === 1) throw new PlatformError(409, "repo_inactive", "已归档或已消失的项目不能写入");
          if (raising && WRITE_RANK[writeMode] > WRITE_RANK[ctx.config.writeModeCeiling]) throw new PlatformError(409, "write_mode_ceiling", `超过实例的全局写入模式上限（${ctx.config.writeModeCeiling}）`);
          const connection = rowOf(row.connection_id);
          if (!connection || connection.enabled === 0) throw new PlatformError(409, "invalid_state", "连接已停用，不能打开写入");
          const capabilities = parseJsonColumn<string[]>(row.capabilities_json, []);
          const missing = opened.filter(field => !capabilities.includes(field.slice(0, -"_enabled".length)));
          if (missing.length > 0) throw new PlatformError(409, "capability_unavailable", `机器人在这个项目上的平台权限不支持：${missing.join("、")}`);
        }
        if (enabled && row.status !== "active") throw new PlatformError(409, "repo_inactive", "项目已在平台上消失（lost），不能启用");
        if ((patch.machine_ids !== undefined || patch.tags !== undefined) && !roleAtLeast(actor, "operator")) throw new PlatformError(403, "forbidden", "当前角色不能分配机器");
        if (patch.machine_ids !== undefined) {
          for (const machineId of patch.machine_ids) {
            if (!db.prepare("SELECT 1 FROM machines WHERE id = ? AND status <> 'disabled'").get(machineId)) throw new PlatformError(422, "unknown_machine", "machine_ids 里有不存在的机器");
          }
        }
        const machineIds = patch.machine_ids ?? parseJsonColumn<string[]>(row.machine_ids_json, []);
        const tags = patch.tags ?? parseJsonColumn<string[]>(row.tags_json, []);
        db.prepare(
          "UPDATE projects SET enabled = ?, write_mode = ?, review_enabled = ?, triage_enabled = ?, fix_enabled = ?, rework_enabled = ?, machine_ids_json = ?, tags_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
        ).run(
          enabled ? 1 : 0, writeMode, switches.review_enabled ? 1 : 0, switches.triage_enabled ? 1 : 0, switches.fix_enabled ? 1 : 0, switches.rework_enabled ? 1 : 0,
          JSON.stringify(machineIds), JSON.stringify(tags), clock(), id,
        );
        auditor.write({
          actorType: "user", actorId: String(actor.githubId), action: "project.update", target: `project/${id}`,
          detail: {
            enabled: patch.enabled ?? null, write_mode: patch.write_mode ?? null, from_write_mode: row.write_mode, machine_ids: patch.machine_ids ?? null, tags: patch.tags ?? null,
            switches: Object.fromEntries(SWITCH_FIELDS.filter(field => patch[field] !== undefined).map(field => [field, patch[field] as boolean])),
          },
          reauth: raising || opened.length > 0,
        });
      })();
      const record = service.getProject(id);
      bus.publish("project.updated", ["projects", "repos"], record);
      return record;
    },

    listItems(projectId, { limit, cursor, kind }) {
      if (!projectRowOf(projectId)) throw notFound("项目");
      const filters = `items:${projectId}:${kind ?? ""}`;
      const key = decodeCursor(filters, cursor, 2);
      const where = ["project_id = ?"];
      const params: (string | number)[] = [projectId];
      if (kind !== undefined) {
        where.push("kind = ?");
        params.push(kind);
      }
      if (key) {
        where.push("(updated_at < ? OR (updated_at = ? AND id < ?))");
        params.push(Number(key[0]), Number(key[0]), String(key[1]));
      }
      const rows = db.prepare(`SELECT * FROM items WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, id DESC LIMIT ?`).all(...params, limit + 1) as ItemRow[];
      // 每个条目附上它当前未结束的任务（查询结果，不落库）。
      return pageOf(rows, limit, filters, row => [row.updated_at, row.id], row => itemRecord(row, (db.prepare(ACTIVE_TASK_SQL).get(row.id) as ActiveTaskView | undefined) ?? null));
    },

    syncProject,

    startPolling() {
      stopped = false;
      const tick = () => {
        if (stopped || polling) return;
        polling = pollOnce().finally(() => {
          polling = null;
        });
      };
      pollTimer = setInterval(tick, ctx.config.syncIntervalS * 1000);
      pollTimer.unref();
    },

    async stopPolling() {
      stopped = true;
      clearInterval(pollTimer ?? undefined);
      pollTimer = null;
      await polling;
    },
  };
  return service;
}
