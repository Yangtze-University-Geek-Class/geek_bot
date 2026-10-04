/** A-35 概览计数（OverviewResponse）：只数行，不返回任何记录内容。 */
import type { OverviewResponse } from "@geek-bot/protocol";
import type { Db } from "../db/database.js";

export function computeOverview(db: Db): OverviewResponse {
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const tasks = db.prepare("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status").all() as { status: string; n: number }[];
  const byStatus = new Map(tasks.map(row => [row.status, row.n]));
  return {
    projects: count("SELECT COUNT(*) AS n FROM projects WHERE status = 'active'"),
    demands: count("SELECT COUNT(*) AS n FROM demands"),
    machines: count("SELECT COUNT(*) AS n FROM machines WHERE status <> 'disabled'"),
    queued: byStatus.get("queued") ?? 0,
    running: byStatus.get("running") ?? 0,
    awaiting_publish: byStatus.get("awaiting_publish") ?? 0,
    failed: byStatus.get("failed") ?? 0,
    connections: count("SELECT COUNT(*) AS n FROM connections"),
  };
}
