/**
 * SQLite 迁移器（ADR-0008，data-model「迁移规则」）。不引入 ORM 或迁移框架。
 *
 * - 迁移文件：`src/db/migrations/NNNN_<slug>.sql`，编号从 0001 起连续；第一行声明 `-- geek-bot-migration shrink=false|true`。
 * - 库里两个数：`PRAGMA user_version` 是执行到第几号迁移（D）；兼容版本（K）是 schema_migrations 里编号最大那一行的
 *   compat_version，只有收缩类迁移才抬高它。代码认识的最高编号是 C。
 * - 启动检查：已应用且不大于 C 的迁移 sha256 必须与代码里的文件一致；K > C 拒绝启动；D < C 先做迁移前备份再逐个执行；
 *   D > C 而 K ≤ C 是回滚到上一版镜像，正常启动、不执行迁移。
 * - 每个文件在自己的事务里执行，同一个事务里写 schema_migrations、设 user_version、跑 foreign_key_check；任何一步失败就回滚这个文件。
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./database.js";

/** 代码自带的迁移目录：源码运行时是 src/db/migrations，构建后是 dist/db/migrations（构建时复制）。 */
export const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

export const MIGRATION_FILE_RE = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;
export const MIGRATION_HEADER_RE = /^-- geek-bot-migration shrink=(true|false)\r?$/;

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sha256: string;
  readonly shrink: boolean;
  readonly sql: string;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly sha256: string;
  readonly shrink: number;
  readonly compat_version: number;
  readonly app_version: string;
  readonly applied_at: number;
}

/** 迁移文件本身不合法（代码缺陷），或者启动检查没过。message 是给人看的中文。 */
export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

/** 读一个迁移目录：文件名、首行声明、编号连续都在这里核对。 */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const files = readdirSync(dir).filter(name => name.endsWith(".sql")).sort();
  const migrations: Migration[] = [];
  for (const file of files) {
    const match = MIGRATION_FILE_RE.exec(file);
    if (!match) throw new MigrationError(`迁移文件名不合规：${file}（要求 NNNN_<slug>.sql，slug 只用小写字母、数字和下划线）`);
    const version = Number(match[1]);
    const expected = migrations.length + 1;
    if (version !== expected) throw new MigrationError(`迁移编号必须从 0001 起连续：期望 ${String(expected).padStart(4, "0")}，实际是 ${file}`);
    const bytes = readFileSync(join(dir, file));
    const sql = bytes.toString("utf8");
    const header = MIGRATION_HEADER_RE.exec(sql.split("\n", 1)[0] ?? "");
    if (!header) throw new MigrationError(`迁移文件第一行必须是 -- geek-bot-migration shrink=false 或 shrink=true：${file}`);
    migrations.push(
      Object.freeze({ version, name: file, sha256: createHash("sha256").update(bytes).digest("hex"), shrink: header[1] === "true", sql }),
    );
  }
  return migrations;
}

export interface SchemaState {
  /** 执行到第几号迁移（PRAGMA user_version）。 */
  readonly userVersion: number;
  /** 库的兼容版本。 */
  readonly compatVersion: number;
  /** 代码认识的最高迁移编号。 */
  readonly codeVersion: number;
}

