import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../app/control/src/cli.js";
import { openDatabase } from "../../app/control/src/db/database.js";
import { startControl, type ControlHandle } from "../../app/control/src/services.js";
import { cleanupTempDirs, EXPAND_NEXT, fixture, memorySink, migrationSet, realMigrations, SHRINK_NEXT, type Fixture } from "./helpers.js";

const handles: ControlHandle[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.shutdown("test_cleanup").catch(() => undefined);
  cleanupTempDirs();
});

async function running(fx: Fixture, listen = true): Promise<ControlHandle> {
  const handle = await startControl({ env: fx.env, sink: memorySink(), dailyJobs: false, opsChannel: true, port: 0 });
  handles.push(handle);
  if (listen) await handle.listen();
  return handle;
}

async function cli(fx: Fixture, ...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, { env: fx.env, cwd: fx.dir, stdout: text => void (stdout += text), stderr: text => void (stderr += text) });
  return { code, stdout, stderr };
}

describe("CLI：backup、verify-backup（单写者：交给运行中的 control）", () => {
  it("control 在运行时经本地通道执行：备份记为 cli 操作，CLI 不开写连接", async () => {
    const fx = fixture();
    const handle = await running(fx);
    const backup = await cli(fx, "backup");
    expect(backup.code).toBe(0);
    expect(backup.stderr).toBe("");
    expect(backup.stdout).toMatch(/^备份完成\n {2}文件 geek-bot-manual-.*\.gbbk\n/);
    const [record] = handle.backups.list();
    expect(record).toMatchObject({ kind: "manual", schema_version: realMigrations().length });
    expect(handle.db.prepare("SELECT actor_type, action FROM audit_logs WHERE action = 'backup.create'").all()).toEqual([{ actor_type: "cli", action: "backup.create" }]);

    const deploy = await cli(fx, "backup", "--kind", "pre_deploy");
    expect(deploy.code).toBe(0);
    expect(handle.backups.list()[0]?.kind).toBe("pre_deploy");

    const verify = await cli(fx, "verify-backup", record?.file ?? "");
    expect(verify.code).toBe(0);
    expect(verify.stdout).toContain(`恢复校验通过：${record?.file}`);
    expect(verify.stdout).toContain("恢复出的库：user_version");
    expect(handle.db.prepare("SELECT verify_result FROM backups WHERE file = ?").get(record?.file)).toEqual({ verify_result: "ok" });
    const latest = await cli(fx, "verify-backup");
    expect(latest.code).toBe(0);
    expect(latest.stdout).toContain(handle.backups.list()[0]?.file ?? "missing");
  });

  it("恢复校验失败时以 1 退出，control 写 critical 告警", async () => {
    const fx = fixture();
    const handle = await running(fx);
    expect((await cli(fx, "backup")).code).toBe(0);
    const [record] = handle.backups.list();
    const path = join(fx.backupDir, record?.file ?? "");
    const bytes = readFileSync(path);
    bytes[bytes.length - 20] = (bytes[bytes.length - 20] as number) ^ 1;
    writeFileSync(path, bytes);
    const verify = await cli(fx, "verify-backup");
    expect(verify.code).toBe(1);
    expect(verify.stdout).toContain(`恢复校验失败：${record?.file}`);
    expect(verify.stdout).toContain("问题：备份文件的 sha256 与登记的不一致");
    expect(handle.db.prepare("SELECT kind, severity FROM alerts WHERE resolved_at IS NULL").all()).toEqual([{ kind: "backup_verify_failed", severity: "critical" }]);
  });

  it("control 没在运行时离线执行：独占打开库，做完关库", async () => {
    const fx = fixture();
    const handle = await running(fx, false);
    await handle.shutdown("stopped");
    const backup = await cli(fx, "backup");
    expect(backup.code).toBe(0);
    expect(backup.stderr).toContain("control 没有在运行");
    expect(backup.stderr).toContain("改为独占打开库在本进程里执行");
    const verify = await cli(fx, "verify-backup");
    expect(verify.code).toBe(0);
    const db = openDatabase(fx.dbPath);
    expect(db.prepare("SELECT kind, verify_result FROM backups").all()).toEqual([{ kind: "manual", verify_result: "ok" }]);
    db.close();
  });

  it("反例：库被别的连接独占、又没有本地通道时，离线执行拿不到锁而失败", async () => {
    const fx = fixture();
    const handle = await running(fx, false);
    await handle.shutdown("stopped");
    const holder = openDatabase(fx.dbPath);
    try {
      const backup = await cli(fx, "backup");
      expect(backup.code).toBe(1);
      expect(backup.stderr).toContain("库正被另一个进程占用");
    } finally {
      holder.close();
    }
  });

  it("反例：离线执行写库之前核对库版本：兼容版本高于 CLI、库比 CLI 新、库比 CLI 旧时都拒绝，库和备份目录不变", async () => {
    const current = realMigrations().length;
    const cases = [
      { control: migrationSet([SHRINK_NEXT]), cli: migrationSet(), expected: `库的兼容版本是 ${current + 1}，高于这版代码认识的最高迁移编号 ${current}` },
      { control: migrationSet([EXPAND_NEXT]), cli: migrationSet(), expected: `库执行到第 ${current + 1} 号迁移，比这版 CLI 认识的第 ${current} 号新` },
      { control: migrationSet(), cli: migrationSet([EXPAND_NEXT]), expected: `库执行到第 ${current} 号迁移，这版 CLI 认识到第 ${current + 1} 号：先用这版镜像启动一次 control 完成迁移` },
    ];
    for (const { control, cli: cliMigrations, expected } of cases) {
      const fx = fixture();
      const handle = await startControl({ env: fx.env, sink: memorySink(), dailyJobs: false, opsChannel: false, port: 0, migrationsDir: control });
      await handle.shutdown("stopped");
      const version = (() => {
        const db = openDatabase(fx.dbPath);
        try {
          return db.pragma("user_version", { simple: true });
        } finally {
          db.close();
        }
      })();
      for (const argv of [["backup"], ["verify-backup"]]) {
        let stderr = "";
        const code = await runCli(argv, { env: fx.env, cwd: fx.dir, migrationsDir: cliMigrations, stdout: () => undefined, stderr: text => void (stderr += text) });
        expect(code, `${argv[0]}：${expected}`).toBe(1);
        expect(stderr).toContain(expected);
        expect(stderr).toContain("拒绝离线执行");
      }
      const db = openDatabase(fx.dbPath);
      try {
        expect(db.pragma("user_version", { simple: true })).toBe(version);
        expect(db.prepare("SELECT count(*) AS n FROM backups").get()).toEqual({ n: 0 });
        expect(db.prepare("SELECT count(*) AS n FROM audit_logs WHERE action LIKE 'backup.%'").get()).toEqual({ n: 0 });
      } finally {
        db.close();
      }
      expect(readdirSync(fx.backupDir).filter(name => name.endsWith(".gbbk"))).toEqual([]);
    }
  });

  it("用法错误以 2 退出：不认识的命令、--kind 取值不对、verify-backup 给了路径", async () => {
    const fx = fixture();
    for (const argv of [["frobnicate"], [], ["backup", "--kind", "daily"], ["backup", "--unknown"], ["verify-backup", "../etc/passwd"], ["verify-backup", "a", "b"]]) {
      const result = await cli(fx, ...argv);
      expect(result.code, argv.join(" ")).toBe(2);
      expect(result.stderr).toContain("用法：geek-bot <命令>");
    }
    expect((await cli(fx, "help")).stdout).toContain("restore --dry-run <文件>");
  });
});

