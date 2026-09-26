import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAlerts } from "../../app/control/src/db/alerts.js";
import { createAuditor } from "../../app/control/src/db/audit.js";
import { countRows, openCopy, openDatabase, type Db } from "../../app/control/src/db/database.js";
import { applyMigrations, loadMigrations, planMigrations } from "../../app/control/src/db/migrator.js";
import { createLogger } from "../../app/control/src/log/logger.js";
import { createRedactor } from "../../app/control/src/log/redact.js";
import { BACKUP_MAGIC, decryptBackup, readBackupHeader, sha256File } from "../../app/control/src/ops/backup-file.js";
import { checkBackupFile, createBackupService, type BackupRecord, type BackupService } from "../../app/control/src/ops/backup.js";
import { createDailyJobs, isoWeekStart, lastSlotAt } from "../../app/control/src/ops/scheduler.js";
import { keyFingerprint } from "../../app/control/src/secrets/key-files.js";
import { cleanupTempDirs, fakeClock, memorySink, tempDir } from "./helpers.js";
import { randomBytes } from "node:crypto";

const opened: Db[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) if (db.open) db.close();
  cleanupTempDirs();
});

const DAY = 86_400_000;
/** 2026-09-28 是周一。 */
const MONDAY = Date.UTC(2026, 8, 28, 0, 0, 0);
/** 写进库里的一个明文标记：加密后的备份文件里不能找到它。 */
const PLAINTEXT_MARKER = "plaintext-marker-that-must-not-appear-in-backup";

interface Env {
  readonly db: Db;
  readonly dir: string;
  readonly backupDir: string;
  readonly key: Buffer;
  readonly keyId: string;
  readonly clock: ReturnType<typeof fakeClock>;
  readonly service: BackupService;
  readonly alerts: ReturnType<typeof createAlerts>;
  readonly sink: ReturnType<typeof memorySink>;
}

function setup(options: { daily?: number; weekly?: number; others?: number; start?: number } = {}): Env {
  const dir = tempDir();
  const db = openDatabase(join(dir, "data", "geek-bot.db"));
  opened.push(db);
  const clock = fakeClock(options.start ?? MONDAY + 3 * 3_600_000);
  const plan = planMigrations(db, loadMigrations());
  applyMigrations(db, plan.pending, { clock, appVersion: "test" });
  db.prepare("INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)").run("pause.global", JSON.stringify({ reason: PLAINTEXT_MARKER }), 1);
  db.prepare("INSERT INTO revisions (scope, revision, updated_at) VALUES ('settings', 3, 1)").run();
  const redactor = createRedactor();
  const key = randomBytes(32);
  const keyId = keyFingerprint(key, "backup-key");
  const sink = memorySink();
  const alerts = createAlerts(db, redactor, clock);
  const service = createBackupService({
    db,
    backupDir: join(dir, "data", "backups"),
    backupKey: key,
    backupKeyId: keyId,
    clock,
    appVersion: "v0.1.0-rc.1",
    retention: { daily: options.daily ?? 7, weekly: options.weekly ?? 4, others: options.others ?? 3 },
    auditor: createAuditor(db, redactor, clock),
    alerts,
    logger: createLogger({ level: "debug", redactor, sink, clock }),
  });
  return { db, dir, backupDir: join(dir, "data", "backups"), key, keyId, clock, service, alerts, sink };
}

const system = { type: "system" as const };

