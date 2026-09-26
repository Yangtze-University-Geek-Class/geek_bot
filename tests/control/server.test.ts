import { EventEmitter } from "node:events";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../app/control/src/app.js";
import { openCopy, openDatabase } from "../../app/control/src/db/database.js";
import { createLogger } from "../../app/control/src/log/logger.js";
import { createRedactor } from "../../app/control/src/log/redact.js";
import type { ReadinessCheck } from "../../app/control/src/routes/health/contracts.js";
import { ControlStartupError, installSignalHandlers, startControl, type ControlHandle, type StartOptions } from "../../app/control/src/services.js";
import { cleanupTempDirs, EXPAND_NEXT, fixture, memorySink, migrationSet, realMigrations, SHRINK_NEXT, type Fixture } from "./helpers.js";

const handles: ControlHandle[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.shutdown("test_cleanup").catch(() => undefined);
  cleanupTempDirs();
});

async function start(fx: Fixture, extra: Partial<StartOptions> = {}): Promise<ControlHandle> {
  const handle = await startControl({ env: fx.env, sink: memorySink(), dailyJobs: false, opsChannel: false, port: 0, ...extra });
  handles.push(handle);
  return handle;
}

async function startupError(options: StartOptions): Promise<ControlStartupError> {
  try {
    const handle = await startControl(options);
    handles.push(handle);
  } catch (error) {
    expect(error).toBeInstanceOf(ControlStartupError);
    return error as ControlStartupError;
  }
  throw new Error("预期拒绝启动，实际启动成功");
}

describe("健康检查（A-53、A-54）", () => {
  it("/healthz 与 /readyz 返回 200；每个响应带服务端生成的 X-Request-Id；未知路径按统一错误格式 404", async () => {
    const handle = await start(fixture());
    const healthz = await handle.app.inject({ method: "GET", url: "/healthz", headers: { "x-request-id": "attacker-chosen" } });
    expect(healthz.statusCode).toBe(200);
    expect(healthz.json()).toEqual({ status: "ok" });
    expect(healthz.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    const readyz = await handle.app.inject({ method: "GET", url: "/readyz" });
    expect(readyz.statusCode).toBe(200);
    expect(readyz.json()).toEqual({ status: "ready" });
    const missing = await handle.app.inject({ method: "GET", url: "/api/v1/nope" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: { code: "not_found", message: "没有这个接口" } });
    expect(missing.headers["x-request-id"]).toBeTruthy();
  });

  it("/readyz 未就绪时 503，message 列出没通过的检查项名称，不含路径和密钥", async () => {
    const fx = fixture();
    const handle = await start(fx);
    rmSync(fx.masterKey.path);
    const response = await handle.app.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: { code: "not_ready", message: "未就绪，没通过的检查项：secrets_readable" } });
    expect(response.body).not.toContain(fx.masterKey.path);
    expect(response.body).not.toContain(fx.backupKey.text.trim());
  });

  it("停机开始后新请求一律 503 not_ready；/readyz 列出没通过的 serving", async () => {
    let stopping = false;
    const failed: ReadinessCheck[] = [];
    const app = buildApp({ logger: createLogger({ level: "fatal", redactor: createRedactor(), sink: memorySink() }), readiness: { failedChecks: () => failed }, shuttingDown: () => stopping });
    expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
    failed.push("serving");
    expect((await app.inject({ method: "GET", url: "/readyz" })).json()).toEqual({ error: { code: "not_ready", message: "未就绪，没通过的检查项：serving" } });
    stopping = true;
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: { code: "not_ready", message: "control 正在停机" } });
    expect(response.headers["x-request-id"]).toBeTruthy();
    await app.close();
  });

  it("入参校验：多余字段 400（不静默删除）、非 JSON 请求体 415、坏 JSON 400、超过 64 KB 413（用测试路由核对全局设置）", async () => {
    const handle = await start(fixture());
    handle.app.post(
      "/api/v1/__schema_probe",
      { schema: { body: { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string", maxLength: 10 } } } } },
      async request => ({ echoed: request.body }),
    );
    const post = (payload: string, contentType = "application/json") => handle.app.inject({ method: "POST", url: "/api/v1/__schema_probe", payload, headers: { "content-type": contentType } });
    const extra = await post(JSON.stringify({ name: "a", secret_value: "should-not-echo" }));
    expect(extra.statusCode).toBe(400);
    expect(extra.json()).toEqual({ error: { code: "validation_failed", message: "请求体里有不认识的字段：/secret_value" } });
    expect((await post(JSON.stringify({}))).json().error.message).toBe("请求体缺少必填字段：/name");
    expect((await post("name=a", "text/plain")).json()).toEqual({ error: { code: "unsupported_media_type", message: "请求体必须是 application/json" } });
    expect((await post("{not json")).json()).toEqual({ error: { code: "invalid_json", message: "请求体不是合法的 JSON" } });
    const big = await post(JSON.stringify({ name: "x".repeat(70 * 1024) }));
    expect(big.statusCode).toBe(413);
    expect(big.json().error.code).toBe("payload_too_large");
    const ok = await post(JSON.stringify({ name: "a" }));
    expect(ok.json()).toEqual({ echoed: { name: "a" } });
  });

  it("未预期的错误只回「内部错误」和请求 id，不带堆栈；日志里有错误且打码", async () => {
    const sink = memorySink();
    const handle = await start(fixture(), { sink });
    const token = `ghp_${"Q1w2E3r4T5y6U7i8O9p0".repeat(2)}`;
    handle.app.get("/api/v1/__boom", async () => {
      throw new Error(`upstream said ${token}`);
    });
    const response = await handle.app.inject({ method: "GET", url: "/api/v1/__boom?code=abc" });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: { code: "internal_error", message: `内部错误（请求 id ${response.headers["x-request-id"]}）` } });
    expect(sink.text()).not.toContain(token);
    const logged = sink.lines();
    expect(logged.some(line => line.msg === "未预期的错误" && (line.err as { message: string }).message === "upstream said ghp_[REDACTED]")).toBe(true);
    // 访问日志的路径去掉了查询串。
    expect(logged.some(line => line.msg === "请求完成" && line.path === "/api/v1/__boom" && line.status === 500)).toBe(true);
    expect(sink.text()).not.toContain("code=abc");
  });
});

