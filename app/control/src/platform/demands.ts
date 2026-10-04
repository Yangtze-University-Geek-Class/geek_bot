/**
 * 需求：后台手工创建，或经 Feishu 原生事件回调、通用签名 webhook 入站（#34）。
 *
 * - IM 入站先落库成需求，再由管理员（或事件里的项目提示）关联项目；没有关联项目的需求不能派发。
 * - 代码平台来源（github、gitlab）的需求由任务服务按条目生成（demands.item_id），标题与正文随条目同步、项目固定，后台不能改。
 * - 入站事件按 (连接, 事件 id) 去重：同一事件重放只产生一个需求。
 * - 签名校验与挑战应答由 connectors 的 IM 适配器完成（凭据只在 connectors 里解密）；Core 只消费归一化的结果。
 */
import type { DemandRecord, DemandStatus } from "@geek-bot/protocol";
import { imConnectorForConnection } from "../connectors/index.js";
import type { SessionInfo } from "./auth.js";
import type { PlatformContext } from "./context.js";
import { decodeCursor, newId, notFound, PlatformError, pageOf } from "./http.js";
import { CONNECTION_SELECT, connectionRecord, demandRecord, type ConnectionRow, type DemandRow } from "./records.js";
import type { DemandNotifier } from "./tasks.js";

export interface DemandsService {
  get(id: string): DemandRecord;
  list(query: { limit: number; cursor?: string; status?: DemandStatus; project_id?: string }): { items: DemandRecord[]; next_cursor: string | null };
  create(actor: SessionInfo, input: { title: string; body: string; project_id?: string }): DemandRecord;
  update(actor: SessionInfo, id: string, patch: { title?: string; body?: string; project_id?: string | null }, ifMatch: (revision: number) => void): DemandRecord;
  /** IM 入站：返回要回给平台的 HTTP 状态与 JSON。 */
  intake(provider: "feishu" | "webhook", connectionId: string, headers: Readonly<Record<string, string | string[] | undefined>>, body: unknown, rawBody: Buffer): Promise<{ status: number; body: unknown }>;
}

