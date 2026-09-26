/**
 * control 进程的启动与停机（在接受任何请求之前做完全部检查）：
 *
 * 1. 读配置（产品默认值 + 部署配置），不合法就拒绝启动；
 * 2. 读 master key 与备份加密密钥（只从 *_FILE），读不到或格式不对就拒绝启动，报错不含密钥内容；
 * 3. 以独占方式打开库（ADR-0003）；
 * 4. 迁移检查（ADR-0008）：兼容版本高于代码拒绝启动；有待执行的迁移先做一次 pre_migration 备份再逐个执行；
 * 5. 清理备份目录里崩溃留下的临时文件，补登记没登记的备份文件；
 * 6. 组装 Fastify（/healthz、/readyz），listen 之后再开运维本地通道和每日备份任务。
 *
 * 停机（SIGTERM、SIGINT）：不再接新请求 → 等进行中的请求、备份做完 → WAL checkpoint(TRUNCATE) → 关库。
 */
import { accessSync, constants } from "node:fs";
import { buildApp, type ControlApp } from "./app.js";
import { ControlConfigError, loadControlConfig, type Env, type LoadedConfig } from "./config.js";
import { createAlerts } from "./db/alerts.js";
import { createAuditor } from "./db/audit.js";
import { checkpointAndClose, DatabaseOpenError, openDatabase, type Db } from "./db/database.js";
import { applyMigrations, loadMigrations, MigrationError, planMigrations, readSchemaState, type SchemaState } from "./db/migrator.js";
import { createLogger, stdoutSink, type LogSink, type Logger } from "./log/logger.js";
import { createRedactor, type Redactor } from "./log/redact.js";
import { createBackupService, OTHER_BACKUPS_KEPT, type BackupRecord, type BackupService, type RetentionPolicy } from "./ops/backup.js";
import { ChannelError, createOpsChannel, type OpsChannel } from "./ops/channel.js";
import { createDailyJobs, type DailyJobs } from "./ops/scheduler.js";
import type { ReadinessCheck } from "./routes/health/contracts.js";
import { KeyFileError, keyFileReadable, keyFingerprint, loadKeyFile, type LoadedKey } from "./secrets/key-files.js";

/** control 拒绝启动；problems 是逐条的中文原因（不含密钥内容）。 */
export class ControlStartupError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`control 拒绝启动：${problems.join("；")}`);
    this.name = "ControlStartupError";
    this.problems = Object.freeze([...problems]);
  }
}

export interface StartOptions {
  readonly env: Env;
  /** 解析相对路径的目录，默认当前工作目录。 */
  readonly cwd?: string;
  /** 时间来源（毫秒），测试注入假时钟。 */
  readonly clock?: () => number;
  /** 日志输出，默认标准输出。 */
  readonly sink?: LogSink;
  /** 迁移目录，默认代码自带的 src/db/migrations（测试用来模拟上一版、下一版代码）。 */
  readonly migrationsDir?: string;
  /** listen 之后是否开每日备份任务，默认开。 */
  readonly dailyJobs?: boolean;
  /** listen 之后是否开运维本地通道，默认开。 */
  readonly opsChannel?: boolean;
  /** 覆盖监听端口（测试用 0 取随机端口）；部署时端口只来自 GEEK_BOT_PORT。 */
  readonly port?: number;
}

export interface MigrationSummary {
  /** 启动前的库状态。 */
  readonly before: SchemaState;
  /** 这次执行了的迁移文件名。 */
  readonly applied: readonly string[];
  /** 迁移前备份的文件名；没有待执行的迁移、或者是空库时为 null。 */
  readonly preMigrationBackup: string | null;
  /** 库比代码新（回滚到上一版镜像）。 */
  readonly databaseNewer: boolean;
}

export interface CheckpointResult {
  readonly busy: number;
  readonly log: number;
  readonly checkpointed: number;
}

export interface ControlHandle {
  readonly app: ControlApp;
  readonly db: Db;
  readonly config: LoadedConfig;
  readonly logger: Logger;
  readonly redactor: Redactor;
  readonly backups: BackupService;
  readonly jobs: DailyJobs;
  readonly migrations: MigrationSummary;
  /** 代码认识的最高迁移编号 C。 */
  readonly codeVersion: number;
  /** 监听端口，返回地址；随后开运维本地通道与每日任务。 */
  listen(): Promise<string>;
  /** 优雅停机；重复调用返回同一个结果。 */
  shutdown(reason: string): Promise<CheckpointResult>;
}