describe("启动检查", () => {
  it("空库首次启动：执行全部迁移，不做迁移前备份，审计记下每个迁移", async () => {
    const handle = await start(fixture());
    expect(handle.migrations).toMatchObject({ before: { userVersion: 0, compatVersion: 0 }, applied: realMigrations(), preMigrationBackup: null, databaseNewer: false });
    expect(handle.db.prepare("SELECT action, target FROM audit_logs WHERE action = 'migration.apply' ORDER BY id").all()).toEqual(
      realMigrations().map(name => ({ action: "migration.apply", target: `migration/${name.slice(0, 4)}` })),
    );
    expect(handle.backups.list()).toEqual([]);
  });

  it("删掉 master key 文件后拒绝启动；报错说明变量名和路径，日志和报错里都没有任何密钥内容", async () => {
    const fx = fixture();
    const masterText = fx.masterKey.text.trim();
    rmSync(fx.masterKey.path);
    const sink = memorySink();
    const error = await startupError({ env: fx.env, sink, dailyJobs: false, opsChannel: false });
    expect(error.problems).toEqual([`GEEK_BOT_MASTER_KEY_FILE 指向的密钥文件不存在：${fx.masterKey.path}`]);
    const fatal = sink.lines().find(line => line.level === "fatal");
    expect(fatal?.msg).toBe(`control 拒绝启动：GEEK_BOT_MASTER_KEY_FILE 指向的密钥文件不存在：${fx.masterKey.path}`);
    for (const text of [error.message, sink.text()]) {
      expect(text).not.toContain(masterText);
      expect(text).not.toContain(fx.backupKey.text.trim());
    }
    expect(existsSync(fx.dbPath)).toBe(false);
  });

  it("反例：把密钥原文误填进 *_KEY_FILE 时拒绝启动，fatal 日志和报错里都搜不到这串值", async () => {
    const fx = fixture();
    for (const name of ["GEEK_BOT_MASTER_KEY_FILE", "GEEK_BOT_BACKUP_KEY_FILE"] as const) {
      const pasted = (name === "GEEK_BOT_MASTER_KEY_FILE" ? fx.masterKey : fx.backupKey).text.trim();
      const sink = memorySink();
      const error = await startupError({ env: { ...fx.env, [name]: pasted }, cwd: fx.dir, sink, dailyJobs: false, opsChannel: false });
      for (const text of [error.message, JSON.stringify(error.problems), sink.text()]) {
        expect(text).not.toContain(pasted);
        expect(text).not.toContain(pasted.slice(0, 16));
      }
      expect(error.problems).toEqual([expect.stringContaining(`${name} 只接受密钥文件的路径`)]);
      expect(sink.lines().find(line => line.level === "fatal")?.msg).toBe(error.message);
    }
    expect(existsSync(fx.dbPath)).toBe(false);
  });

  it("密钥文件格式不对、两把密钥相同都拒绝启动；报错不回显文件内容", async () => {
    const fx = fixture();
    const junk = "this-is-not-a-valid-key-but-looks-secret-9f8e7d6c5b4a";
    writeFileSync(fx.masterKey.path, junk);
    const sink = memorySink();
    const error = await startupError({ env: fx.env, sink, dailyJobs: false, opsChannel: false });
    expect(error.problems[0]).toContain("GEEK_BOT_MASTER_KEY_FILE 指向的文件不是 32 字节密钥");
    expect(error.message).not.toContain(junk);
    expect(sink.text()).not.toContain(junk);

    const same = fixture();
    writeFileSync(same.masterKey.path, same.backupKey.text);
    expect((await startupError({ env: same.env, sink: memorySink(), dailyJobs: false, opsChannel: false })).problems).toEqual([
      "master key 与备份加密密钥是同一把密钥：两者必须各自独立生成",
    ]);
  });

  it("配置不合法（没配实例角色）拒绝启动，一次列出全部问题", async () => {
    const fx = fixture();
    const env: Record<string, string> = { ...fx.env, GEEK_BOT_PORT: "abc" };
    delete env.GEEK_BOT_INSTANCE_ROLE;
    const error = await startupError({ env, sink: memorySink(), dailyJobs: false, opsChannel: false });
    expect(error.problems).toHaveLength(2);
    expect(error.problems.join("\n")).toContain("GEEK_BOT_INSTANCE_ROLE 必须显式配置");
  });

  it("库的兼容版本高于代码时拒绝启动，并给出明确提示；日志里记 fatal", async () => {
    const fx = fixture();
    const newer = await start(fx, { migrationsDir: migrationSet([SHRINK_NEXT]) });
    await newer.shutdown("upgrade_done");
    const sink = memorySink();
    const error = await startupError({ env: fx.env, sink, dailyJobs: false, opsChannel: false, migrationsDir: migrationSet() });
    const current = realMigrations().length;
    expect(error.message).toContain(`库的兼容版本是 ${current + 1}，高于这版代码认识的最高迁移编号 ${current}`);
    expect(error.message).toContain("请部署更新的镜像，或者从那次收缩迁移之前的备份恢复");
    expect(sink.lines().find(line => line.level === "fatal")?.msg).toBe(error.message);
  });

  it("迁移前生成备份：有待执行的迁移时先做 pre_migration 备份，备份里是迁移前的库", async () => {
    const fx = fixture();
    const old = await start(fx);
    old.db.prepare("INSERT INTO settings (key, value_json, updated_at) VALUES ('pause.writes', '{}', 1)").run();
    await old.shutdown("upgrade");

    const upgraded = await start(fx, { migrationsDir: migrationSet([EXPAND_NEXT]) });
    const current = realMigrations().length;
    expect(upgraded.migrations.applied).toEqual([`${String(current + 1).padStart(4, "0")}_add_notes.sql`]);
    expect(upgraded.migrations.preMigrationBackup).toMatch(/^geek-bot-pre_migration-.*\.gbbk$/);
    const [record] = upgraded.backups.list();
    expect(record).toMatchObject({ kind: "pre_migration", schema_version: current, compat_version: 0, file: upgraded.migrations.preMigrationBackup });
    expect(JSON.parse(record?.row_counts_json ?? "{}")).toMatchObject({ settings: 1 });
    // 备份早于迁移：备份里的库还没有新表，而运行中的库已经迁到新版本。
    const report = await upgraded.backups.verify(record?.file, { type: "system" });
    expect(report.ok).toBe(true);
    expect(report.restored?.schemaVersion).toBe(current);
    expect(report.restored?.rowCounts).not.toHaveProperty("notes_next");
    expect(upgraded.db.pragma("user_version", { simple: true })).toBe(current + 1);
  });

  it("下一版给 backups 加了列时，迁移前备份照样写得进登记（备份服务只用 0001 就有的列）", async () => {
    const fx = fixture();
    await (await start(fx)).shutdown("upgrade");
    const next = migrationSet([{ slug: "backups_offsite", sql: "-- geek-bot-migration shrink=false\nALTER TABLE backups ADD COLUMN offsite_at INTEGER;\n" }]);
    const upgraded = await start(fx, { migrationsDir: next });
    expect(upgraded.migrations.preMigrationBackup).toMatch(/^geek-bot-pre_migration-.*\.gbbk$/);
    const manual = await upgraded.backups.create("manual", { type: "cli" });
    expect(upgraded.db.prepare("SELECT kind, offsite_at FROM backups ORDER BY id").all()).toEqual([
      { kind: "pre_migration", offsite_at: null },
      { kind: "manual", offsite_at: null },
    ]);
    expect((await upgraded.backups.verify(manual.file, { type: "cli" })).ok).toBe(true);
  });

  it("迁移前备份失败时不执行迁移，拒绝启动", async () => {
    const fx = fixture();
    await (await start(fx)).shutdown("upgrade");
    rmSync(fx.backupDir, { recursive: true });
    writeFileSync(fx.backupDir, "not a directory");
    const error = await startupError({ env: fx.env, sink: memorySink(), dailyJobs: false, opsChannel: false, migrationsDir: migrationSet([EXPAND_NEXT]) });
    expect(error.message).toContain("迁移前备份失败，没有执行迁移");
    rmSync(fx.backupDir);
    const check = openDatabase(fx.dbPath);
    expect(check.pragma("user_version", { simple: true })).toBe(realMigrations().length);
    check.close();
  });

  it("上一版代码打开只扩不缩迁移之后的新库：能启动、/readyz 200、能读写；新代码再读得到旧代码写的行", async () => {
    const fx = fixture();
    const next = migrationSet([EXPAND_NEXT]);
    const newer = await start(fx, { migrationsDir: next });
    newer.db.prepare("INSERT INTO notes_next (body) VALUES ('written by new code')").run();
    newer.db.prepare("INSERT INTO settings (key, value_json, updated_at, note) VALUES ('review.own_prs', 'false', 1, 'new column')").run();
    await newer.shutdown("rollback");

    const previous = await start(fx, { migrationsDir: migrationSet() });
    expect(previous.migrations).toMatchObject({ applied: [], databaseNewer: true, preMigrationBackup: null });
    const readyz = await previous.app.inject({ method: "GET", url: "/readyz" });
    expect(readyz.statusCode).toBe(200);
    previous.db.prepare("INSERT INTO settings (key, value_json, updated_at) VALUES ('pause.global', '{}', 2)").run();
    expect(previous.db.prepare("SELECT key FROM settings ORDER BY key").all()).toEqual([{ key: "pause.global" }, { key: "review.own_prs" }]);
    const backup = await previous.backups.create("manual", { type: "cli" });
    expect(backup.schema_version).toBe(realMigrations().length + 1);
    expect((await previous.backups.verify(backup.file, { type: "cli" })).ok).toBe(true);
    await previous.shutdown("roll_forward");

    const again = await start(fx, { migrationsDir: next });
    expect(again.migrations.applied).toEqual([]);
    expect(again.db.prepare("SELECT key, note FROM settings ORDER BY key").all()).toEqual([
      { key: "pause.global", note: null },
      { key: "review.own_prs", note: "new column" },
    ]);
    expect(again.db.prepare("SELECT body FROM notes_next").all()).toEqual([{ body: "written by new code" }]);
  });

  it("反例：启动时清空 <dataDir>/tmp 并收紧到 0700，上次崩溃留下的明文临时文件不会留下", async () => {
    const fx = fixture();
    await (await start(fx)).shutdown("crash_simulated");
    const tmp = join(fx.dir, "data", "tmp");
    mkdirSync(join(tmp, "restore-abc"), { recursive: true });
    writeFileSync(join(tmp, ".tmp-0123456789ab.sqlite"), "plaintext left by a crash");
    writeFileSync(join(tmp, "restore-abc", "x.sqlite"), "plaintext");
    chmodSync(tmp, 0o755);
    const sink = memorySink();
    await start(fx, { sink });
    expect(readdirSync(tmp)).toEqual([]);
    expect(statSync(tmp).mode & 0o777).toBe(0o700);
    expect(sink.lines().find(line => line.msg === "清掉了上次崩溃留在临时目录里的明文文件")).toMatchObject({ level: "warn", removed: 2 });
  });

  it("单写者：control 运行时同一个库的第二个 control 拒绝启动", async () => {
    const fx = fixture();
    await start(fx);
    const error = await startupError({ env: fx.env, sink: memorySink(), dailyJobs: false, opsChannel: false });
    expect(error.message).toContain("库正被另一个进程占用");
  });
});