export function createDemandsService(ctx: PlatformContext, notifier: DemandNotifier): DemandsService {
  const { db, clock, auditor, bus, logger } = ctx;
  const rowOf = (id: string) => db.prepare("SELECT * FROM demands WHERE id = ?").get(id) as DemandRow | undefined;

  function checkProject(projectId: string): void {
    const project = db.prepare("SELECT status FROM projects WHERE id = ?").get(projectId) as { status: string } | undefined;
    if (!project) throw new PlatformError(422, "unknown_project", "项目不存在");
    if (project.status !== "active") throw new PlatformError(409, "repo_inactive", "项目已在平台上消失（lost）");
  }

  function publish(row: DemandRow): void {
    bus.publish("demand.updated", ["demands", "overview"], demandRecord(row));
  }

  /** 项目提示：可以是项目 id，或 path（例如 <owner>/<repo>）；只在同一连接的发现结果里找唯一匹配。 */
  function resolveProjectHint(hint: string | undefined): string | null {
    if (hint === undefined || hint === "" || hint.length > 300) return null;
    const rows = db.prepare("SELECT id FROM projects WHERE status = 'active' AND (id = ? OR path = ?) LIMIT 2").all(hint, hint) as { id: string }[];
    return rows.length === 1 ? (rows[0]?.id ?? null) : null;
  }

  return {
    get(id) {
      const row = rowOf(id);
      if (!row) throw notFound("需求");
      return demandRecord(row);
    },

    list({ limit, cursor, status, project_id }) {
      const filters = `demands:${JSON.stringify([status ?? null, project_id ?? null])}`;
      const key = decodeCursor(filters, cursor, 2);
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (status !== undefined) {
        where.push("status = ?");
        params.push(status);
      }
      if (project_id !== undefined) {
        where.push("project_id = ?");
        params.push(project_id);
      }
      if (key) {
        where.push("(created_at < ? OR (created_at = ? AND id < ?))");
        params.push(Number(key[0]), Number(key[0]), String(key[1]));
      }
      const rows = db.prepare(`SELECT * FROM demands ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...params, limit + 1) as DemandRow[];
      return pageOf(rows, limit, filters, row => [row.created_at, row.id], demandRecord);
    },

    create(actor, input) {
      if (input.project_id !== undefined) checkProject(input.project_id);
      const now = clock();
      const id = newId("dmd");
      db.prepare(
        "INSERT INTO demands (id, title, body, project_id, source, source_ref, source_connection_id, status, revision, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'manual', ?, NULL, 'new', 1, ?, ?, ?)",
      ).run(id, input.title, input.body, input.project_id ?? null, `admin/${actor.githubId}`, actor.githubId, now, now);
      auditor.write({ actorType: "user", actorId: String(actor.githubId), action: "demand.create", target: `demand/${id}`, detail: { project_id: input.project_id ?? null } });
      const row = rowOf(id) as DemandRow;
      publish(row);
      return demandRecord(row);
    },

    update(actor, id, patch, ifMatch) {
      const row = db.transaction(() => {
        const current = rowOf(id);
        if (!current) throw notFound("需求");
        ifMatch(current.revision);
        if (current.item_id !== null) throw new PlatformError(409, "invalid_state", "代码平台条目的需求随条目同步，不能手工修改；处理条目请从项目的条目列表派发");
        if (patch.project_id !== undefined && patch.project_id !== current.project_id) {
          if (current.status === "queued" || current.status === "running") throw new PlatformError(409, "invalid_state", "需求有排队或运行中的任务，不能改关联项目");
          if (patch.project_id !== null) checkProject(patch.project_id);
        }
        db.prepare("UPDATE demands SET title = ?, body = ?, project_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?").run(
          patch.title ?? current.title,
          patch.body ?? current.body,
          patch.project_id === undefined ? current.project_id : patch.project_id,
          clock(),
          id,
        );
        auditor.write({ actorType: "user", actorId: String(actor.githubId), action: "demand.update", target: `demand/${id}`, detail: { title: patch.title !== undefined, body: patch.body !== undefined, project_id: patch.project_id ?? null } });
        return rowOf(id) as DemandRow;
      })();
      publish(row);
      return demandRecord(row);
    },

    async intake(provider, connectionId, headers, body, rawBody) {
      ctx.limiter.hit(`intake:${connectionId}`, 240, 60_000);
      const row = db.prepare(`${CONNECTION_SELECT} WHERE c.id = ?`).get(connectionId) as ConnectionRow | undefined;
      // 连接不存在、平台不符或停用都回同一个 404，不透露连接是否存在。
      if (!row || row.provider !== provider || row.enabled !== 1 || row.secret_configured !== 1) throw new PlatformError(404, "not_found", "没有这个入站地址");
      const im = imConnectorForConnection({ db, masterKey: ctx.masterKey, connection: connectionRecord(row), fetchImpl: ctx.fetchImpl, redactor: ctx.redactor });
      let verdict;
      try {
        verdict = await im.verifyEvent(headers, body, rawBody);
      } catch (error) {
        logger.warn({ connection_id: connectionId, err: error }, "IM 入站事件校验失败");
        auditor.write({ actorType: "system", action: "intake.rejected", target: `connection/${connectionId}` });
        throw new PlatformError(401, "signature_invalid", "入站事件签名或令牌校验失败");
      }
      if (verdict.type === "challenge") return { status: 200, body: verdict.response };
      if (verdict.type === "ignored") return { status: 200, body: {} };
      const now = clock();
      const created = db.transaction(() => {
        const seen = db.prepare("INSERT INTO intake_events (connection_id, event_id, demand_id, received_at) VALUES (?, ?, NULL, ?) ON CONFLICT (connection_id, event_id) DO NOTHING").run(connectionId, verdict.event_id.slice(0, 200), now);
        if (seen.changes === 0) return null;
        const id = newId("dmd");
        const title = ctx.redactor.redactText(verdict.title).trim().slice(0, 200) || "（无标题）";
        const text = ctx.redactor.redactText(verdict.body).slice(0, 20_000);
        const projectId = resolveProjectHint(verdict.project_hint);
        db.prepare(
          "INSERT INTO demands (id, title, body, project_id, source, source_ref, source_connection_id, status, revision, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'new', 1, NULL, ?, ?)",
        ).run(id, title, text, projectId, provider, verdict.source_ref.slice(0, 500), connectionId, now, now);
        db.prepare("UPDATE intake_events SET demand_id = ? WHERE connection_id = ? AND event_id = ?").run(id, connectionId, verdict.event_id.slice(0, 200));
        auditor.write({ actorType: "system", action: "intake.demand", target: `demand/${id}`, detail: { connection_id: connectionId, provider, project_id: projectId } });
        return rowOf(id) as DemandRow;
      })();
      if (created) {
        publish(created);
        // 回执只排进 publisher 的 outbox，不在平台的回调时限里等网络。
        const record = demandRecord(created);
        notifier(record, record.project_id === null ? "需求已接收，需要管理员关联项目后才能执行。" : "需求已接收，已关联项目，等待派发。", null);
      }
      return { status: 200, body: {} };
    },
  };
}