describe("备份 → 恢复 → integrity_check 往返（S-17）", () => {
  it("在线备份加密落盘：权限 0600、sha256 与登记一致、头部带库版本和行数；密文里找不到明文", async () => {
    const env = setup();
    const record = await env.service.create("manual", system);
    const path = join(env.backupDir, record.file);
    expect(record).toMatchObject({ kind: "manual", schema_version: 1, compat_version: 0, app_version: "v0.1.0-rc.1", backup_key_id: env.keyId });
    expect(record.file).toMatch(/^geek-bot-manual-20260928T030000Z-[0-9a-f]{6}\.gbbk$/);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(env.backupDir).mode & 0o777).toBe(0o700);
    expect(await sha256File(path)).toBe(record.sha256);
    expect(statSync(path).size).toBe(record.bytes);
    const bytes = readFileSync(path);
    expect(bytes.subarray(0, BACKUP_MAGIC.length)).toEqual(BACKUP_MAGIC);
    expect(bytes.includes(Buffer.from(PLAINTEXT_MARKER))).toBe(false);
    expect(bytes.includes(Buffer.from("SQLite format 3"))).toBe(false);
    const { header } = await readBackupHeader(path);
    expect(header.row_counts).toMatchObject({ settings: 1, revisions: 1, backups: 0 });
    expect(JSON.parse(record.row_counts_json)).toEqual(header.row_counts);
    // 临时明文不留在备份目录里。
    expect(readdirSync(env.backupDir)).toEqual([record.file]);
    expect(env.db.prepare("SELECT action, target FROM audit_logs WHERE action = 'backup.create'").all()).toEqual([{ action: "backup.create", target: `backup/${record.id}` }]);
  });

  it("恢复出的库 integrity_check 为 ok，行数与内容和备份时一致", async () => {
    const env = setup();
    const before = countRows(env.db);
    const record = await env.service.create("manual", system);
    const restored = join(env.dir, "restored.sqlite");
    const header = await decryptBackup(join(env.backupDir, record.file), env.key, restored);
    const copy = openCopy(restored);
    try {
      expect(copy.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(copy.pragma("foreign_key_check")).toEqual([]);
      expect(copy.pragma("user_version", { simple: true })).toBe(header.schema_version);
      expect(countRows(copy)).toEqual(before);
      expect(copy.prepare("SELECT key, value_json FROM settings").all()).toEqual(env.db.prepare("SELECT key, value_json FROM settings").all());
    } finally {
      copy.close();
    }
    const report = await env.service.verify(record.file, system);
    expect(report).toMatchObject({ ok: true, problems: [], file: record.file, backupId: record.id });
    expect(env.db.prepare("SELECT verify_result, verify_detail, verified_at FROM backups WHERE id = ?").get(record.id)).toEqual({
      verify_result: "ok",
      verify_detail: "ok",
      verified_at: env.clock(),
    });
  });

  it("反例：改了一个字节的密文、改了头部、换了密钥、sha256 与登记不符，恢复校验都失败并写 critical 告警", async () => {
    const env = setup();
    const record = await env.service.create("manual", system);
    const path = join(env.backupDir, record.file);
    const original = readFileSync(path);

    const flipped = Buffer.from(original);
    flipped[flipped.length - 40] = (flipped[flipped.length - 40] as number) ^ 0xff;
    writeFileSync(path, flipped);
    const tampered = await env.service.verify(record.file, system);
    expect(tampered.ok).toBe(false);
    expect(tampered.problems).toContain("备份文件的 sha256 与登记的不一致");
    expect(tampered.problems).toContain("备份文件解密校验失败：内容或头部被改动过，或者不是用这把备份密钥加密的");
    expect(env.alerts.open("backup_verify_failed")).toMatchObject([{ severity: "critical", subject: `backup/${record.id}`, count: 1 }]);
    expect(env.db.prepare("SELECT verify_result FROM backups WHERE id = ?").get(record.id)).toEqual({ verify_result: "failed" });
    // 解密失败时不留半截明文。
    expect(readdirSync(env.backupDir)).toEqual([record.file]);

    const header = Buffer.from(original);
    const at = header.indexOf(Buffer.from('"schema_version":1'));
    header.write('"schema_version":9', at);
    expect(await checkBackupFile(join(env.dir, "missing.gbbk"), env.key, env.keyId, env.dir)).toMatchObject({ ok: false, problems: ["备份文件不存在"] });
    writeFileSync(join(env.dir, "h.gbbk"), header);
    const headerCheck = await checkBackupFile(join(env.dir, "h.gbbk"), env.key, env.keyId, env.dir);
    expect(headerCheck.ok).toBe(false);
    expect(headerCheck.problems).toContain("备份文件解密校验失败：内容或头部被改动过，或者不是用这把备份密钥加密的");

    writeFileSync(join(env.dir, "ok.gbbk"), original);
    const otherKey = randomBytes(32);
    const wrongKey = await checkBackupFile(join(env.dir, "ok.gbbk"), otherKey, keyFingerprint(otherKey, "backup-key"), env.dir);
    expect(wrongKey.problems[0]).toMatch(/^这份备份是用另一把备份密钥加密的（密钥指纹 [0-9a-f]{16}，当前密钥是 [0-9a-f]{16}）$/);
    // 指纹对得上但密钥不对（伪造指纹）：认证标签照样拦下。
    const forged = await checkBackupFile(join(env.dir, "ok.gbbk"), otherKey, env.keyId, env.dir);
    expect(forged.problems).toContain("备份文件解密校验失败：内容或头部被改动过，或者不是用这把备份密钥加密的");

    // 恢复原文件后校验通过，未解决的告警随之解决。
    writeFileSync(path, original);
    expect((await env.service.verify(record.file, system)).ok).toBe(true);
    expect(env.alerts.open("backup_verify_failed")).toEqual([]);
  });

  it("行数与登记不一致（登记被改或者备份不完整）同样判失败", async () => {
    const env = setup();
    const record = await env.service.create("manual", system);
    const counts = JSON.parse(record.row_counts_json) as Record<string, number>;
    env.db.prepare("UPDATE backups SET row_counts_json = ? WHERE id = ?").run(JSON.stringify({ ...counts, settings: 99 }), record.id);
    const report = await env.service.verify(record.file, system);
    expect(report.ok).toBe(false);
    expect(report.problems).toContain("表 settings 的行数不一致：登记 99，恢复出 1");
  });

  it("没有备份、文件已被清理、文件不存在时给出明确结果", async () => {
    const env = setup();
    expect(await env.service.verify(undefined, system)).toMatchObject({ ok: false, problems: ["还没有可校验的备份"] });
    const record = await env.service.create("manual", system);
    const path = join(env.backupDir, record.file);
    copyFileSync(path, join(env.dir, "keep.gbbk"));
    writeFileSync(path, "");
    expect((await env.service.verify(record.file, system)).ok).toBe(false);
    expect(await env.service.verify("geek-bot-manual-nope.gbbk", system)).toMatchObject({ ok: false, problems: ["backups 里没有登记这个文件：geek-bot-manual-nope.gbbk"] });
  });
});

