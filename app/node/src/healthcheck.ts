/**
 * 容器 HEALTHCHECK：读节点写的 status.json，最近一次成功心跳在 (3 × 心跳间隔 + 30) 秒以内、且没有因 401 停机时健康。
 * 节点不开任何端口，所以不能像 control 那样请求 /readyz。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

function healthy(): boolean {
  const dataDir = process.env.GEEK_BOT_NODE_DATA_DIR?.trim() || "/var/lib/geek-bot";
  let status: unknown;
  try {
    status = JSON.parse(readFileSync(join(dataDir, "status.json"), "utf8"));
  } catch {
    return false;
  }
  if (typeof status !== "object" || status === null) return false;
  if ("halted" in status && status.halted === true) return false;
  const interval = "heartbeat_interval_s" in status && typeof status.heartbeat_interval_s === "number" ? status.heartbeat_interval_s : 10;
  const last = "last_heartbeat_ok_at" in status && typeof status.last_heartbeat_ok_at === "string" ? Date.parse(status.last_heartbeat_ok_at) : Number.NaN;
  return Number.isFinite(last) && Date.now() - last < (interval * 3 + 30) * 1000;
}

process.exit(healthy() ? 0 : 1);
