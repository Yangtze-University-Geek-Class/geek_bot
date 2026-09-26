import { appendFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAlerts } from "../../app/control/src/db/alerts.js";
import { createAuditor } from "../../app/control/src/db/audit.js";
import { DatabaseOpenError, listTables, openDatabase, type Db } from "../../app/control/src/db/database.js";
import { applyMigrations, loadMigrations, MigrationError, planMigrations, readSchemaState } from "../../app/control/src/db/migrator.js";
import { createRedactor, REDACTED } from "../../app/control/src/log/redact.js";
import { cleanupTempDirs, EXPAND_NEXT, migrationSet, realMigrations, SHRINK_NEXT, tempDir } from "./helpers.js";

const opened: Db[] = [];
function open(path: string): Db {
  const db = openDatabase(path);
  opened.push(db);
  return db;
}

afterEach(() => {
  for (const db of opened.splice(0)) if (db.open) db.close();
  cleanupTempDirs();
});

const clock = () => Date.UTC(2026, 8, 26, 3, 0, 0);

/** 按某个迁移目录把库迁到它的最新版本。 */
function migrateWith(db: Db, dir: string): void {
  const plan = planMigrations(db, loadMigrations(dir));
  applyMigrations(db, plan.pending, { clock, appVersion: "test" });
}

/** 数据模型表清单里标 #3 的 7 张表。 */
const FOUNDATION_TABLES = ["alerts", "audit_logs", "backups", "idempotency_keys", "revisions", "schema_migrations", "settings"];

