/**
 * 打开 control 的 SQLite 库（data-model「存储与通用约定」）。
 *
 * 连接参数：WAL、synchronous=FULL、foreign_keys=ON、busy_timeout 5000 毫秒。
 * 单写者（ADR-0003）：默认以 locking_mode=EXCLUSIVE 打开，第一次访问后一直持有文件锁，
 * 直到连接关闭；同一个库再被别的连接或进程打开时拿不到锁（SQLITE_BUSY）。
 * WAL 下先设独占模式再第一次访问，SQLite 不建共享内存文件（-shm）。
 */
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type Db = Database.Database;

/** busy_timeout 的默认值（毫秒）。 */
export const BUSY_TIMEOUT_MS = 5000;

export interface OpenOptions {
  /** 以独占方式持有文件锁（control 进程与离线 CLI 都用独占）。默认 true。 */
  readonly exclusive?: boolean;
  /** 等锁的最长时间（毫秒）。 */
  readonly busyTimeoutMs?: number;
  /** 库文件必须已经存在（离线 CLI 用，不新建空库）。 */
  readonly mustExist?: boolean;
}

/** 库打不开：被别的进程占用、文件不存在或不是 SQLite 库。message 是给人看的中文。 */
export class DatabaseOpenError extends Error {
  constructor(message: string, readonly reason: "locked" | "missing" | "invalid") {
    super(message);
    this.name = "DatabaseOpenError";
  }
}

function isBusy(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}

export function openDatabase(path: string, options: OpenOptions = {}): Db {
  const { exclusive = true, busyTimeoutMs = BUSY_TIMEOUT_MS, mustExist = false } = options;
  const existed = existsSync(path);
  if (!existed && mustExist) throw new DatabaseOpenError(`库文件不存在：${path}`, "missing");
  if (!existed) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  let db: Db;
  try {
    db = new Database(path, { fileMustExist: mustExist, timeout: busyTimeoutMs });
  } catch (error) {
    throw new DatabaseOpenError(`打不开库文件 ${path}：${(error as Error).message}`, "invalid");
  }
  try {
    // 新建的库只给运行 control 的账号读写；-wal 与库文件用同样的权限。
    if (!existed) chmodSync(path, 0o600);
    if (exclusive) db.pragma("locking_mode = EXCLUSIVE");
    const mode = db.pragma("journal_mode = WAL", { simple: true });
    if (mode !== "wal") throw new DatabaseOpenError(`库没能切到 WAL 模式（现在是 ${String(mode)}）：${path}`, "invalid");
    db.pragma("synchronous = FULL");
    db.pragma("foreign_keys = ON");
    db.pragma(`busy_timeout = ${Math.trunc(busyTimeoutMs)}`);
    // 立刻拿到写锁：独占模式下这把锁一直持有，别的进程从这一刻起就打不开这个库。
    if (exclusive) db.exec("BEGIN IMMEDIATE; COMMIT;");
    return db;
  } catch (error) {
    db.close();
    if (error instanceof DatabaseOpenError) throw error;
    if (isBusy(error)) {
      throw new DatabaseOpenError(`库正被另一个进程占用：同一个库只允许一个 control 进程读写（ADR-0003）：${path}`, "locked");
    }
    if ((error as { code?: unknown }).code === "SQLITE_NOTADB") {
      throw new DatabaseOpenError(`不是 SQLite 库文件：${path}`, "invalid");
    }
    throw error;
  }
}

/**
 * 打开一份独立的库文件副本（备份的临时明文、恢复校验解出的临时文件）：文件必须已存在，不独占，
 * 转成 DELETE 日志模式，这样副本是一个自足的文件，关闭后不留 -wal、-shm。
 */
export function openCopy(path: string): Db {
  const db = new Database(path, { fileMustExist: true, timeout: BUSY_TIMEOUT_MS });
  try {
    db.pragma("journal_mode = DELETE");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** 关闭前把 WAL 里的内容写回库文件并截断 WAL；返回 SQLite 的结果（busy 为 0 表示完整做完）。 */
export function checkpointAndClose(db: Db): { busy: number; log: number; checkpointed: number } {
  const [row] = db.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number; log: number; checkpointed: number }>;
  db.close();
  return { busy: row?.busy ?? -1, log: row?.log ?? -1, checkpointed: row?.checkpointed ?? -1 };
}

/** 列出库里的业务表（不含 sqlite_ 开头的内部表），按名字排序。 */
export function listTables(db: Db): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name").all() as Array<{ name: string }>;
  return rows.map(row => row.name);
}

/** SQL 标识符加双引号（名字来自 sqlite_master，不是外部输入；仍按规则转义）。 */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** 各表的行数。 */
export function countRows(db: Db): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of listTables(db)) {
    const row = db.prepare(`SELECT count(*) AS n FROM ${quoteIdentifier(table)}`).get() as { n: number };
    counts[table] = row.n;
  }
  return counts;
}
