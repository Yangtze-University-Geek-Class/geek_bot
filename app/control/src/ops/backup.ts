/**
 * 备份、恢复校验与保留策略（ADR-0008，data-model「备份与每日恢复校验」，SECURITY S-17）。
 *
 * 备份：better-sqlite3 在线 backup 复制到临时明文 → 在副本上统计各表行数、读库版本 → 用备份加密密钥流式加密并算 sha256
 * → 改名进 backups/ → 写一行 backups → 删临时明文 → 按保留策略清理。
 * 恢复校验：核对 sha256 → 解密到临时文件（认证标签不对即失败）→ integrity_check、foreign_key_check → user_version 等于
 * schema_migrations 的最大编号 → 各表行数与登记一致 → 删临时文件。失败写 critical 告警。
 * 明文临时文件只放在 <dataDir>/tmp（0700，启动时清空，文件 0600）：不放 backups/（#20 会给它做异地副本），也不放系统 /tmp。
 * backups/ 里只有加密后的文件，写到一半的密文以 .tmp- 开头，改名后才算数。
 * 同一时刻只做一件事：备份、校验、清理排队执行。
 */
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, rmSync, statSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Alerts } from "../db/alerts.js";
import type { AuditActorType, Auditor } from "../db/audit.js";
import { countRows, openCopy, type Db } from "../db/database.js";
import { readSchemaState } from "../db/migrator.js";
import type { Logger } from "../log/logger.js";
import { BACKUP_EXTENSION, BACKUP_KINDS, BackupFileError, decryptBackup, encryptBackup, readBackupHeader, sha256File, type BackupHeader, type BackupKind } from "./backup-file.js";

/** 临时文件前缀：崩溃后留下的临时文件在下次启动时清掉。 */
const TEMP_PREFIX = ".tmp-";

export interface BackupRecord {
  readonly id: number;
  readonly kind: BackupKind;
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly schema_version: number;
  readonly compat_version: number;
  readonly app_version: string;
  readonly backup_key_id: string;
  readonly row_counts_json: string;
  readonly created_at: number;
  readonly verified_at: number | null;
  readonly verify_result: "ok" | "failed" | null;
  readonly verify_detail: string | null;
  readonly pruned_at: number | null;
}

export interface RetentionPolicy {
  readonly daily: number;
  readonly weekly: number;
  /** pre_deploy、pre_migration、manual 各保留几份。 */
  readonly others: number;
}

/** pre_deploy、pre_migration、manual 各保留最近 3 份（data-model 的推荐值）。 */
export const OTHER_BACKUPS_KEPT = 3;

/**
 * 备份服务读写的 backups 列，都是 0001 就有的。迁移前备份（pre_migration）在执行迁移之前写登记，这时库还停在旧版本，
 * 不能依赖最新的表结构；以后给 backups 加的列必须可空或带默认值，不能加进这里（tests/control 核对这些列在 0001 里都有）。
 */
export const BACKUP_COLUMNS = Object.freeze([
  "id",
  "kind",
  "file",
  "sha256",
  "bytes",
  "schema_version",
  "compat_version",
  "app_version",
  "backup_key_id",
  "row_counts_json",
  "created_at",
  "verified_at",
  "verify_result",
  "verify_detail",
  "pruned_at",
] as const);

export interface Actor {
  readonly type: AuditActorType;
  readonly id?: string | null;
}

export interface FileCheck {
  readonly ok: boolean;
  readonly problems: readonly string[];
  readonly sha256: string | null;
  readonly header: BackupHeader | null;
  /** 解密后副本的库版本与兼容版本。 */
  readonly restored: { readonly schemaVersion: number; readonly compatVersion: number; readonly rowCounts: Readonly<Record<string, number>> } | null;
}

export interface VerifyReport extends FileCheck {
  readonly file: string;
  readonly backupId: number | null;
}

function rowCountsEqual(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): string[] {
  const problems: string[] = [];
  for (const table of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[table] !== b[table]) problems.push(`表 ${table} 的行数不一致：登记 ${b[table] ?? "无"}，恢复出 ${a[table] ?? "无"}`);
  }
  return problems;
}

function tempName(dir: string, suffix: string): string {
  return join(dir, `${TEMP_PREFIX}${randomBytes(6).toString("hex")}${suffix}`);
}

