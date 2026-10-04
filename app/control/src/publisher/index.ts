import { createHash, randomUUID } from "node:crypto";
import type { ConnectionRecord, DemandRecord, ItemRecord, ProjectRecord, TaskRecord, WriteMode } from "@geek-bot/protocol";
import type { Db } from "../db/database.js";
import type { Redactor } from "../log/redact.js";
import type { Logger } from "../log/logger.js";
import { connectorForConnection, imConnectorForConnection, ConnectorError, type DiscoveredItem, type FetchLike } from "../connectors/index.js";
import { storedCredentials } from "../connectors/credentials.js";
import { ApiTransport, object, string } from "../connectors/http.js";
import { inspectPatch, pushPatch } from "./git.js";

export type PublicationState = "pending" | "sending" | "sent" | "confirmed" | "failed" | "rejected" | "dry_run" | "unknown";
export interface Publication { readonly id: string; readonly state: PublicationState; readonly preview: string }
interface PublicationRow { id: string; task_id: string; project_id: string; connection_id: string; action: string; dedupe_key: string; state: PublicationState; write_mode: WriteMode; payload_json: string; preview: string; external_ref: string | null; created_at: number; updated_at: number }
export interface PublisherOptions { readonly db: Db; readonly masterKey: Buffer; readonly env: Readonly<Record<string, string | undefined>>; readonly clock?: () => number; readonly redactor: Redactor; readonly logger: Logger; readonly fetchImpl?: FetchLike }
interface ProjectAuthorization {
  enabled: number; archived: number; status: string; write_mode: WriteMode;
  review_enabled: number; triage_enabled: number; fix_enabled: number; rework_enabled: number;
}
const SWITCH_BY_KIND = { review: "review_enabled", triage: "triage_enabled", followup: "triage_enabled", fix: "fix_enabled", rework: "rework_enabled" } as const;
export interface Publisher {
  publish(task: TaskRecord, project: ProjectRecord, connection: ConnectionRecord, item?: ItemRecord | null): Promise<Publication>;
  reconcile(): Promise<void>;
  flush(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
  notifyDemand(demand: DemandRecord, text: string, task?: TaskRecord | null): Promise<Publication>;
}

export function neutralizeOutput(text: string, redactor: Redactor): string {
  return redactor.redactText(text).replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s+(#[0-9]+|[\w.-]+(?:\/[\w.-]+)+#[0-9]+|https?:\/\/[^\s<>]+\/(?:issues|pull|merge_requests)\/[0-9]+)/gi, "关联 $1")
    .replace(/([\w.-]+(?:\/[\w.-]+)+)#([0-9]+)/g, "$1＃$2")
    .replace(/https?:\/\/[^\s<>]+\/(?:issues|pull|merge_requests)\/[0-9]+/gi, reference => reference.replace("://", "：//"))
    .replace(/结论\s*[：:]\s*(?:通过|有条件通过|阻塞)/g, "机器意见（不构成人工审查结论）")
    .replace(/^\s*\/(?:approve|lgtm|merge|close|reopen|label|assign|unassign|milestone|rebase|target_branch|remove_source_branch)\b/gim, "已中和的指令 ")
    .replace(/@/g, "＠").slice(0, 60000);
}
/** OAuth临时登录令牌的单枚撤销（不是grant），所有外部写操作仍在publisher。 */
export async function revokeOAuthToken(options: { token: string; clientId: string; clientSecret: string; apiBaseUrl: string; fetchImpl?: FetchLike }): Promise<void> {
  if (!options.clientId || !options.clientSecret || !options.token) throw new ConnectorError("oauth_not_configured", "OAuth令牌撤销尚未配置", 409);
  const auth = Buffer.from(`${options.clientId}:${options.clientSecret}`, "utf8").toString("base64");
  const api = new ApiTransport(options.apiBaseUrl, { Authorization: `Basic ${auth}`, "Content-Type": "application/json", Accept: "application/vnd.github+json" }, options.fetchImpl);
  const response = await api.response(`applications/${encodeURIComponent(options.clientId)}/token`, { method: "DELETE", body: JSON.stringify({ access_token: options.token }) });
  await response.body?.cancel();
}

function writeMode(project: WriteMode, maximum: string): WriteMode {
  const order: Record<WriteMode, number> = { off: 0, dry_run: 1, on: 2 };
  if (!(maximum in order)) throw new ConnectorError("write_mode_invalid", "全局写入模式不合法", 503);
  return order[project] <= order[maximum as WriteMode] ? project : maximum as WriteMode;
}
function apiFor(connection: ConnectionRecord, token: string, fetchImpl?: FetchLike): ApiTransport {
  const base = new URL(connection.base_url);
  if (connection.provider === "gitlab" && !/\/api\/v4\/?$/.test(base.pathname)) base.pathname = base.pathname.replace(/\/?$/, "/api/v4/");
  return new ApiTransport(base.href, { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: connection.provider === "github" ? "application/vnd.github+json" : "application/json" }, fetchImpl);
}
/** 同一平台条目上的同一逻辑动作不因任务重排、epoch 或执行节点变化而重新写入。 */
function publicationKey(task: TaskRecord, project: ProjectRecord, connection: ConnectionRecord, item: ItemRecord | null): string {
  const target = item?.id ?? task.demand_id ?? task.id;
  const version = task.kind === "fix" ? "create" : task.head_sha ?? createHash("sha256").update(`${item?.title ?? ""}\0${item?.body ?? ""}`).digest("hex");
  return JSON.stringify([connection.id, project.id, task.kind, target, version]);
}

function prefixFor(connection: ConnectionRecord, project: ProjectRecord): string {
  return connection.provider === "github" ? `repos/${project.path.split("/").map(encodeURIComponent).join("/")}` : `projects/${encodeURIComponent(project.external_id)}`;
}

export function createPublisher(options: PublisherOptions): Publisher {
  const { db, masterKey, env, redactor, logger, fetchImpl } = options;
  const clock = options.clock ?? Date.now;
  const inFlight = new Map<string, Promise<Publication>>();
  let imCycle: Promise<void> | undefined;
  let closing = false;
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  const maximum = env.GEEK_BOT_WRITE_MODE ?? "dry_run";
  const role = env.GEEK_BOT_INSTANCE_ROLE;
  const scope = (value: string | undefined) => (value ?? "").split(",").map(part => part.trim()).filter(Boolean);
  const previewAllow = scope(env.GEEK_BOT_PUBLISHER_REPO_ALLOWLIST);
  const productionDeny = scope(env.GEEK_BOT_PUBLISHER_REPO_DENYLIST);
  function update(id: string, state: PublicationState, externalRef: string | null = null, error: string | null = null): void {
    db.prepare("UPDATE publications SET state=?, external_ref=COALESCE(?,external_ref), last_error=?, updated_at=? WHERE id=?").run(state, externalRef, error && redactor.redactText(error), clock(), id);
  }
  function view(row: PublicationRow): Publication { return { id: row.id, state: row.state, preview: row.preview }; }
  function marker(task: TaskRecord): string { return `<!-- geek-bot v1 env=${role} kind=${task.kind} task=${task.id} sha=${task.head_sha?.slice(0, 12) ?? "none"} round=${task.epoch} -->`; }
  function environmentAllowed(project: ProjectRecord): boolean {
    if (role === "preview") return previewAllow.includes(project.id) || previewAllow.includes(project.path);
    if (role === "production") return !productionDeny.includes(project.id) && !productionDeny.includes(project.path);
    return false;
  }
  function rateAvailable(connectionId: string, task: TaskRecord): boolean {
    const now = clock();
    const minuteRow = db.prepare("SELECT count(*) AS n FROM publications WHERE connection_id=? AND state IN ('sending','sent','confirmed','unknown') AND updated_at>=?").get(connectionId, now - 60000) as { n: number };
    const hourRow = db.prepare("SELECT count(*) AS n FROM publications WHERE connection_id=? AND state IN ('sending','sent','confirmed','unknown') AND updated_at>=?").get(connectionId, now - 3600000) as { n: number };
    if (minuteRow.n >= 60 || hourRow.n >= 400) return false;
    if (task.kind === "review" && task.item_id) {
      const previous = db.prepare("SELECT 1 FROM publications p JOIN tasks t ON t.id=p.task_id WHERE t.item_id=? AND p.task_id<>? AND p.action='review' AND p.state IN ('sending','sent','confirmed','unknown') AND p.updated_at>=? LIMIT 1").get(task.item_id, task.id, now - 300000);
      if (previous) return false;
    }
    return true;
  }
  async function findRemote(row: PublicationRow, connection: ConnectionRecord, project: ProjectRecord, item: ItemRecord | null, accountId: string): Promise<string | null> {
    const credentials = storedCredentials(db, masterKey, connection.id, redactor);
    if (!credentials.token) throw new ConnectorError("connection_unconfigured", "代码渠道尚未绑定账号", 409);
    const api = apiFor(connection, credentials.token, fetchImpl);
    const prefix = prefixFor(connection, project);
    const payload = JSON.parse(row.payload_json) as { marker: string; branch?: string };
    let values: readonly Record<string, unknown>[];
    if (row.action === "fix") {
      values = await api.pages(connection.provider === "github" ? `${prefix}/pulls?state=all&per_page=100` : `${prefix}/merge_requests?state=all&per_page=100`);
    } else if (!item) return null;
    else if (row.action === "review" && connection.provider === "github") values = await api.pages(`${prefix}/pulls/${item.number}/reviews?per_page=100`);
    else values = await api.pages(connection.provider === "github" ? `${prefix}/issues/${item.number}/comments?per_page=100` : `${prefix}/${item.kind === "change" ? "merge_requests" : "issues"}/${item.number}/notes?per_page=100`);
    const matched = values.filter(value => {
      const author = object(connection.provider === "github" ? value.user : value.author);
      return String(author.id) === accountId && string(value.body, string(value.description)).includes(payload.marker);
    });
    if (matched.length > 1) throw new ConnectorError("publication_duplicate_detected", "渠道已有重复的机器人记录，需要人工核对", 409);
    return matched.length === 1 ? String(matched[0].id ?? matched[0].number ?? matched[0].iid) : null;
  }
  async function perform(task: TaskRecord, project: ProjectRecord, connection: ConnectionRecord, item: ItemRecord | null): Promise<Publication> {
    if (closing) throw new ConnectorError("publisher_stopping", "发布服务正在停止", 503);
    const key = publicationKey(task, project, connection, item);
    const current = db.prepare("SELECT * FROM publications WHERE dedupe_key=?").get(key) as PublicationRow | undefined;
    if (current && ["confirmed", "sent", "dry_run", "rejected"].includes(current.state)) return view(current);
    if (!task.result) throw new ConnectorError("result_required", "任务没有可发布的结果", 409);
    const actualTask = db.prepare("SELECT status,epoch,head_sha,base_sha FROM tasks WHERE id=?").get(task.id) as { status: string; epoch: number; head_sha: string | null; base_sha: string | null } | undefined;
    const actualProject = db.prepare("SELECT enabled,archived,status,write_mode,review_enabled,triage_enabled,fix_enabled,rework_enabled FROM projects WHERE id=?").get(project.id) as ProjectAuthorization | undefined;
    const actualConnection = db.prepare("SELECT enabled,base_url FROM connections WHERE id=?").get(connection.id) as { enabled: number; base_url: string } | undefined;
    if (!actualTask || actualTask.status !== "awaiting_publish" || actualTask.epoch !== task.epoch || actualTask.head_sha !== task.head_sha || actualTask.base_sha !== task.base_sha) throw new ConnectorError("task_changed", "任务状态或执行快照已经变化", 409);
    if (!actualProject?.enabled || actualProject.archived || actualProject.status !== "active" || !actualConnection?.enabled || actualConnection.base_url !== connection.base_url || project.connection_id !== connection.id) throw new ConnectorError("publish_target_rejected", "项目或渠道已禁用、不再可写或绑定发生变化", 409);
    if (actualProject[SWITCH_BY_KIND[task.kind]] !== 1) throw new ConnectorError("project_action_disabled", "项目未授权此类外部处理", 409);
    if (!environmentAllowed(project)) throw new ConnectorError("environment_write_rejected", "此环境不允许写入该项目", 403);
    const mode = writeMode(actualProject.write_mode, maximum);
    if (mode === "off") throw new ConnectorError("writes_disabled", "此项目的外部写入已关闭", 409);
    const connector = connectorForConnection({ db, masterKey, connection, fetchImpl, redactor });
    const identity = await connector.identity();
    if (connection.provider === "github" && identity.scopes.some(value => value !== "repo" && value !== "read:org")) throw new ConnectorError("scope_rejected", "GitHub令牌权限超出允许范围，拒绝写入", 403);
    const freshProject = await connector.project(project);
    if (freshProject.external_id !== project.external_id || freshProject.archived || !freshProject.capabilities.includes(task.kind)) throw new ConnectorError("capability_unavailable", "渠道当前权限不足或项目已归档", 409);
    let freshItem: DiscoveredItem | null = null;
    if (item) {
      freshItem = await connector.item(project, item);
      if (item.kind === "change" && freshItem.head_sha !== task.head_sha) throw new ConnectorError("head_changed", "变更已有新提交，旧结果不能发布", 409);
      if (item.kind === "issue" && freshItem.state !== "open" && freshItem.state !== "opened") throw new ConnectorError("item_inactive", "条目已经关闭，拒绝写入旧结果", 409);
      if (task.kind === "review" && freshItem.bot_authored) throw new ConnectorError("own_review_rejected", "机器人不审查自己发起的变更", 403);
    }
    const credentials = storedCredentials(db, masterKey, connection.id, redactor);
    if (!credentials.token) throw new ConnectorError("connection_unconfigured", "代码渠道尚未绑定账号", 409);
    const credentialSnapshot = db.prepare("SELECT credentials_ct FROM connection_credentials WHERE connection_id=?").get(connection.id) as { credentials_ct: string };
    function assertPublishable(): void {
      const liveTask = db.prepare("SELECT status,epoch FROM tasks WHERE id=?").get(task.id) as { status: string; epoch: number } | undefined;
      const liveProject = db.prepare("SELECT enabled,archived,status,write_mode,review_enabled,triage_enabled,fix_enabled,rework_enabled FROM projects WHERE id=?").get(project.id) as ProjectAuthorization | undefined;
      if (liveProject?.[SWITCH_BY_KIND[task.kind]] !== 1) throw new ConnectorError("project_action_disabled", "项目在发布期间关闭了此类处理", 409);
      const liveConnection = db.prepare("SELECT enabled,base_url FROM connections WHERE id=?").get(connection.id) as { enabled: number; base_url: string } | undefined;
      const liveCredentials = db.prepare("SELECT credentials_ct FROM connection_credentials WHERE connection_id=?").get(connection.id) as { credentials_ct: string } | undefined;
      if (closing || liveTask?.status !== "awaiting_publish" || liveTask.epoch !== task.epoch || !liveProject?.enabled || liveProject.archived || liveProject.status !== "active"
        || writeMode(liveProject.write_mode, maximum) !== "on" || !liveConnection?.enabled || liveConnection.base_url !== connection.base_url || liveCredentials?.credentials_ct !== credentialSnapshot.credentials_ct) {
        throw new ConnectorError("publication_authorization_changed", "发布期间任务、权限或凭据发生变化，拒绝继续写入", 409);
      }
    }
    const generatedMarker = marker(task);
    const body = `${neutralizeOutput(task.result.body || task.result.summary, redactor)}\n\n${generatedMarker}`;
    const action = task.kind === "fix" ? "fix" : task.kind === "rework" ? "rework" : task.kind === "review" ? "review" : "comment";
    const branch = `geek_bot/${task.id.replace(/[^a-z0-9_]/gi, "_").toLowerCase()}`;
    if (["fix", "rework"].includes(action)) {
      if (task.executor !== "vm" || !task.result.patch) throw new ConnectorError("patch_required", "修复只能发布VM产生的有效补丁", 409);
      inspectPatch(task.result.patch);
    } else if (!item) throw new ConnectorError("item_required", "此发布动作需要明确的代码平台条目", 409);
    if (current && ["unknown", "sending"].includes(current.state)) {
      const remote = await findRemote(current, connection, project, item, identity.account_external_id);
      if (remote) { update(current.id, "confirmed", remote); return { id: current.id, state: "confirmed", preview: current.preview }; }
      return { id: current.id, state: "unknown", preview: current.preview };
    }
    const id = current?.id ?? randomUUID();
    const payload = JSON.stringify({ marker: generatedMarker, branch, item_id: item?.id ?? null, number: item?.number ?? null, head_sha: task.head_sha, base_sha: task.base_sha });
    if (!current) db.prepare("INSERT INTO publications (id,task_id,project_id,connection_id,action,dedupe_key,state,write_mode,payload_json,preview,attempts,created_at,updated_at) VALUES (?,?,?,?,?,?,'pending',?,?,?,0,?,?)").run(id, task.id, project.id, connection.id, action, key, mode, payload, body, clock(), clock());
    if (mode === "dry_run") { update(id, "dry_run"); return { id, state: "dry_run", preview: body }; }
    if (!rateAvailable(connection.id, task)) throw new ConnectorError("publish_rate_limited", "外部写入达到频率上限，请稍后再处理", 429);
    assertPublishable();
    db.prepare("UPDATE publications SET state='sending',attempts=attempts+1,updated_at=? WHERE id=?").run(clock(), id);
    try {
      const api = apiFor(connection, credentials.token, fetchImpl);
      assertPublishable();
      const prefix = prefixFor(connection, project);
      let response: Record<string, unknown>;
      if (action === "review") {
        response = object((await api.json(connection.provider === "github" ? `${prefix}/pulls/${item!.number}/reviews` : `${prefix}/merge_requests/${item!.number}/notes`, { method: "POST", body: JSON.stringify(connection.provider === "github" ? { event: "COMMENT", commit_id: task.head_sha, body } : { body }) })).data);
      } else if (action === "comment") {
        response = object((await api.json(connection.provider === "github" ? `${prefix}/issues/${item!.number}/comments` : `${prefix}/issues/${item!.number}/notes`, { method: "POST", body: JSON.stringify({ body }) })).data);
      } else {
        let writeBranch = branch;
        let expectedHead: string | undefined;
        if (action === "rework") {
          if (!item || item.kind !== "change" || !freshItem?.bot_authored) throw new ConnectorError("rework_target_rejected", "只能返工机器人自己发起的变更", 403);
          const remote = object(await api.get(connection.provider === "github" ? `${prefix}/pulls/${item.number}` : `${prefix}/merge_requests/${item.number}`));
          if (connection.provider === "github") {
            const head = object(remote.head); const repo = object(head.repo);
            if (String(repo.id) !== project.external_id) throw new ConnectorError("fork_write_rejected", "返工不能写入fork或其它项目", 403);
            writeBranch = string(head.ref);
          } else { if (String(remote.source_project_id) !== project.external_id) throw new ConnectorError("fork_write_rejected", "返工不能写入fork或其它项目", 403); writeBranch = string(remote.source_branch); }
          expectedHead = task.head_sha ?? undefined;
          if (!expectedHead) throw new ConnectorError("task_snapshot_missing", "返工缺少固定的分支提交", 409);
          const original = db.prepare("SELECT payload_json FROM publications WHERE project_id=? AND connection_id=? AND action='fix' AND state IN ('sent','confirmed') AND external_ref=? LIMIT 1").get(project.id, connection.id, item.external_id) as { payload_json: string } | undefined;
          const originalPayload: unknown = original ? JSON.parse(original.payload_json) : null;
          if (!originalPayload || typeof originalPayload !== "object" || !("branch" in originalPayload) || originalPayload.branch !== writeBranch) throw new ConnectorError("rework_target_rejected", "此变更没有本实例创建的机器人分支记录", 403);
        }
        const pushed = await pushPatch({ task, project, connection, token: credentials.token, branch: writeBranch, patch: task.result.patch!, expectedHead, assertAllowed: assertPublishable });
        assertPublishable();
        if (action === "rework") {
          response = object((await api.json(connection.provider === "github" ? `${prefix}/issues/${item!.number}/comments` : `${prefix}/merge_requests/${item!.number}/notes`, { method: "POST", body: JSON.stringify({ body: `${body}\n\n追加提交：${pushed.commit}` }) })).data);
        } else {
          const description = `${body}\n\n**结论：阻塞**（等待人工审查；机器人不批准、不合并）`;
          const title = neutralizeOutput(task.result.summary, redactor).slice(0, 180);
          response = object((await api.json(connection.provider === "github" ? `${prefix}/pulls` : `${prefix}/merge_requests`, { method: "POST", body: JSON.stringify(connection.provider === "github" ? { head: pushed.branch, base: project.default_branch, title, body: description, draft: false } : { source_branch: pushed.branch, target_branch: project.default_branch, title, description, remove_source_branch: false }) })).data);
        }
      }
      const external = response.id ?? response.number ?? response.iid;
      if (typeof external !== "number" && typeof external !== "string") throw new ConnectorError("publication_result_unknown", "渠道响应缺少发布标识");
      update(id, "confirmed", String(external));
      logger.info({ task_id: task.id, publication_id: id, action }, "外部写入已确认");
      return { id, state: "confirmed", preview: body };
    } catch (error) {
      const message = error instanceof Error ? error.message : "外部写入结果未知";
      update(id, "unknown", null, message);
      logger.warn({ task_id: task.id, publication_id: id }, "外部写入结果未知：必须先核对，不能盲目重发");
      return { id, state: "unknown", preview: body };
    }
  }
  function publish(task: TaskRecord, project: ProjectRecord, connection: ConnectionRecord, item: ItemRecord | null = null): Promise<Publication> {
    const key = project.id;
    const previous = inFlight.get(key);
    const promise = (previous ? previous.catch(() => undefined).then(() => perform(task, project, connection, item)) : perform(task, project, connection, item));
    inFlight.set(key, promise);
    void promise.finally(() => { if (inFlight.get(key) === promise) inFlight.delete(key); }).catch(() => undefined);
    return promise;
  }
  async function reconcile(): Promise<void> {
    // 只把崩溃时的sending变为unknown；无可信的远端核对结果绝不重新发。
    db.prepare("UPDATE publications SET state='unknown',last_error='发布进程中断，等待远端核对',updated_at=? WHERE state='sending'").run(clock());
    db.prepare("UPDATE im_publications SET state='unknown',last_error='回传进程中断，禁止盲目重发',updated_at=? WHERE state='sending'").run(clock());
  }
  function flushIm(): Promise<void> {
    if (imCycle) return imCycle;
    imCycle = drainIm().finally(() => { imCycle = undefined; });
    return imCycle;
  }
  return {
    publish, reconcile, flush: flushIm,
    start() { if (timer) return; running = true; closing = false; void reconcile().catch(error => logger.warn({ err: error }, "发布恢复失败")); timer = setInterval(() => { if (running) void flushIm().catch(error => logger.warn({ err: error }, "IM回传失败")); }, 1000); timer.unref(); },
    async stop() { running = false; closing = true; clearInterval(timer); timer = undefined; await Promise.allSettled([...inFlight.values(), ...(imCycle ? [imCycle] : [])]); },
    async notifyDemand(demand: DemandRecord, text: string, task: TaskRecord | null = null): Promise<Publication> {
      if (!demand.source_connection_id || !["feishu", "webhook"].includes(demand.source)) return { id: demand.id, state: "dry_run", preview: neutralizeOutput(text, redactor) };
      const preview = neutralizeOutput(text, redactor);
      const key = createHash("sha256").update(`${demand.id}:${task?.id ?? "intake"}:${task?.epoch ?? 0}:${preview}`).digest("hex");
      const existing = db.prepare("SELECT id,state,message FROM im_publications WHERE dedupe_key=?").get(key) as { id: string; state: PublicationState; message: string } | undefined;
      if (existing) return { id: existing.id, state: existing.state, preview: existing.message };
      const id = randomUUID();
      db.prepare("INSERT INTO im_publications (id,demand_id,task_id,connection_id,source_ref,message,dedupe_key,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'pending',?,?)").run(id, demand.id, task?.id ?? null, demand.source_connection_id, demand.source_ref, preview, key, clock(), clock());
      return { id, state: "pending", preview };
    },
  };
  async function drainIm(): Promise<void> {
    const rows = db.prepare("SELECT * FROM im_publications WHERE state='pending' ORDER BY created_at LIMIT 20").all() as { id: string; connection_id: string; source_ref: string; message: string; dedupe_key: string }[];
    for (const row of rows) {
      if (closing) break;
      const raw = db.prepare("SELECT * FROM connections WHERE id=?").get(row.connection_id) as Record<string, unknown> | undefined;
      if (!raw || !raw.enabled) { db.prepare("UPDATE im_publications SET state='rejected',last_error='渠道已禁用',updated_at=? WHERE id=?").run(clock(), row.id); continue; }
      if (maximum !== "on") { db.prepare("UPDATE im_publications SET state=?,updated_at=? WHERE id=?").run(maximum === "off" ? "rejected" : "dry_run", clock(), row.id); continue; }
      const connection: ConnectionRecord = { id: String(raw.id), provider: raw.provider as ConnectionRecord["provider"], name: String(raw.name), base_url: String(raw.base_url), enabled: true, status: String(raw.status), account_name: raw.account_name ? String(raw.account_name) : null, capabilities: JSON.parse(String(raw.capabilities_json)), secret_configured: true, revision: Number(raw.revision), created_at: new Date(Number(raw.created_at)).toISOString() };
      const claim = db.prepare("UPDATE im_publications SET state='sending',updated_at=? WHERE id=? AND state='pending'").run(clock(), row.id);
      if (claim.changes !== 1) continue;
      try {
        const connector = imConnectorForConnection({ db, masterKey, connection, fetchImpl, redactor });
        const external = await connector.sendMessage(row.source_ref, row.message, row.dedupe_key.slice(0, 40));
        db.prepare("UPDATE im_publications SET state='confirmed',external_ref=?,updated_at=? WHERE id=?").run(external, clock(), row.id);
      } catch (error) {
        db.prepare("UPDATE im_publications SET state='unknown',last_error=?,updated_at=? WHERE id=?").run(redactor.redactText(error instanceof Error ? error.message : "回传结果未知"), clock(), row.id);
      }
    }
  }
}
