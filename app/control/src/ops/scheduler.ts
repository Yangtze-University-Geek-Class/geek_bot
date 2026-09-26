/**
 * 每日运维任务：每天 UTC 的 GEEK_BOT_BACKUP_HOUR_UTC 点之后做一次备份（每周第一次记为 weekly），
 * 做完按保留策略清理，再对最新一份做恢复校验（data-model「备份与每日恢复校验」）。
 *
 * 判定只看库里的登记：上一次 daily/weekly 备份早于最近一个到点时刻就补做，所以 control 停机错过的那次在启动后补上。
 * 时间来自注入的时钟；定时器每 10 分钟检查一次，不阻止进程退出。
 */
import type { Logger } from "../log/logger.js";
import type { BackupService } from "./backup.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
export const CHECK_INTERVAL_MS = 10 * 60_000;

/** 不晚于 now 的最近一个到点时刻（UTC 的 hourUtc:00）。 */
export function lastSlotAt(now: number, hourUtc: number): number {
  const dayStart = now - (((now % DAY_MS) + DAY_MS) % DAY_MS);
  const today = dayStart + hourUtc * HOUR_MS;
  return now >= today ? today : today - DAY_MS;
}

/** now 所在的 ISO 周的开始（周一 00:00 UTC）。 */
export function isoWeekStart(now: number): number {
  const dayStart = now - (((now % DAY_MS) + DAY_MS) % DAY_MS);
  const weekday = (new Date(dayStart).getUTCDay() + 6) % 7; // 周一为 0
  return dayStart - weekday * DAY_MS;
}

export interface DailyJobsOptions {
  readonly backups: BackupService;
  readonly clock: () => number;
  readonly hourUtc: number;
  readonly logger: Logger;
  readonly intervalMs?: number;
}

export interface DailyJobs {
  /** 检查一次，到点就备份并校验；返回这次做了什么。 */
  tick(): Promise<"skipped" | "done" | "failed">;
  start(): void;
  stop(): void;
  /** 等正在跑的一次检查结束。 */
  idle(): Promise<void>;
}

export function createDailyJobs(options: DailyJobsOptions): DailyJobs {
  const { backups, clock, hourUtc, logger, intervalMs = CHECK_INTERVAL_MS } = options;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<"skipped" | "done" | "failed"> | null = null;
  let stopped = false;

  async function run(): Promise<"skipped" | "done" | "failed"> {
    const now = clock();
    const slot = lastSlotAt(now, hourUtc);
    const last = backups.list().find(row => row.kind === "daily" || row.kind === "weekly");
    if (last && last.created_at >= slot) return "skipped";
    const weekStart = isoWeekStart(now);
    const hasWeekly = backups.list().some(row => row.kind === "weekly" && row.created_at >= weekStart);
    const actor = { type: "system" as const };
    try {
      const record = await backups.create(hasWeekly ? "daily" : "weekly", actor);
      const report = await backups.verify(record.file, actor);
      return report.ok ? "done" : "failed";
    } catch (error) {
      logger.error({ err: error }, "每日备份没有完成，下一次检查时重试");
      return "failed";
    }
  }

  function tick(): Promise<"skipped" | "done" | "failed"> {
    if (stopped) return Promise.resolve("skipped");
    if (running) return running;
    running = run().finally(() => {
      running = null;
    });
    return running;
  }

  return {
    tick,
    start() {
      if (timer || stopped) return;
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref();
      void tick();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
    idle: async () => {
      if (running) await running;
    },
  };
}
