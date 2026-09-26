/**
 * 每日运维任务：每天 UTC 的 GEEK_BOT_BACKUP_HOUR_UTC 点之后做一次备份（每周第一次记为 weekly；每周备份保留 0 份时
 * 一律记为 daily），做完按保留策略清理，再对这一份做恢复校验（data-model「备份与每日恢复校验」）。
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
  /** 每周备份保留几份（GEEK_BOT_BACKUP_KEEP_WEEKLY）；为 0 时不做每周备份。 */
  readonly keepWeekly: number;
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
  const { backups, clock, hourUtc, keepWeekly, logger, intervalMs = CHECK_INTERVAL_MS } = options;
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
    // 每周保留 0 份时记成 weekly 会在 create 里当场被清理，当天就没有可用的备份。
    const kind = hasWeekly || keepWeekly === 0 ? "daily" : "weekly";
    const actor = { type: "system" as const };
    try {
      const record = await backups.create(kind, actor);
      // create 返回的是清理之后的登记：刚做的这份已被保留策略删掉时不做校验，记一条错误（按上面的判定当天不再重做）。
      if (record.pruned_at !== null) {
        logger.error({ backup_id: record.id, file: record.file, kind }, "刚做完的备份已按保留策略删除，没有做恢复校验：核对备份保留份数的配置");
        return "failed";
      }
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