async function removeCopy(path: string): Promise<void> {
  await Promise.all(["", "-journal", "-wal", "-shm"].map(suffix => rm(`${path}${suffix}`, { force: true })));
}

/** 建好明文临时目录（0700）。 */
function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * 启动时（已拿到库的独占锁）：建好 <dataDir>/tmp 并收紧到 0700，清掉上次崩溃留下的明文临时文件；返回清掉的条目数。
 */
export function resetTempDir(dir: string): number {
  ensurePrivateDir(dir);
  chmodSync(dir, 0o700);
  const names = readdirSync(dir);
  for (const name of names) rmSync(join(dir, name), { recursive: true, force: true });
  return names.length;
}

/**
 * 校验一个备份文件，不依赖运行中的库：认证解密、integrity_check、foreign_key_check、user_version、各表行数。
 * expected 给了就另外核对登记的 sha256 与行数。tmpDir 放解密出的临时文件（用完删除）。
 */
export async function checkBackupFile(
  path: string,
  key: Buffer,
  keyId: string,
  tmpDir: string,
  expected: { sha256?: string; rowCounts?: Readonly<Record<string, number>> } = {},
): Promise<FileCheck> {
  const problems: string[] = [];
  let sha256: string | null = null;
  let header: BackupHeader | null = null;
  let restored: FileCheck["restored"] = null;
  try {
    sha256 = await sha256File(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, problems: [code === "ENOENT" ? "备份文件不存在" : `备份文件读不了（${code ?? "未知原因"}）`], sha256, header, restored };
  }
  if (expected.sha256 !== undefined && expected.sha256 !== sha256) problems.push("备份文件的 sha256 与登记的不一致");
  try {
    header = (await readBackupHeader(path)).header;
  } catch (error) {
    problems.push((error as Error).message);
    return { ok: false, problems, sha256, header, restored };
  }
  if (header.backup_key_id !== keyId) {
    problems.push(`这份备份是用另一把备份密钥加密的（密钥指纹 ${header.backup_key_id}，当前密钥是 ${keyId}）`);
    return { ok: false, problems, sha256, header, restored };
  }
  ensurePrivateDir(tmpDir);
  const plain = tempName(tmpDir, ".sqlite");
  try {
    await decryptBackup(path, key, plain);
    const copy = openCopy(plain);
    try {
      const integrity = copy.pragma("integrity_check") as Array<{ integrity_check: string }>;
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") problems.push(`integrity_check 不通过：${integrity.map(row => row.integrity_check).slice(0, 5).join("；")}`);
      const foreign = copy.pragma("foreign_key_check") as unknown[];
      if (foreign.length > 0) problems.push(`foreign_key_check 发现 ${foreign.length} 处外键不一致`);
      const state = readSchemaState(copy, 0);
      const top = (copy.prepare("SELECT max(version) AS v FROM schema_migrations").get() as { v: number | null } | undefined)?.v ?? 0;
      if (state.userVersion !== top) problems.push(`user_version 是 ${state.userVersion}，schema_migrations 的最大编号却是 ${top}`);
      if (header.schema_version !== state.userVersion) problems.push(`头部记录的库版本是 ${header.schema_version}，恢复出的库是 ${state.userVersion}`);
      const rowCounts = countRows(copy);
      problems.push(...rowCountsEqual(rowCounts, header.row_counts));
      if (expected.rowCounts) {
        for (const problem of rowCountsEqual(rowCounts, expected.rowCounts)) if (!problems.includes(problem)) problems.push(problem);
      }
      restored = { schemaVersion: state.userVersion, compatVersion: state.compatVersion, rowCounts };
    } finally {
      copy.close();
    }
  } catch (error) {
    problems.push(error instanceof BackupFileError ? error.message : `恢复校验出错：${(error as Error).message}`);
  } finally {
    await removeCopy(plain);
  }
  return { ok: problems.length === 0, problems, sha256, header, restored };
}

export interface BackupServiceOptions {
  readonly db: Db;
  readonly backupDir: string;
  /** 明文临时文件的目录（<dataDir>/tmp）。 */
  readonly tmpDir: string;
  readonly backupKey: Buffer;
  readonly backupKeyId: string;
  readonly clock: () => number;
  readonly appVersion: string;
  readonly retention: RetentionPolicy;
  readonly auditor: Auditor;
  readonly alerts: Alerts;
  readonly logger: Logger;
}