describe("保留策略：7 份每日加 4 份每周；pre_deploy、pre_migration、manual 各 3 份", () => {
  it("超出的最旧备份被删除，登记保留并写 pruned_at 与审计", async () => {
    const env = setup();
    for (let day = 0; day < 9; day += 1) {
      env.clock.set(MONDAY + day * DAY + 3_600_000);
      await env.service.create("daily", system);
    }
    for (let week = 0; week < 5; week += 1) {
      env.clock.set(MONDAY + week * 7 * DAY + 2 * 3_600_000);
      await env.service.create("weekly", system);
    }
    for (let i = 0; i < 4; i += 1) {
      env.clock.advance(60_000);
      await env.service.create("manual", system);
      await env.service.create("pre_deploy", system);
    }
    const alive = env.service.list().filter(row => row.pruned_at === null);
    const count = (kind: string) => alive.filter(row => row.kind === kind).length;
    expect({ daily: count("daily"), weekly: count("weekly"), manual: count("manual"), pre_deploy: count("pre_deploy") }).toEqual({ daily: 7, weekly: 4, manual: 3, pre_deploy: 3 });
    const files = readdirSync(env.backupDir).sort();
    expect(files).toEqual(alive.map(row => row.file).sort());
    const pruned = env.service.list().filter(row => row.pruned_at !== null);
    expect(pruned).toHaveLength(2 + 1 + 1 + 1);
    // 删掉的是每类里最旧的。
    const oldestDaily = env.service.list().filter(row => row.kind === "daily").sort((a, b) => a.created_at - b.created_at);
    expect(oldestDaily.slice(0, 2).every(row => row.pruned_at !== null)).toBe(true);
    expect((env.db.prepare("SELECT count(*) AS n FROM audit_logs WHERE action = 'backup.prune'").get() as { n: number }).n).toBe(5);
    expect(await env.service.verify(pruned[0]?.file, system)).toMatchObject({ ok: false, problems: ["这份备份已经按保留策略删除"] });
  });

  it("保留份数可配置：每日保留 1 份时只留最新一份每日备份", async () => {
    const env = setup({ daily: 1, weekly: 4 });
    await env.service.create("daily", system);
    env.clock.advance(1000);
    const latest = await env.service.create("daily", system);
    expect(env.service.list().filter(row => row.pruned_at === null).map(row => row.file)).toEqual([latest.file]);
  });
});

describe("启动时补登记", () => {
  it("清掉崩溃留下的临时文件；backups 目录里没登记的备份按头部补登记", async () => {
    const source = setup();
    const record = await source.service.create("manual", system);
    const target = setup();
    mkdirSync(target.backupDir, { recursive: true });
    copyFileSync(join(source.backupDir, record.file), join(target.backupDir, record.file));
    writeFileSync(join(target.backupDir, ".tmp-abandoned.sqlite"), "half");
    writeFileSync(join(target.backupDir, "notes.txt"), "not a backup");
    writeFileSync(join(target.backupDir, "broken.gbbk"), "not a backup either");
    const added = await target.service.reconcile();
    expect(added).toEqual([record.file]);
    expect(existsSync(join(target.backupDir, ".tmp-abandoned.sqlite"))).toBe(false);
    const row = target.service.list().find(item => item.file === record.file);
    expect(row).toMatchObject({ kind: "manual", sha256: record.sha256, bytes: record.bytes, schema_version: 1, backup_key_id: source.keyId, created_at: record.created_at });
    expect(target.sink.lines().some(line => line.msg === "backups 目录里有认不出的备份文件，没有登记" && line.file === "broken.gbbk")).toBe(true);
    expect(await target.service.reconcile()).toEqual([]);
  });
});

