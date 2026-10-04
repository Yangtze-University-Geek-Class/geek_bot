/**
 * 后台管理员（A-09…A-11；ADR-0002）：按 GitHub 数字 id 识别；owner 由认领产生，邀请与移除只归 owner 并要求重新认证。
 * 被邀请的人能看到机器人读到的私有内容（R-21），由界面在邀请时提示。
 */
import type { AdminRole } from "@geek-bot/protocol";
import type { SessionInfo } from "./auth.js";
import type { IdempotentResult, PlatformContext } from "./context.js";
import { decodeCursor, PlatformError, pageOf } from "./http.js";
import { adminRecord, type AdminRow, type AdminView } from "./records.js";

export interface AdminsService {
  list(query: { limit: number; cursor?: string }): { items: AdminView[]; next_cursor: string | null };
  invite(actor: SessionInfo, input: { github_id: number; role: Exclude<AdminRole, "owner">; note?: string }): IdempotentResult;
  remove(actor: SessionInfo, githubId: number): void;
}

export function createAdminsService(ctx: PlatformContext, dropSessions: (githubId: number) => void): AdminsService {
  const { db, clock, auditor } = ctx;
  return {
    list({ limit, cursor }) {
      const key = decodeCursor("admins", cursor, 2);
      const rows = (key
        ? db.prepare("SELECT * FROM admins WHERE (invited_at, github_id) > (?, ?) ORDER BY invited_at, github_id LIMIT ?").all(Number(key[0]), Number(key[1]), limit + 1)
        : db.prepare("SELECT * FROM admins ORDER BY invited_at, github_id LIMIT ?").all(limit + 1)) as AdminRow[];
      return pageOf(rows, limit, "admins", row => [row.invited_at, row.github_id], adminRecord);
    },

    invite(actor, input) {
      if (db.prepare("SELECT 1 FROM admins WHERE github_id = ?").get(input.github_id)) throw new PlatformError(409, "already_admin", "这个 GitHub 账号已经在管理员名单里");
      // login 在对方第一次登录时由 GitHub 返回的值更新；之前显示数字 id。
      db.prepare("INSERT INTO admins (github_id, login, role, note, invited_by, invited_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, NULL)").run(input.github_id, `#${input.github_id}`, input.role, input.note ?? null, actor.githubId, clock());
      auditor.write({ actorType: "user", actorId: String(actor.githubId), action: "admin.invite", target: `admin/${input.github_id}`, detail: { role: input.role }, reauth: true });
      return { status: 201, body: adminRecord(db.prepare("SELECT * FROM admins WHERE github_id = ?").get(input.github_id) as AdminRow) };
    },

    remove(actor, githubId) {
      db.transaction(() => {
        const row = db.prepare("SELECT role FROM admins WHERE github_id = ?").get(githubId) as { role: AdminRole } | undefined;
        if (!row) throw new PlatformError(404, "not_found", "管理员不存在");
        if (row.role === "owner") throw new PlatformError(409, "cannot_remove_owner", "不能移除 owner");
        dropSessions(githubId);
        db.prepare("DELETE FROM admins WHERE github_id = ?").run(githubId);
        auditor.write({ actorType: "user", actorId: String(actor.githubId), action: "admin.remove", target: `admin/${githubId}`, reauth: true });
      })();
    },
  };
}