export interface BackupService {
  create(kind: BackupKind, actor: Actor): Promise<BackupRecord>;
  /** 恢复校验并把结果写进 backups；file 省略时校验最新一份没被清理的备份。 */
  verify(file: string | undefined, actor: Actor): Promise<VerifyReport>;
  /** 按保留策略删除多余的备份文件，返回删掉的文件名。 */
  prune(actor: Actor): Promise<string[]>;
  /** 启动时：清掉崩溃留下的临时文件，给 backups/ 里没有登记的备份文件补登记，返回补登记的文件名。 */
  reconcile(): Promise<string[]>;
  list(): BackupRecord[];
  latest(kinds?: readonly BackupKind[]): BackupRecord | null;
  /** 等排队中的备份任务全部做完（停机时用）。 */
  idle(): Promise<void>;
}

/** 文件名里的时间：20260926T033000Z。 */
function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function createBackupService(options: BackupServiceOptions): BackupService {
  const { db, backupDir, tmpDir, backupKey, backupKeyId, clock, appVersion, retention, auditor, alerts, logger } = options;
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.catch(() => undefined);
    return run;
  };

  const selectColumns = BACKUP_COLUMNS.join(", ");
  const byFile = db.prepare(`SELECT ${selectColumns} FROM backups WHERE file = ?`);
  const insert = db.prepare(
    "INSERT INTO backups (kind, file, sha256, bytes, schema_version, compat_version, app_version, backup_key_id, row_counts_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );

  const ensureDir = () => mkdirSync(backupDir, { recursive: true, mode: 0o700 });

  async function pruneNow(actor: Actor): Promise<string[]> {
    const removed: string[] = [];
    for (const kind of BACKUP_KINDS) {
      const keep = kind === "daily" ? retention.daily : kind === "weekly" ? retention.weekly : retention.others;
      const rows = db.prepare("SELECT id, file FROM backups WHERE kind = ? AND pruned_at IS NULL ORDER BY created_at DESC, id DESC").all(kind) as Array<{ id: number; file: string }>;
      for (const row of rows.slice(keep)) {
        await rm(join(backupDir, row.file), { force: true });
        db.prepare("UPDATE backups SET pruned_at = ? WHERE id = ?").run(clock(), row.id);
        auditor.write({ actorType: actor.type, actorId: actor.id, action: "backup.prune", target: `backup/${row.id}`, detail: { kind, file: row.file } });
        removed.push(row.file);
      }
    }
    if (removed.length > 0) logger.info({ files: removed }, "按保留策略删除了多余的备份");
    return removed;
  }

  async function createNow(kind: BackupKind, actor: Actor): Promise<BackupRecord> {
    const now = clock();
    const file = `geek-bot-${kind}-${stamp(now)}-${randomBytes(3).toString("hex")}${BACKUP_EXTENSION}`;
    const plain = tempName(tmpDir, ".sqlite");
    const sealed = tempName(backupDir, BACKUP_EXTENSION);
    try {
      ensureDir();
      ensurePrivateDir(tmpDir);
      // 先以 0600 建出空文件再让 SQLite 往里写：直接交给 backup 新建时按 umask 是 0644。SQLite 的日志文件沿用它的权限。
      closeSync(openSync(plain, "wx", 0o600));
      await db.backup(plain);
      const copy = openCopy(plain);
      let rowCounts: Record<string, number>;
      let schema;
      try {
        rowCounts = countRows(copy);
        schema = readSchemaState(copy, 0);
      } finally {
        copy.close();
      }
      const { sha256, bytes } = await encryptBackup(plain, sealed, backupKey, {
        kind,
        created_at: now,
        schema_version: schema.userVersion,
        compat_version: schema.compatVersion,
        app_version: appVersion,
        backup_key_id: backupKeyId,
        row_counts: rowCounts,
      });
      await rename(sealed, join(backupDir, file));
      const result = insert.run(kind, file, sha256, bytes, schema.userVersion, schema.compatVersion, appVersion, backupKeyId, JSON.stringify(rowCounts), now);
      const id = Number(result.lastInsertRowid);
      auditor.write({ actorType: actor.type, actorId: actor.id, action: "backup.create", target: `backup/${id}`, detail: { kind, file, bytes } });
      alerts.resolve("backup_failed");
      logger.info({ backup_id: id, kind, file, bytes, schema_version: schema.userVersion }, "备份完成");
      await pruneNow(actor);
      return byFile.get(file) as BackupRecord;
    } catch (error) {
      alerts.raise({ kind: "backup_failed", severity: "critical", subject: `backup/${kind}`, message: `备份失败：${(error as Error).message}` });
      logger.error({ err: error, kind }, "备份失败");
      throw error;
    } finally {
      await removeCopy(plain);
      await rm(sealed, { force: true });
    }
  }

  function latest(kinds: readonly BackupKind[] = BACKUP_KINDS): BackupRecord | null {
    const marks = kinds.map(() => "?").join(", ");
    const row = db
      .prepare(`SELECT ${selectColumns} FROM backups WHERE pruned_at IS NULL AND kind IN (${marks}) ORDER BY created_at DESC, id DESC LIMIT 1`)
      .get(...kinds) as BackupRecord | undefined;
    return row ?? null;
  }

  async function verifyNow(file: string | undefined, actor: Actor): Promise<VerifyReport> {
    const row = (file === undefined ? latest() : (byFile.get(file) as BackupRecord | undefined)) ?? null;
    if (!row) {
      const problem = file === undefined ? "还没有可校验的备份" : `backups 里没有登记这个文件：${file}`;
      return { ok: false, problems: [problem], sha256: null, header: null, restored: null, file: file ?? "", backupId: null };
    }
    if (row.pruned_at !== null) {
      return { ok: false, problems: ["这份备份已经按保留策略删除"], sha256: null, header: null, restored: null, file: row.file, backupId: row.id };
    }
    const check = await checkBackupFile(join(backupDir, row.file), backupKey, backupKeyId, tmpDir, {
      sha256: row.sha256,
      rowCounts: JSON.parse(row.row_counts_json) as Record<string, number>,
    });
    const now = clock();
    const detail = check.ok ? "ok" : check.problems.join("；");
    db.prepare("UPDATE backups SET verified_at = ?, verify_result = ?, verify_detail = ? WHERE id = ?").run(now, check.ok ? "ok" : "failed", detail, row.id);
    auditor.write({
      actorType: actor.type,
      actorId: actor.id,
      action: "backup.verify",
      target: `backup/${row.id}`,
      detail: { file: row.file, result: check.ok ? "ok" : "failed", problems: check.problems },
    });
    if (check.ok) {
      alerts.resolve("backup_verify_failed");
      logger.info({ backup_id: row.id, file: row.file }, "恢复校验通过");
    } else {
      alerts.raise({ kind: "backup_verify_failed", severity: "critical", subject: `backup/${row.id}`, message: `最近一次恢复校验失败：${detail}` });
      logger.error({ backup_id: row.id, file: row.file, problems: check.problems }, "恢复校验失败");
    }
    return { ...check, file: row.file, backupId: row.id };
  }

  async function reconcileNow(): Promise<string[]> {
    ensureDir();
    const added: string[] = [];
    for (const name of readdirSync(backupDir)) {
      const path = join(backupDir, name);
      if (name.startsWith(TEMP_PREFIX)) {
        rmSync(path, { force: true });
        continue;
      }
      if (!name.endsWith(BACKUP_EXTENSION) || byFile.get(name) !== undefined || !statSync(path).isFile()) continue;
      try {
        const { header, size } = await readBackupHeader(path);
        const sha256 = await sha256File(path);
        const result = insert.run(header.kind, name, sha256, size, header.schema_version, header.compat_version, header.app_version, header.backup_key_id, JSON.stringify(header.row_counts), header.created_at);
        auditor.write({ actorType: "system", action: "backup.register", target: `backup/${Number(result.lastInsertRowid)}`, detail: { file: name, kind: header.kind } });
        added.push(name);
      } catch (error) {
        logger.warn({ file: name, err: error }, "backups 目录里有认不出的备份文件，没有登记");
      }
    }
    if (added.length > 0) logger.info({ files: added }, "给 backups 目录里没有登记的备份文件补了登记");
    return added;
  }

  return {
    create: (kind, actor) => serial(() => createNow(kind, actor)),
    verify: (file, actor) => serial(() => verifyNow(file, actor)),
    prune: actor => serial(() => pruneNow(actor)),
    reconcile: () => serial(() => reconcileNow()),
    list: () => db.prepare(`SELECT ${selectColumns} FROM backups ORDER BY created_at DESC, id DESC`).all() as BackupRecord[],
    latest,
    idle: () => chain.then(() => undefined),
  };
}
