/**
 * control 的运维命令（镜像里是 `geek-bot <命令>`，例如 `docker compose exec control geek-bot backup`）。
 *
 *   backup [--kind manual|pre_deploy]   做一次加密备份
 *   verify-backup [<文件名>]            恢复校验一份备份（默认最新一份），结果写进 backups，失败写告警
 *   restore --dry-run <文件>            只做恢复校验并报告会恢复到哪个库版本和时间点，不改任何文件
 *
 * 单写者（ADR-0003）：backup、verify-backup 会写库，control 在运行时经本地通道（src/ops/channel.ts）交给它做，
 * CLI 自己不开写连接；control 没在运行时，CLI 以独占方式打开库自己做（拿不到锁就失败）。
 * restore --dry-run 不碰库，只读备份文件和备份加密密钥。正式恢复（覆盖库文件）不在 #3，没有实现。
 * 退出码：0 成功；1 失败；2 用法错误。
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ControlConfigError, loadControlConfig, type Env, type LoadedConfig } from "./config.js";
import { createAlerts } from "./db/alerts.js";
import { createAuditor } from "./db/audit.js";
import { checkpointAndClose, DatabaseOpenError, openDatabase } from "./db/database.js";
import { loadMigrations } from "./db/migrator.js";
import { createLogger, type LogSink } from "./log/logger.js";
import { createRedactor, type Redactor } from "./log/redact.js";
import { checkBackupFile, createBackupService, OTHER_BACKUPS_KEPT, type BackupRecord, type FileCheck, type VerifyReport } from "./ops/backup.js";
import { callOpsChannel, ChannelUnavailableError } from "./ops/channel.js";
import { KeyFileError, keyFingerprint, loadKeyFile, type LoadedKey } from "./secrets/key-files.js";

export interface CliIo {
  readonly env: Env;
  readonly cwd?: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly clock?: () => number;
  /** 迁移目录（测试用）。 */
  readonly migrationsDir?: string;
}

export const USAGE = [
  "用法：geek-bot <命令>",
  "  backup [--kind manual|pre_deploy]   做一次加密备份（control 在运行时交给它做；没在运行时独占打开库自己做）",
  "  verify-backup [<文件名>]            恢复校验一份备份（默认最新一份），结果写进 backups，失败写告警",
  "  restore --dry-run <文件>            只做恢复校验，报告会恢复到哪个库版本和时间点，不改任何文件",
  "  help                                显示本说明",
].join("\n");

class UsageError extends Error {}
class CliFailure extends Error {}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function describeBackup(record: BackupRecord): string[] {
  return [
    `  文件 ${record.file}`,
    `  种类 ${record.kind} · 时间 ${iso(record.created_at)} · 大小 ${record.bytes} 字节`,
    `  库版本（user_version）${record.schema_version} · 兼容版本 ${record.compat_version} · 镜像版本 ${record.app_version}`,
    `  sha256 ${record.sha256}`,
  ];
}

function describeCheck(check: FileCheck): string[] {
  const lines: string[] = [];
  if (check.sha256) lines.push(`  sha256 ${check.sha256}`);
  if (check.header) lines.push(`  种类 ${check.header.kind} · 备份时间 ${iso(check.header.created_at)} · 镜像版本 ${check.header.app_version}`);
  if (check.restored) {
    const tables = Object.entries(check.restored.rowCounts).map(([table, n]) => `${table}=${n}`).join(" ");
    lines.push(`  恢复出的库：user_version ${check.restored.schemaVersion} · 兼容版本 ${check.restored.compatVersion}`);
    lines.push(`  各表行数：${tables}`);
  }
  for (const problem of check.problems) lines.push(`  问题：${problem}`);
  return lines;
}

function loadConfig(io: CliIo): LoadedConfig {
  try {
    return loadControlConfig(io.env, io.cwd);
  } catch (error) {
    if (error instanceof ControlConfigError) throw new CliFailure(error.message);
    throw error;
  }
}