function loadKeys(config: LoadedConfig, redactor: Redactor): { master: LoadedKey; backup: LoadedKey } {
  const problems: string[] = [];
  const read = (envName: string, path: string): LoadedKey | null => {
    try {
      return loadKeyFile({ envName, path }, redactor);
    } catch (error) {
      if (error instanceof KeyFileError) problems.push(error.problem);
      else throw error;
      return null;
    }
  };
  const master = read("GEEK_BOT_MASTER_KEY_FILE", config.deployment.masterKeyFile);
  const backup = read("GEEK_BOT_BACKUP_KEY_FILE", config.deployment.backupKeyFile);
  if (master && backup && master.key.equals(backup.key)) problems.push("master key 与备份加密密钥是同一把密钥：两者必须各自独立生成");
  if (problems.length > 0 || !master || !backup) throw new ControlStartupError(problems);
  return { master, backup };
}

function retentionOf(config: LoadedConfig): RetentionPolicy {
  return { daily: config.behavior.backupKeepDaily, weekly: config.behavior.backupKeepWeekly, others: OTHER_BACKUPS_KEPT };
}

/** 启动：做完全部检查与迁移，返回句柄；不监听端口。失败时记一条 fatal 日志并抛 ControlStartupError。 */
export async function startControl(options: StartOptions): Promise<ControlHandle> {
  const clock = options.clock ?? Date.now;
  const sink = options.sink ?? stdoutSink;
  const redactor = createRedactor();
  const bootLogger = createLogger({ level: "info", redactor, sink, clock });
  const fail = (problems: readonly string[]): never => {
    const error = new ControlStartupError(problems);
    bootLogger.fatal({ problems: error.problems }, error.message);
    throw error;
  };

  let config: LoadedConfig;
  try {
    config = loadControlConfig(options.env, options.cwd);
  } catch (error) {
    if (error instanceof ControlConfigError) return fail(error.problems);
    throw error;
  }
  const logger = createLogger({ level: config.deployment.logLevel, redactor, sink, clock });

  let keys: { master: LoadedKey; backup: LoadedKey };
  try {
    keys = loadKeys(config, redactor);
  } catch (error) {
    if (error instanceof ControlStartupError) return fail(error.problems);
    throw error;
  }
  for (const key of [keys.master, keys.backup]) if (key.warning) logger.warn(key.warning);

  const { deployment } = config;
  let db: Db;
  try {
    db = openDatabase(deployment.dbPath);
  } catch (error) {
    if (error instanceof DatabaseOpenError) return fail([error.message]);
    throw error;
  }

  const backupKeyId = keyFingerprint(keys.backup.key, "backup-key");
  const serviceFor = () =>
    createBackupService({
      db,
      backupDir: deployment.backupDir,
      backupKey: keys.backup.key,
      backupKeyId,
      clock,
      appVersion: deployment.appVersion,
      retention: retentionOf(config),
      auditor: createAuditor(db, redactor, clock),
      alerts: createAlerts(db, redactor, clock),
      logger,
    });

  try {
    let migrations;
    let plan;
    try {
      migrations = loadMigrations(options.migrationsDir);
      plan = planMigrations(db, migrations);
    } catch (error) {
      if (error instanceof MigrationError) return fail([error.message]);
      throw error;
    }
    const codeVersion = migrations.length;
    const before = plan.state;

    let preMigrationBackup: BackupRecord | null = null;
    if (plan.pending.length > 0 && before.userVersion >= 1) {
      try {
        preMigrationBackup = await serviceFor().create("pre_migration", { type: "system" });
      } catch (error) {
        return fail([`迁移前备份失败，没有执行迁移：${(error as Error).message}`]);
      }
    }
    const applied: string[] = [];
    try {
      applyMigrations(db, plan.pending, {
        clock,
        appVersion: deployment.appVersion,
        onApplied: (migration, compatVersion) => {
          applied.push(migration.name);
          logger.info({ migration: migration.name, shrink: migration.shrink, compat_version: compatVersion }, "迁移完成");
        },
      });
    } catch (error) {
      if (error instanceof MigrationError) return fail([error.message]);
      throw error;
    }

    const auditor = createAuditor(db, redactor, clock);
    for (const name of applied) {
      auditor.write({ actorType: "system", action: "migration.apply", target: `migration/${name.slice(0, 4)}`, detail: { name, app_version: deployment.appVersion } });
    }
    if (plan.databaseNewer) {
      logger.warn(
        { user_version: before.userVersion, compat_version: before.compatVersion, code_version: codeVersion },
        "库执行过的迁移比这版代码新，兼容版本不高于代码：按回滚到上一版镜像处理，正常启动，不执行迁移",
      );
    }

    const backups = serviceFor();
    await backups.reconcile();

    let shuttingDown = false;
    let shutdownPromise: Promise<CheckpointResult> | null = null;
    let channel: OpsChannel | null = null;

    const databaseWritable = (): boolean => {
      try {
        if (!db.open || db.readonly) return false;
        if (!db.inTransaction) db.exec("BEGIN IMMEDIATE; ROLLBACK;");
        accessSync(deployment.dbPath, constants.W_OK);
        accessSync(deployment.dataDir, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    };

    const readiness = {
      failedChecks(): ReadinessCheck[] {
        const failed: ReadinessCheck[] = [];
        if (!databaseWritable()) failed.push("database_writable");
        let state: SchemaState | null = null;
        try {
          if (db.open) state = readSchemaState(db, codeVersion);
        } catch {
          state = null;
        }
        if (!state || state.compatVersion > codeVersion) failed.push("schema_compatible");
        if (!state || state.userVersion < codeVersion) failed.push("migrations_applied");
        if (!keyFileReadable(deployment.masterKeyFile) || !keyFileReadable(deployment.backupKeyFile)) failed.push("secrets_readable");
        if (shuttingDown) failed.push("serving");
        return failed;
      },
    };

    const app = buildApp({ logger, readiness, shuttingDown: () => shuttingDown });
    const jobs = createDailyJobs({ backups, clock, hourUtc: config.behavior.backupHourUtc, logger });

    const handle: ControlHandle = {
      app,
      db,
      config,
      logger,
      redactor,
      backups,
      jobs,
      codeVersion,
      migrations: Object.freeze({ before, applied, preMigrationBackup: preMigrationBackup?.file ?? null, databaseNewer: plan.databaseNewer }),
      async listen() {
        const address = await app.listen({ host: deployment.host, port: options.port ?? deployment.port });
        if (options.opsChannel !== false) {
          channel = createOpsChannel(
            deployment.runDir,
            {
              "/v1/backup": async body => {
                const extra = Object.keys(body).filter(key => key !== "kind");
                if (extra.length > 0) throw new ChannelError(400, "validation_failed", `不认识的字段：${extra.join("、")}`);
                const kind = body.kind ?? "manual";
                if (kind !== "manual" && kind !== "pre_deploy") throw new ChannelError(400, "validation_failed", "kind 只能是 manual 或 pre_deploy");
                return { backup: await backups.create(kind, { type: "cli" }) };
              },
              "/v1/verify-backup": async body => {
                const extra = Object.keys(body).filter(key => key !== "file");
                if (extra.length > 0) throw new ChannelError(400, "validation_failed", `不认识的字段：${extra.join("、")}`);
                const file = body.file;
                if (file !== undefined && (typeof file !== "string" || !/^[A-Za-z0-9._-]{1,200}$/.test(file) || file.startsWith("."))) {
                  throw new ChannelError(400, "validation_failed", "file 只能是 backups 目录里的文件名");
                }
                return { report: await backups.verify(file, { type: "cli" }) };
              },
            },
            logger,
          );
          await channel.listen();
        }
        if (options.dailyJobs !== false) jobs.start();
        logger.info(
          { address, instance_role: deployment.instanceRole, app_version: deployment.appVersion, user_version: readSchemaState(db, codeVersion).userVersion, code_version: codeVersion },
          "control 已启动",
        );
        return address;
      },
      shutdown(reason) {
        if (shutdownPromise) return shutdownPromise;
        shuttingDown = true;
        shutdownPromise = (async () => {
          logger.info({ reason }, "开始停机：不再接新请求，等进行中的请求和备份做完");
          jobs.stop();
          await app.close();
          await channel?.close();
          await jobs.idle();
          await backups.idle();
          const result = checkpointAndClose(db);
          logger.info({ ...result }, "WAL 已 checkpoint，库已关闭");
          return result;
        })();
        return shutdownPromise;
      },
    };
    return handle;
  } catch (error) {
    if (db.open) db.close();
    throw error;
  }
}

/** 进程信号：SIGTERM、SIGINT 触发优雅停机，做完后以 0 退出；停机出错以 1 退出。 */
export function installSignalHandlers(
  target: { once(event: "SIGTERM" | "SIGINT", listener: () => void): unknown },
  handle: Pick<ControlHandle, "shutdown" | "logger">,
  exit: (code: number) => void,
): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    target.once(signal, () => {
      handle.shutdown(signal).then(
        () => exit(0),
        error => {
          handle.logger.fatal({ err: error }, "停机出错");
          exit(1);
        },
      );
    });
  }
}
