/**
 * 告警（data-model「alerts」）：同一件事（kind + subject）只有一条未解决的告警，重复发生只加计数。
 * message 写入前按密钥形态打码。
 */
import type { Redactor } from "../log/redact.js";
import type { Db } from "./database.js";

export type AlertSeverity = "info" | "warning" | "critical";

export interface AlertInput {
  readonly kind: string;
  readonly severity: AlertSeverity;
  /** 对象，例如 backup/<id>。 */
  readonly subject: string;
  readonly message: string;
}

export interface OpenAlert {
  readonly id: number;
  readonly kind: string;
  readonly severity: AlertSeverity;
  readonly subject: string;
  readonly message: string;
  readonly count: number;
  readonly first_at: number;
  readonly last_at: number;
}

export interface Alerts {
  /** 提出或累加一条告警，返回它的 id。 */
  raise(input: AlertInput): number;
  /** 把某类未解决的告警标为已解决（subject 省略时解决这一类的全部），返回解决的条数。 */
  resolve(kind: string, subject?: string): number;
  open(kind?: string): OpenAlert[];
}

export function createAlerts(db: Db, redactor: Redactor, clock: () => number): Alerts {
  const bump = db.prepare(
    "UPDATE alerts SET severity = ?, message = ?, last_at = ?, count = count + 1 WHERE kind = ? AND subject = ? AND resolved_at IS NULL",
  );
  const insert = db.prepare(
    "INSERT INTO alerts (kind, severity, subject, message, first_at, last_at, count) VALUES (?, ?, ?, ?, ?, ?, 1)",
  );
  const find = db.prepare("SELECT id FROM alerts WHERE kind = ? AND subject = ? AND resolved_at IS NULL");
  const raise = db.transaction((input: AlertInput): number => {
    const now = clock();
    const message = redactor.redactText(input.message);
    if (bump.run(input.severity, message, now, input.kind, input.subject).changes === 0) {
      insert.run(input.kind, input.severity, input.subject, message, now, now);
    }
    return (find.get(input.kind, input.subject) as { id: number }).id;
  });
  return {
    raise: input => raise(input),
    resolve(kind, subject) {
      const now = clock();
      const result =
        subject === undefined
          ? db.prepare("UPDATE alerts SET resolved_at = ? WHERE kind = ? AND resolved_at IS NULL").run(now, kind)
          : db.prepare("UPDATE alerts SET resolved_at = ? WHERE kind = ? AND subject = ? AND resolved_at IS NULL").run(now, kind, subject);
      return result.changes;
    },
    open(kind) {
      const sql = "SELECT id, kind, severity, subject, message, count, first_at, last_at FROM alerts WHERE resolved_at IS NULL";
      return (kind === undefined ? db.prepare(`${sql} ORDER BY id`).all() : db.prepare(`${sql} AND kind = ? ORDER BY id`).all(kind)) as OpenAlert[];
    },
  };
}