function tableExists(db: Db, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

/** 读库的 D 与 K（没有 schema_migrations 时 K 为 0）。 */
export function readSchemaState(db: Db, codeVersion: number): SchemaState {
  const userVersion = db.pragma("user_version", { simple: true }) as number;
  let compatVersion = 0;
  if (tableExists(db, "schema_migrations")) {
    const row = db.prepare("SELECT compat_version FROM schema_migrations ORDER BY version DESC LIMIT 1").get() as { compat_version: number } | undefined;
    compatVersion = row?.compat_version ?? 0;
  }
  return Object.freeze({ userVersion, compatVersion, codeVersion });
}

export interface MigrationPlan {
  readonly state: SchemaState;
  /** 待执行的迁移（D < C 时非空）。 */
  readonly pending: readonly Migration[];
  /** 库比代码新（回滚到上一版镜像）：D > C 且 K ≤ C。 */
  readonly databaseNewer: boolean;
}

/**
 * 启动检查（接受任何请求之前）：核对库与代码，给出要执行的迁移；不改库。
 * 不能启动时抛 MigrationError，message 说明原因和该怎么办。
 */
export function planMigrations(db: Db, migrations: readonly Migration[]): MigrationPlan {
  const codeVersion = migrations.length;
  const state = readSchemaState(db, codeVersion);
  const { userVersion: d, compatVersion: k } = state;

  if (d === 0) {
    const objects = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'").get() as { n: number };
    if (objects.n > 0) {
      throw new MigrationError("库里已经有表，却没有迁移记录（user_version=0）：这不是 geek_bot 的库，或者被手工改过，拒绝启动");
    }
    return Object.freeze({ state, pending: migrations, databaseNewer: false });
  }

  if (!tableExists(db, "schema_migrations")) {
    throw new MigrationError(`库的 user_version 是 ${d}，却没有 schema_migrations 表：库被手工改过，拒绝启动`);
  }
  const applied = db.prepare("SELECT version, name, sha256 FROM schema_migrations ORDER BY version").all() as Array<Pick<AppliedMigration, "version" | "name" | "sha256">>;
  const top = applied.at(-1)?.version ?? 0;
  if (top !== d) {
    throw new MigrationError(`库的 user_version 是 ${d}，schema_migrations 里最大的编号却是 ${top}：两者对不上，库被手工改过，拒绝启动`);
  }
  for (const row of applied) {
    if (row.version > codeVersion) continue;
    const code = migrations[row.version - 1];
    if (!code || code.name !== row.name || code.sha256 !== row.sha256) {
      throw new MigrationError(
        `迁移 ${row.name} 与代码里的文件不一致（sha256 或文件名不同）：迁移文件进入 stage 以后不能再改，写错了要再写一个新的迁移；拒绝启动`,
      );
    }
  }
  if (k > codeVersion) {
    throw new MigrationError(
      `库的兼容版本是 ${k}，高于这版代码认识的最高迁移编号 ${codeVersion}：库做过这版代码不认识的收缩类迁移（库执行到第 ${d} 号迁移）。` +
        "这版代码不能打开这个库：请部署更新的镜像，或者从那次收缩迁移之前的备份恢复。拒绝启动",
    );
  }
  const pending = d < codeVersion ? migrations.slice(d) : [];
  return Object.freeze({ state, pending, databaseNewer: d > codeVersion });
}

export interface ApplyOptions {
  readonly clock: () => number;
  readonly appVersion: string;
  /** 每个迁移提交之后回调（写审计、记日志）。 */
  readonly onApplied?: (migration: Migration, compatVersion: number) => void;
}

/** 逐个执行待执行的迁移；某一个失败时回滚它并抛 MigrationError，库停在上一个版本。 */
export function applyMigrations(db: Db, pending: readonly Migration[], options: ApplyOptions): void {
  for (const migration of pending) {
    let compatVersion = 0;
    const run = db.transaction(() => {
      const before = readSchemaState(db, migration.version);
      if (before.userVersion !== migration.version - 1) {
        throw new Error(`它要求库停在第 ${migration.version - 1} 号，实际是第 ${before.userVersion} 号`);
      }
      db.exec(migration.sql);
      compatVersion = migration.shrink ? migration.version : before.compatVersion;
      // schema_migrations 由 0001 建出，所以语句在执行完迁移之后才准备。
      db.prepare(
        "INSERT INTO schema_migrations (version, name, sha256, shrink, compat_version, app_version, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(migration.version, migration.name, migration.sha256, migration.shrink ? 1 : 0, compatVersion, options.appVersion, options.clock());
      db.pragma(`user_version = ${migration.version}`);
      const violations = db.pragma("foreign_key_check") as unknown[];
      if (violations.length > 0) throw new Error(`执行之后外键检查不通过（${violations.length} 处）`);
    });
    try {
      run.immediate();
    } catch (error) {
      throw new MigrationError(`迁移 ${migration.name} 执行失败，已回滚，库停在第 ${migration.version - 1} 号迁移：${(error as Error).message}`);
    }
    options.onApplied?.(migration, compatVersion);
  }
}