describe("打开库", () => {
  it("连接参数：WAL、synchronous=FULL、foreign_keys=ON、busy_timeout 5000；新库文件权限 0600", () => {
    const path = join(tempDir(), "data", "geek-bot.db");
    const db = open(path);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("synchronous", { simple: true })).toBe(2);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
    expect(db.pragma("locking_mode", { simple: true })).toBe("exclusive");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("单写者：control 以独占方式持有库时，第二个连接打不开（ADR-0003）", () => {
    const path = join(tempDir(), "geek-bot.db");
    open(path);
    let error: unknown;
    try {
      open2(path);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DatabaseOpenError);
    expect((error as DatabaseOpenError).reason).toBe("locked");
    expect((error as Error).message).toContain("只允许一个 control 进程读写");
  });

  it("离线命令要求库已存在；不是 SQLite 的文件拒绝打开", () => {
    const dir = tempDir();
    expect(() => openDatabase(join(dir, "missing.db"), { mustExist: true })).toThrow("库文件不存在");
    const junk = join(dir, "junk.db");
    writeFileSync(junk, "this is not a database file, just some text that is long enough to have a header".repeat(20));
    expect(() => openDatabase(junk)).toThrow(DatabaseOpenError);
  });
});

function open2(path: string): Db {
  return openDatabase(path, { busyTimeoutMs: 100 });
}

describe("迁移器（ADR-0008）", () => {
  it("迁移文件：编号从 0001 起连续、首行声明 shrink；代码自带的迁移都合规", () => {
    const migrations = loadMigrations();
    expect(migrations.map(m => m.name)).toEqual(realMigrations());
    expect(migrations[0]).toMatchObject({ version: 1, name: "0001_foundation.sql", shrink: false });
    expect(migrations[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("反例：文件名不合规、编号跳号、缺少首行声明都拒绝", () => {
    const bad = (name: string, sql: string) => {
      const dir = migrationSet();
      writeFileSync(join(dir, name), sql);
      return () => loadMigrations(dir);
    };
    expect(bad("0002-Add.sql", "-- geek-bot-migration shrink=false\n")).toThrow("迁移文件名不合规");
    expect(bad(`${String(realMigrations().length + 2).padStart(4, "0")}_gap.sql`, "-- geek-bot-migration shrink=false\n")).toThrow("迁移编号必须从 0001 起连续");
    expect(bad(`${String(realMigrations().length + 1).padStart(4, "0")}_no_header.sql`, "CREATE TABLE x (id INTEGER);\n")).toThrow("第一行必须是");
  });

  it("空库迁到最新：建出 #3 的 7 张表，user_version 等于最高编号，兼容版本为 0，记录 sha256 与镜像版本", () => {
    const db = open(join(tempDir(), "geek-bot.db"));
    const migrations = loadMigrations();
    const plan = planMigrations(db, migrations);
    expect(plan.pending).toHaveLength(migrations.length);
    applyMigrations(db, plan.pending, { clock, appVersion: "v0.1.0-rc.1" });
    for (const table of FOUNDATION_TABLES) expect(listTables(db)).toContain(table);
    expect(readSchemaState(db, migrations.length)).toEqual({ userVersion: migrations.length, compatVersion: 0, codeVersion: migrations.length });
    const row = db.prepare("SELECT * FROM schema_migrations WHERE version = 1").get();
    expect(row).toEqual({ version: 1, name: "0001_foundation.sql", sha256: migrations[0]?.sha256, shrink: 0, compat_version: 0, app_version: "v0.1.0-rc.1", applied_at: clock() });
    expect(planMigrations(db, migrations).pending).toHaveLength(0);
  });

  it("上一版本的库迁到最新：只执行新增的迁移，只扩不缩的迁移不抬高兼容版本", () => {
    const db = open(join(tempDir(), "geek-bot.db"));
    migrateWith(db, migrationSet());
    const current = realMigrations().length;
    db.prepare("INSERT INTO settings (key, value_json, updated_at) VALUES ('pause.global', '{}', 1)").run();
    const next = loadMigrations(migrationSet([EXPAND_NEXT]));
    const plan = planMigrations(db, next);
    expect(plan.pending.map(m => m.version)).toEqual([current + 1]);
    applyMigrations(db, plan.pending, { clock, appVersion: "next" });
    expect(readSchemaState(db, next.length)).toMatchObject({ userVersion: current + 1, compatVersion: 0 });
    expect(db.prepare("SELECT key, note FROM settings").all()).toEqual([{ key: "pause.global", note: null }]);
  });

  it("库的兼容版本高于代码时拒绝启动，并说明原因和该怎么办", () => {
    const db = open(join(tempDir(), "geek-bot.db"));
    migrateWith(db, migrationSet([SHRINK_NEXT]));
    const current = realMigrations().length;
    expect(readSchemaState(db, current + 1)).toMatchObject({ userVersion: current + 1, compatVersion: current + 1 });
    let error: unknown;
    try {
      planMigrations(db, loadMigrations(migrationSet()));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(MigrationError);
    const message = (error as Error).message;
    expect(message).toContain(`库的兼容版本是 ${current + 1}，高于这版代码认识的最高迁移编号 ${current}`);
    expect(message).toContain("请部署更新的镜像，或者从那次收缩迁移之前的备份恢复");
    expect(message).toContain("拒绝启动");
  });

  it("回滚：上一版代码打开只扩不缩的新库，不执行迁移，标记库比代码新", () => {
    const db = open(join(tempDir(), "geek-bot.db"));
    migrateWith(db, migrationSet([EXPAND_NEXT]));
    const plan = planMigrations(db, loadMigrations(migrationSet()));
    expect(plan).toMatchObject({ pending: [], databaseNewer: true });
    expect(plan.state.compatVersion).toBeLessThanOrEqual(plan.state.codeVersion);
  });

  it("迁移中途失败时回滚这个文件，库停在原版本", () => {
    const db = open(join(tempDir(), "geek-bot.db"));
    migrateWith(db, migrationSet());
    const current = realMigrations().length;
    const broken = { slug: "broken", sql: "-- geek-bot-migration shrink=false\nCREATE TABLE half_done (id INTEGER);\nINSERT INTO no_such_table VALUES (1);\n" };
    const next = loadMigrations(migrationSet([broken]));
    expect(() => applyMigrations(db, planMigrations(db, next).pending, { clock, appVersion: "next" })).toThrow(`已回滚，库停在第 ${current} 号迁移`);
    expect(readSchemaState(db, next.length).userVersion).toBe(current);
    expect(listTables(db)).not.toContain("half_done");
    expect((db.prepare("SELECT count(*) AS n FROM schema_migrations").get() as { n: number }).n).toBe(current);
  });

  it("已应用的迁移文件被改动时拒绝启动", () => {
    const db = open(join(tempDir(), "geek-bot.db"));
    const dir = migrationSet();
    migrateWith(db, dir);
    appendFileSync(join(dir, "0001_foundation.sql"), "-- 事后补的一行注释\n");
    expect(() => planMigrations(db, loadMigrations(dir))).toThrow("迁移 0001_foundation.sql 与代码里的文件不一致");
  });

  it("反例：schema_migrations 的编号不是从 1 起连续的（中间一行被删）时拒绝启动", () => {
    const db = open(join(tempDir(), "geek-bot.db"));
    const dir = migrationSet([EXPAND_NEXT]);
    migrateWith(db, dir);
    db.prepare("DELETE FROM schema_migrations WHERE version = 1").run();
    expect(() => planMigrations(db, loadMigrations(dir))).toThrow("schema_migrations 里的迁移编号不是从 1 起连续的（缺第 1 号）：库被手工改过，拒绝启动");
  });

  it("有表却没有迁移记录的库（不是 geek_bot 的库）拒绝启动；user_version 与记录对不上也拒绝", () => {
    const foreign = open(join(tempDir(), "foreign.db"));
    foreign.exec("CREATE TABLE something (id INTEGER)");
    expect(() => planMigrations(foreign, loadMigrations())).toThrow("这不是 geek_bot 的库");
    const tampered = open(join(tempDir(), "tampered.db"));
    migrateWith(tampered, migrationSet());
    tampered.pragma("user_version = 7");
    expect(() => planMigrations(tampered, loadMigrations())).toThrow("两者对不上");
  });
});

describe("迁移器：声明 shrink=false 的迁移不能收缩（按执行前后的真实结构判定）", () => {
  const HEADER = "-- geek-bot-migration shrink=false";

  /** 在最新的库上追加一个迁移并执行；返回执行结果（失败时是报错）和执行后的库。 */
  function applyNext(sql: string): { error: string | null; db: Db; current: number } {
    const db = open(join(tempDir(), "geek-bot.db"));
    migrateWith(db, migrationSet());
    db.prepare("INSERT INTO settings (key, value_json, updated_by, updated_at) VALUES ('pause.global', '{}', 7, 1)").run();
    const current = realMigrations().length;
    const next = loadMigrations(migrationSet([{ slug: "next", sql }]));
    try {
      applyMigrations(db, planMigrations(db, next).pending, { clock, appVersion: "next" });
      return { error: null, db, current };
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationError);
      return { error: (error as Error).message, db, current };
    }
  }

  it("反例：删表、删列、表或列改名、删索引、重写触发器、重建表时丢列或改类型或加 NOT NULL，都回滚并拒绝", () => {
    const cases: Array<[string, string]> = [
      [`${HEADER}\nDROP TABLE revisions;\n`, "删掉或改名了表 revisions"],
      // 小写、注释和一个文件里的多条语句：判断看的是执行后的结构，写法不影响。
      [`${HEADER}\n/* 看起来只是加一张表 */ create table extra_ok (id integer);\n-- drop 写在注释里不算\nalter table settings drop column updated_by;\n`, "删掉或改名了列 settings.updated_by"],
      [`${HEADER}\nALTER TABLE revisions RENAME TO revisions_old;\n`, "删掉或改名了表 revisions"],
      [`${HEADER}\nAlter Table settings Rename Column updated_by To changed_by;\n`, "删掉或改名了列 settings.updated_by"],
      [`${HEADER}\nDrOp InDeX audit_logs_at;\n`, "删掉或改名了索引 audit_logs_at"],
      [`${HEADER}\nDROP TRIGGER audit_logs_no_delete;\nCREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs BEGIN SELECT 1; END;\n`, "改了触发器 audit_logs_no_delete的定义"],
      [
        `${HEADER}\nCREATE TABLE revisions_new (scope TEXT PRIMARY KEY, updated_at INTEGER NOT NULL);\nINSERT INTO revisions_new SELECT scope, updated_at FROM revisions;\nDROP TABLE revisions;\nALTER TABLE revisions_new RENAME TO revisions;\n`,
        "删掉或改名了列 revisions.revision",
      ],
      [
        `${HEADER}\nCREATE TABLE revisions_new (scope TEXT PRIMARY KEY, revision TEXT NOT NULL, updated_at INTEGER NOT NULL);\nINSERT INTO revisions_new SELECT * FROM revisions;\nDROP TABLE revisions;\nALTER TABLE revisions_new RENAME TO revisions;\n`,
        "改了列 revisions.revision 的类型（INTEGER → TEXT）",
      ],
      [
        `${HEADER}\nCREATE TABLE settings_new (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_by INTEGER NOT NULL, updated_at INTEGER NOT NULL);\nINSERT INTO settings_new SELECT * FROM settings;\nDROP TABLE settings;\nALTER TABLE settings_new RENAME TO settings;\n`,
        "给已有列 settings.updated_by 加了 NOT NULL",
      ],
    ];
    for (const [sql, expected] of cases) {
      const { error, db, current } = applyNext(sql);
      expect(error, sql).toContain(`已回滚，库停在第 ${current} 号迁移：它声明 shrink=false，执行后却${expected}`);
      expect(error).toContain("要改成 shrink=true 并另写 ADR 取得所有者批准");
      // 事务整体回滚：版本、记录和结构都停在执行之前。
      expect(readSchemaState(db, current + 1).userVersion).toBe(current);
      expect((db.prepare("SELECT count(*) AS n FROM schema_migrations").get() as { n: number }).n).toBe(current);
      expect(listTables(db)).toEqual(expect.arrayContaining(["revisions", "settings"]));
      expect(listTables(db)).not.toContain("extra_ok");
      expect(db.prepare("SELECT key, updated_by FROM settings").all()).toEqual([{ key: "pause.global", updated_by: 7 }]);
      expect((db.prepare("SELECT sql FROM sqlite_master WHERE name = 'audit_logs_no_delete'").get() as { sql: string }).sql).toContain("RAISE(ABORT");
    }
  });

  it("按官方步骤重建表放宽 CHECK（列、索引原样重建）不算收缩：shrink=false 通过，数据保留，兼容版本不变", () => {
    const db = open(join(tempDir(), "geek-bot.db"));
    migrateWith(db, migrationSet());
    db.prepare("INSERT INTO alerts (kind, severity, subject, message, first_at, last_at, count) VALUES ('backup_failed', 'critical', 'backup/daily', 'x', 1, 1, 1)").run();
    // 迁移作者照抄 0001 里建索引的原文。
    const index = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'alerts_open_kind_subject'").get() as { sql: string }).sql;
    const rebuild = [
      HEADER,
      "CREATE TABLE alerts_new (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, severity TEXT NOT NULL CHECK (severity IN ('info', 'notice', 'warning', 'critical')), subject TEXT NOT NULL, message TEXT NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL, count INTEGER NOT NULL, acked_by INTEGER, acked_at INTEGER, resolved_at INTEGER);",
      "INSERT INTO alerts_new SELECT * FROM alerts;",
      "DROP TABLE alerts;",
      "ALTER TABLE alerts_new RENAME TO alerts;",
      `${index};`,
      "",
    ].join("\n");
    const dir = migrationSet([{ slug: "relax_alert_severity", sql: rebuild }]);
    migrateWith(db, dir);
    const current = realMigrations().length;
    expect(readSchemaState(db, current + 1)).toMatchObject({ userVersion: current + 1, compatVersion: 0 });
    db.prepare("INSERT INTO alerts (kind, severity, subject, message, first_at, last_at, count) VALUES ('x', 'notice', 'y', 'z', 1, 1, 1)").run();
    expect(db.prepare("SELECT kind, severity FROM alerts ORDER BY id").all()).toEqual([
      { kind: "backup_failed", severity: "critical" },
      { kind: "x", severity: "notice" },
    ]);
    // 上一版代码仍能打开（回滚情形）。
    expect(planMigrations(db, loadMigrations(migrationSet()))).toMatchObject({ pending: [], databaseNewer: true });
  });

  it("声明 shrink=true 的迁移可以删表，兼容版本抬到它自己的编号", () => {
    const db = open(join(tempDir(), "geek-bot.db"));
    migrateWith(db, migrationSet([{ slug: "drop_revisions", sql: "-- geek-bot-migration shrink=true\nDROP TABLE revisions;\n" }]));
    const current = realMigrations().length;
    expect(readSchemaState(db, current + 1)).toMatchObject({ userVersion: current + 1, compatVersion: current + 1 });
    expect(listTables(db)).not.toContain("revisions");
  });
});

describe("审计与告警", () => {
  function migrated(): Db {
    const db = open(join(tempDir(), "geek-bot.db"));
    migrateWith(db, migrationSet());
    return db;
  }

  it("audit_logs 只追加：更新和删除被触发器拒绝；detail 与 target 写入前打码", () => {
    const db = migrated();
    const auditor = createAuditor(db, createRedactor(), clock);
    const token = `ghp_${"Z9y8X7w6V5u4T3s2R1q0".repeat(2)}`;
    const id = auditor.write({ actorType: "cli", action: "backup.create", target: `note ${token}`, detail: { header: `Bearer ${token}`, count: 2 } });
    const row = db.prepare("SELECT actor_type, action, target, detail_json, reauth FROM audit_logs WHERE id = ?").get(id) as Record<string, unknown>;
    expect(row).toMatchObject({ actor_type: "cli", action: "backup.create", target: `note ghp_${REDACTED}`, reauth: 0 });
    expect(JSON.parse(row.detail_json as string)).toEqual({ header: `Bearer ${REDACTED}`, count: 2 });
    expect(() => db.prepare("UPDATE audit_logs SET action = 'x' WHERE id = ?").run(id)).toThrow("audit_logs 只追加，不能修改已有记录");
    expect(() => db.prepare("DELETE FROM audit_logs WHERE id = ?").run(id)).toThrow("audit_logs 只追加，不能删除已有记录");
    expect(() => db.prepare("INSERT INTO audit_logs (at, actor_type, action, reauth) VALUES (1, 'robot', 'x', 0)").run()).toThrow(/CHECK constraint failed/);
  });

  it("同一件事只有一条未解决的告警，重复发生只加计数；解决后再发生是新的一条", () => {
    const db = migrated();
    let now = 1000;
    const alerts = createAlerts(db, createRedactor(), () => now);
    const first = alerts.raise({ kind: "backup_verify_failed", severity: "critical", subject: "backup/1", message: "失败一次" });
    now = 2000;
    const again = alerts.raise({ kind: "backup_verify_failed", severity: "critical", subject: "backup/1", message: "又失败" });
    expect(again).toBe(first);
    expect(alerts.open("backup_verify_failed")).toEqual([
      { id: first, kind: "backup_verify_failed", severity: "critical", subject: "backup/1", message: "又失败", count: 2, first_at: 1000, last_at: 2000 },
    ]);
    expect(alerts.resolve("backup_verify_failed")).toBe(1);
    expect(alerts.open()).toEqual([]);
    expect(alerts.raise({ kind: "backup_verify_failed", severity: "critical", subject: "backup/1", message: "再次失败" })).not.toBe(first);
    expect(() => db.prepare("INSERT INTO alerts (kind, severity, subject, message, first_at, last_at, count) VALUES ('backup_verify_failed', 'critical', 'backup/1', 'dup', 1, 1, 1)").run()).toThrow(/UNIQUE constraint failed/);
  });
});

describe("清理", () => {
  it("测试用的临时库都在系统临时目录里", () => {
    const dir = tempDir();
    expect(existsSync(dir)).toBe(true);
    expect(dir.startsWith(process.cwd())).toBe(false);
  });
});
