/**
 * 审计：各模块经同一个函数写 audit_logs（SECURITY S-16，data-model「audit_logs」）。
 * 表只追加，更新和删除被迁移里的触发器拒绝；detail 写入前按密钥形态打码。
 */
import type { Redactor } from "../log/redact.js";
import type { Db } from "./database.js";

export const AUDIT_ACTOR_TYPES = Object.freeze(["user", "bot", "system", "node", "cli"] as const);
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

export interface AuditEntry {
  readonly actorType: AuditActorType;
  /** 后台账号的 GitHub 数字 id、任务 id 或节点 id；系统与 CLI 为空。 */
  readonly actorId?: string | null;
  /** 例如 backup.create、migration.apply。 */
  readonly action: string;
  /** 相关的白名单编号（W-xx、D-xx）。 */
  readonly code?: string | null;
  readonly target?: string | null;
  /** 原因、变更前后的值；不写密钥、令牌和会话 id（仍会按形态打码兜底）。 */
  readonly detail?: Readonly<Record<string, unknown>> | null;
  /** 这次操作前 10 分钟内是否重新认证过。 */
  readonly reauth?: boolean;
}

export interface Auditor {
  write(entry: AuditEntry): number;
}

export function createAuditor(db: Db, redactor: Redactor, clock: () => number): Auditor {
  const insert = db.prepare(
    "INSERT INTO audit_logs (at, actor_type, actor_id, action, code, target, detail_json, reauth) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  return {
    write(entry) {
      const detail = entry.detail == null ? null : JSON.stringify(redactor.redactValue(entry.detail));
      const target = entry.target == null ? null : redactor.redactText(entry.target);
      const result = insert.run(clock(), entry.actorType, entry.actorId ?? null, entry.action, entry.code ?? null, target, detail, entry.reauth ? 1 : 0);
      return Number(result.lastInsertRowid);
    },
  };
}