function loadBackupKey(config: LoadedConfig, redactor: Redactor): LoadedKey {
  try {
    return loadKeyFile({ envName: "GEEK_BOT_BACKUP_KEY_FILE", path: config.deployment.backupKeyFile }, redactor);
  } catch (error) {
    if (error instanceof KeyFileError) throw new CliFailure(error.problem);
    throw error;
  }
}

/** control 没在运行时：以独占方式打开库，在本进程里执行，做完 checkpoint 并关库。 */
async function offline<T>(io: CliIo, config: LoadedConfig, redactor: Redactor, run: (service: ReturnType<typeof createBackupService>) => Promise<T>): Promise<T> {
  const clock = io.clock ?? Date.now;
  const key = loadBackupKey(config, redactor);
  let db;
  try {
    db = openDatabase(config.deployment.dbPath, { mustExist: true, busyTimeoutMs: 1000 });
  } catch (error) {
    if (error instanceof DatabaseOpenError) throw new CliFailure(error.message);
    throw error;
  }
  try {
    const hasBackups = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'backups'").get() !== undefined;
    if (!hasBackups) throw new CliFailure("库还没有初始化（没有 backups 表）：先启动一次 control 完成迁移");
    const logger = createLogger({ level: config.deployment.logLevel, redactor, clock, sink: { write: line => io.stderr(line) } });
    const service = createBackupService({
      db,
      backupDir: config.deployment.backupDir,
      backupKey: key.key,
      backupKeyId: keyFingerprint(key.key, "backup-key"),
      clock,
      appVersion: config.deployment.appVersion,
      retention: { daily: config.behavior.backupKeepDaily, weekly: config.behavior.backupKeepWeekly, others: OTHER_BACKUPS_KEPT },
      auditor: createAuditor(db, redactor, clock),
      alerts: createAlerts(db, redactor, clock),
      logger,
    });
    return await run(service);
  } finally {
    checkpointAndClose(db);
  }
}

/** 先交给运行中的 control；连不上就离线执行。 */
async function viaControl<T>(io: CliIo, config: LoadedConfig, redactor: Redactor, route: string, body: Record<string, unknown>, pick: (reply: Record<string, unknown>) => T, local: (service: ReturnType<typeof createBackupService>) => Promise<T>): Promise<T> {
  try {
    const reply = await callOpsChannel(config.deployment.runDir, route, body);
    const payload = reply.body as Record<string, unknown> & { error?: { message?: string } };
    if (reply.status !== 200) throw new CliFailure(`control 拒绝执行：${payload.error?.message ?? `HTTP ${reply.status}`}`);
    return pick(payload);
  } catch (error) {
    if (!(error instanceof ChannelUnavailableError)) throw error;
    io.stderr(`control 没有在运行（${error.path} 连不上），改为独占打开库在本进程里执行\n`);
    return offline(io, config, redactor, local);
  }
}

async function commandBackup(args: string[], io: CliIo, redactor: Redactor): Promise<number> {
  const { values, positionals } = parseArgs({ args, options: { kind: { type: "string" } }, allowPositionals: true, strict: true });
  if (positionals.length > 0) throw new UsageError(`backup 不接受参数：${positionals.join(" ")}`);
  const kind = values.kind ?? "manual";
  if (kind !== "manual" && kind !== "pre_deploy") throw new UsageError("--kind 只能是 manual 或 pre_deploy");
  const config = loadConfig(io);
  const record = await viaControl(
    io,
    config,
    redactor,
    "/v1/backup",
    { kind },
    reply => reply.backup as BackupRecord,
    service => service.create(kind, { type: "cli" }),
  );
  io.stdout(["备份完成", ...describeBackup(record)].join("\n") + "\n");
  return 0;
}