describe("优雅停机", () => {
  it("SIGTERM 后 WAL 已 checkpoint：只拷走库文件本身（不带 -wal）也能读到停机前写入的行", async () => {
    const fx = fixture();
    const sink = memorySink();
    const handle = await startControl({ env: fx.env, sink, dailyJobs: false, opsChannel: true, port: 0 });
    await handle.listen();
    const insert = handle.db.prepare("INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)");
    for (let i = 0; i < 50; i += 1) insert.run(`test.key.${i}`, JSON.stringify({ i }), i);
    const wal = `${fx.dbPath}-wal`;
    expect(statSync(wal).size).toBeGreaterThan(0);

    const signals = new EventEmitter();
    const exited = new Promise<number>(resolve => installSignalHandlers(signals as never, handle, resolve));
    signals.emit("SIGTERM");
    expect(await exited).toBe(0);

    expect(handle.db.open).toBe(false);
    expect(!existsSync(wal) || statSync(wal).size === 0).toBe(true);
    const copy = join(fx.dir, "copy-without-wal.sqlite");
    copyFileSync(fx.dbPath, copy);
    const db = openCopy(copy);
    expect((db.prepare("SELECT count(*) AS n FROM settings WHERE key LIKE 'test.key.%'").get() as { n: number }).n).toBe(50);
    db.close();
    const done = sink.lines().find(line => line.msg === "WAL 已 checkpoint，库已关闭");
    expect(done).toMatchObject({ busy: 0 });
    expect(existsSync(join(fx.dir, "data", "run", "control.sock"))).toBe(false);
  });

  it("重复收到信号只停机一次；停机出错以 1 退出", async () => {
    const handle = await start(fixture());
    const first = handle.shutdown("a");
    expect(handle.shutdown("b")).toBe(first);
    await first;
    const signals = new EventEmitter();
    const failing = { logger: handle.logger, shutdown: () => Promise.reject(new Error("disk gone")) };
    const exited = new Promise<number>(resolve => installSignalHandlers(signals as never, failing, resolve));
    signals.emit("SIGINT");
    expect(await exited).toBe(1);
  });
});