describe("CLI：restore --dry-run", () => {
  it("只做恢复校验并报告会恢复到哪个库版本和时间点，不改任何东西", async () => {
    const fx = fixture();
    const handle = await running(fx);
    expect((await cli(fx, "backup")).code).toBe(0);
    const [record] = handle.backups.list();
    const filesBefore = readdirSync(fx.backupDir).sort();
    const rowBefore = handle.db.prepare("SELECT * FROM backups").all();
    const auditBefore = handle.db.prepare("SELECT count(*) AS n FROM audit_logs").get();

    const result = await cli(fx, "restore", "--dry-run", record?.file ?? "");
    expect(result.code).toBe(0);
    const current = realMigrations().length;
    expect(result.stdout).toContain(`恢复演练（--dry-run）通过：${join(fx.backupDir, record?.file ?? "")}`);
    expect(result.stdout).toContain(`会恢复到：${new Date(record?.created_at ?? 0).toISOString()} 的库，user_version ${current}，兼容版本 0；这版代码认识到第 ${current} 号迁移`);
    expect(result.stdout).toContain("库版本与这版代码一致：可以直接启动");
    expect(result.stdout).toContain("没有改动任何文件");
    expect(readdirSync(fx.backupDir).sort()).toEqual(filesBefore);
    expect(handle.db.prepare("SELECT * FROM backups").all()).toEqual(rowBefore);
    expect(handle.db.prepare("SELECT count(*) AS n FROM audit_logs").get()).toEqual(auditBefore);

    // 用绝对路径指到备份目录以外的一份副本同样可以演练。
    const copy = join(fx.dir, "offsite.gbbk");
    writeFileSync(copy, readFileSync(join(fx.backupDir, record?.file ?? "")));
    expect((await cli(fx, "restore", "--dry-run", copy)).code).toBe(0);
  });

  it("反例：演练解密出的明文放在 <dataDir>/tmp，不用系统临时目录；做完不留", async () => {
    const fx = fixture();
    const handle = await running(fx);
    expect((await cli(fx, "backup")).code).toBe(0);
    const [record] = handle.backups.list();
    const saved = process.env.TMPDIR;
    // 系统临时目录不可用：修之前演练在这里建临时目录，会失败。
    process.env.TMPDIR = join(fx.dir, "no-such-system-tmp");
    let result;
    try {
      result = await cli(fx, "restore", "--dry-run", record?.file ?? "");
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const tmp = join(fx.dir, "data", "tmp");
    expect(statSync(tmp).mode & 0o777).toBe(0o700);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("反例：备份被改动时演练失败；没写 --dry-run 的正式恢复没有实现，以 2 退出", async () => {
    const fx = fixture();
    const handle = await running(fx);
    expect((await cli(fx, "backup")).code).toBe(0);
    const [record] = handle.backups.list();
    const path = join(fx.backupDir, record?.file ?? "");
    const bytes = readFileSync(path);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) ^ 1;
    writeFileSync(path, bytes);
    const failed = await cli(fx, "restore", "--dry-run", record?.file ?? "");
    expect(failed.code).toBe(1);
    expect(failed.stdout).toContain("问题：备份文件解密校验失败");
    const real = await cli(fx, "restore", record?.file ?? "");
    expect(real.code).toBe(2);
    expect(real.stderr).toContain("restore 目前只支持 --dry-run");
    expect((await cli(fx, "restore", "--dry-run")).code).toBe(2);
  });

  it("反例：把备份密钥原文误填进 GEEK_BOT_BACKUP_KEY_FILE 时各命令以 1 退出，stderr 里搜不到这串值", async () => {
    const fx = fixture();
    const pasted = fx.backupKey.text.trim();
    const env = { ...fx.env, GEEK_BOT_BACKUP_KEY_FILE: pasted };
    for (const argv of [["backup"], ["verify-backup"], ["restore", "--dry-run", "x.gbbk"]]) {
      let stdout = "";
      let stderr = "";
      const code = await runCli(argv, { env, cwd: fx.dir, stdout: text => void (stdout += text), stderr: text => void (stderr += text) });
      for (const text of [stdout, stderr]) {
        expect(text).not.toContain(pasted);
        expect(text).not.toContain(pasted.slice(0, 16));
      }
      expect(code, argv.join(" ")).toBe(1);
      expect(stderr).toContain("GEEK_BOT_BACKUP_KEY_FILE 只接受密钥文件的路径");
    }
  });

  it("备份密钥文件读不到时以 1 退出，报错只写变量名、不回显路径（与 control 的报错一致）", async () => {
    const fx = fixture();
    const env = { ...fx.env, GEEK_BOT_BACKUP_KEY_FILE: join(fx.dir, "missing_backup_key") };
    let stderr = "";
    const code = await runCli(["restore", "--dry-run", "x.gbbk"], { env, cwd: fx.dir, stdout: () => undefined, stderr: text => void (stderr += text) });
    expect(code).toBe(1);
    expect(stderr).toBe("GEEK_BOT_BACKUP_KEY_FILE 指向的密钥文件不存在：核对这个变量的值和密钥文件的挂载（报错里不回显路径）\n");
  });

  it("反例：以 / 开头、不带 = 的 43 位 base64 密钥原文填进 GEEK_BOT_BACKUP_KEY_FILE 时，各命令的输出里搜不到它", async () => {
    const fx = fixture();
    const pasted = `/${fx.backupKey.text.trim().slice(1, 43)}`;
    expect(pasted).toMatch(/^\/[A-Za-z0-9+/]{42}$/);
    const env = { ...fx.env, GEEK_BOT_BACKUP_KEY_FILE: pasted };
    for (const argv of [["backup"], ["verify-backup"], ["restore", "--dry-run", "x.gbbk"]]) {
      let stdout = "";
      let stderr = "";
      const code = await runCli(argv, { env, cwd: fx.dir, stdout: text => void (stdout += text), stderr: text => void (stderr += text) });
      for (const text of [stdout, stderr]) {
        expect(text).not.toContain(pasted);
        expect(text).not.toContain(pasted.slice(1, 17));
      }
      expect(code, argv.join(" ")).toBe(1);
      expect(stderr).toContain("GEEK_BOT_BACKUP_KEY_FILE 指向的密钥文件不存在：核对这个变量的值和密钥文件的挂载（报错里不回显路径）");
    }
  });
});