async function commandVerify(args: string[], io: CliIo, redactor: Redactor): Promise<number> {
  const { positionals } = parseArgs({ args, options: {}, allowPositionals: true, strict: true });
  if (positionals.length > 1) throw new UsageError("verify-backup 最多接受一个文件名");
  const file = positionals[0];
  if (file !== undefined && (file.includes("/") || file.startsWith("."))) throw new UsageError("verify-backup 只接受 backups 目录里的文件名，不接受路径");
  const config = loadConfig(io);
  const report = await viaControl(
    io,
    config,
    redactor,
    "/v1/verify-backup",
    file === undefined ? {} : { file },
    reply => reply.report as VerifyReport,
    service => service.verify(file, { type: "cli" }),
  );
  io.stdout([report.ok ? `恢复校验通过：${report.file}` : `恢复校验失败：${report.file || "（没有备份）"}`, ...describeCheck(report)].join("\n") + "\n");
  return report.ok ? 0 : 1;
}

async function commandRestore(args: string[], io: CliIo, redactor: Redactor): Promise<number> {
  const { values, positionals } = parseArgs({ args, options: { "dry-run": { type: "boolean" } }, allowPositionals: true, strict: true });
  if (!values["dry-run"]) {
    throw new UsageError("restore 目前只支持 --dry-run：正式恢复（覆盖库文件）要求 control 停止并由获授权的人执行，还没有实现（恢复演练随 #20）");
  }
  if (positionals.length !== 1) throw new UsageError("restore --dry-run 需要一个备份文件");
  const config = loadConfig(io);
  const key = loadBackupKey(config, redactor);
  const cwd = io.cwd ?? process.cwd();
  const given = positionals[0] as string;
  const path = given.includes("/") ? (isAbsolute(given) ? given : resolve(cwd, given)) : join(config.deployment.backupDir, given);
  const codeVersion = loadMigrations(io.migrationsDir).length;
  const work = mkdtempSync(join(tmpdir(), "geek-bot-restore-"));
  let check: FileCheck;
  try {
    check = await checkBackupFile(path, key.key, keyFingerprint(key.key, "backup-key"), work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const lines = [check.ok ? `恢复演练（--dry-run）通过：${path}` : `恢复演练（--dry-run）失败：${path}`, ...describeCheck(check)];
  if (check.restored && check.header) {
    const { schemaVersion: d, compatVersion: k } = check.restored;
    lines.push(`  会恢复到：${iso(check.header.created_at)} 的库，user_version ${d}，兼容版本 ${k}；这版代码认识到第 ${codeVersion} 号迁移`);
    if (k > codeVersion) lines.push("  这版代码打不开恢复后的库：兼容版本高于代码，要换更新的镜像");
    else if (d < codeVersion) lines.push(`  恢复后启动时会先做迁移前备份，再执行第 ${d + 1} 到 ${codeVersion} 号迁移`);
    else if (d > codeVersion) lines.push("  恢复后的库比这版代码新、兼容版本不高于代码：可以直接启动（回滚情形）");
    else lines.push("  库版本与这版代码一致：可以直接启动");
  }
  lines.push("  没有改动任何文件");
  io.stdout(lines.join("\n") + "\n");
  return check.ok ? 0 : 1;
}

/** 运行一条命令，返回退出码。 */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const redactor = createRedactor();
  const [command, ...args] = argv;
  try {
    switch (command) {
      case "backup":
        return await commandBackup(args, io, redactor);
      case "verify-backup":
        return await commandVerify(args, io, redactor);
      case "restore":
        return await commandRestore(args, io, redactor);
      case "help":
      case "--help":
      case "-h":
        io.stdout(`${USAGE}\n`);
        return 0;
      default:
        throw new UsageError(command === undefined ? "缺少命令" : `不认识的命令：${command}`);
    }
  } catch (error) {
    if (error instanceof UsageError || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      io.stderr(`${redactor.redactText((error as Error).message)}\n${USAGE}\n`);
      return 2;
    }
    io.stderr(`${redactor.redactText(error instanceof CliFailure ? error.message : `执行失败：${(error as Error).message}`)}\n`);
    return 1;
  }
}

/** 是否被直接运行（按真实路径比较，经符号链接启动也算）；被测试导入时为 false。 */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  void runCli(process.argv.slice(2), {
    env: process.env,
    stdout: text => void process.stdout.write(text),
    stderr: text => void process.stderr.write(text),
  }).then(code => {
    process.exitCode = code;
  });
}