describe("每日任务", () => {
  it("到点时刻与 ISO 周的计算", () => {
    const at = (h: number, day = 0) => MONDAY + day * DAY + h * 3_600_000;
    expect(lastSlotAt(at(4), 3)).toBe(at(3));
    expect(lastSlotAt(at(2), 3)).toBe(at(3, -1));
    expect(lastSlotAt(at(3), 3)).toBe(at(3));
    expect(isoWeekStart(at(10, 3))).toBe(MONDAY);
    expect(isoWeekStart(at(23, 6))).toBe(MONDAY);
    expect(isoWeekStart(at(0, 7))).toBe(MONDAY + 7 * DAY);
  });

  it("每天到点后做一次备份并恢复校验；每周第一次记为 weekly；没到点或当天做过就跳过", async () => {
    const env = setup({ start: MONDAY + 2 * 3_600_000 });
    const jobs = createDailyJobs({ backups: env.service, clock: env.clock, hourUtc: 3, keepWeekly: 4, logger: createLogger({ level: "error", redactor: createRedactor(), sink: env.sink }) });
    // 周一 02:00：上一个到点是周日 03:00，还没有任何备份，所以补做一次（这是本周第一次，记为 weekly）。
    expect(await jobs.tick()).toBe("done");
    expect(env.service.list().map(row => [row.kind, row.verify_result])).toEqual([["weekly", "ok"]]);
    env.clock.set(MONDAY + 2.5 * 3_600_000);
    expect(await jobs.tick()).toBe("skipped");
    env.clock.set(MONDAY + 3 * 3_600_000 + 1);
    expect(await jobs.tick()).toBe("done");
    expect(env.service.list()[0]?.kind).toBe("daily");
    env.clock.set(MONDAY + 23 * 3_600_000);
    expect(await jobs.tick()).toBe("skipped");
    env.clock.set(MONDAY + 7 * DAY + 4 * 3_600_000);
    expect(await jobs.tick()).toBe("done");
    expect(env.service.list()[0]?.kind).toBe("weekly");
    jobs.stop();
    expect(await jobs.tick()).toBe("skipped");
  });

  it("反例：每周保留 0 份时，周一的第一次备份记为 daily 并通过恢复校验（修之前记成 weekly，当场被清理，当天没有备份）", async () => {
    const env = setup({ daily: 7, weekly: 0, start: MONDAY + 4 * 3_600_000 });
    const jobs = createDailyJobs({ backups: env.service, clock: env.clock, hourUtc: 3, keepWeekly: 0, logger: createLogger({ level: "debug", redactor: createRedactor(), sink: env.sink }) });
    expect(await jobs.tick()).toBe("done");
    expect(env.service.list().map(row => ({ kind: row.kind, pruned: row.pruned_at !== null, verify: row.verify_result }))).toEqual([{ kind: "daily", pruned: false, verify: "ok" }]);
    expect(readdirSync(env.backupDir)).toHaveLength(1);
    // 下一周的周一同样记为 daily。
    env.clock.set(MONDAY + 7 * DAY + 4 * 3_600_000);
    expect(await jobs.tick()).toBe("done");
    expect(env.service.list().map(row => row.kind)).toEqual(["daily", "daily"]);
  });

  it("反例：刚做完的备份已被保留策略删掉时不做恢复校验，返回 failed 并记一条错误", async () => {
    const sink = memorySink();
    const verified: string[] = [];
    const record = { id: 9, kind: "daily", file: "geek-bot-daily-x.gbbk", created_at: MONDAY, pruned_at: MONDAY } as BackupRecord;
    const stub = {
      list: () => [],
      create: async () => record,
      verify: async (file: string | undefined) => {
        verified.push(file ?? "");
        return { ok: false, problems: ["这份备份已经按保留策略删除"], sha256: null, header: null, restored: null, file: file ?? "", backupId: 9 };
      },
    } as unknown as BackupService;
    const jobs = createDailyJobs({ backups: stub, clock: () => MONDAY + 4 * 3_600_000, hourUtc: 3, keepWeekly: 4, logger: createLogger({ level: "debug", redactor: createRedactor(), sink }) });
    expect(await jobs.tick()).toBe("failed");
    expect(verified).toEqual([]);
    expect(sink.lines().find(line => line.level === "error")).toMatchObject({ msg: "刚做完的备份已按保留策略删除，没有做恢复校验：核对备份保留份数的配置", backup_id: 9, file: record.file });
  });

  it("备份失败时写 critical 告警，下一次检查重试", async () => {
    const env = setup();
    const jobs = createDailyJobs({ backups: env.service, clock: env.clock, hourUtc: 3, keepWeekly: 4, logger: createLogger({ level: "fatal", redactor: createRedactor(), sink: env.sink }) });
    // 备份目录被一个普通文件占住，建不了目录也写不进去。
    writeFileSync(env.backupDir, "blocked");
    expect(await jobs.tick()).toBe("failed");
    expect(env.alerts.open("backup_failed")).toMatchObject([{ severity: "critical", subject: "backup/weekly" }]);
  });
});
