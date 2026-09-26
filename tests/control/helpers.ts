/**
 * control 测试的公共夹具：临时目录、临时密钥文件、内存日志、假时钟、临时迁移目录。
 * 全部在系统临时目录里，不读 .env、不碰仓库里的文件、不联网；密钥是每次随机生成的。
 */
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS_DIR } from "../../app/control/src/db/migrator.js";
import type { LogSink } from "../../app/control/src/log/logger.js";

const created: string[] = [];

/** 新建临时目录；cleanupTempDirs() 统一删除。 */
export function tempDir(prefix = "geek-bot-control-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  while (created.length > 0) rmSync(created.pop() as string, { recursive: true, force: true });
}

/** 写一把随机的 32 字节密钥（base64），返回文件路径和原文。 */
export function writeKey(dir: string, name: string, mode = 0o600): { path: string; text: string } {
  const text = `${randomBytes(32).toString("base64")}\n`;
  const path = join(dir, name);
  writeFileSync(path, text, { mode });
  return { path, text };
}

export interface Fixture {
  readonly dir: string;
  readonly dbPath: string;
  readonly backupDir: string;
  readonly masterKey: { path: string; text: string };
  readonly backupKey: { path: string; text: string };
  readonly env: Record<string, string>;
}

/** 一套本机可用的配置：preview 角色、回环地址、库和密钥都在临时目录里。 */
export function fixture(): Fixture {
  const dir = tempDir();
  const secrets = join(dir, "secrets");
  mkdirSync(secrets, { mode: 0o700 });
  const masterKey = writeKey(secrets, "master_key");
  const backupKey = writeKey(secrets, "backup_key");
  const dbPath = join(dir, "data", "geek-bot.db");
  return {
    dir,
    dbPath,
    backupDir: join(dir, "data", "backups"),
    masterKey,
    backupKey,
    env: {
      GEEK_BOT_INSTANCE_ROLE: "preview",
      GEEK_BOT_HOST: "127.0.0.1",
      GEEK_BOT_DB_PATH: dbPath,
      GEEK_BOT_MASTER_KEY_FILE: masterKey.path,
      GEEK_BOT_BACKUP_KEY_FILE: backupKey.path,
      GEEK_BOT_LOG_LEVEL: "debug",
    },
  };
}

/** 收集日志行的输出，lines() 返回解析后的 JSON，text() 返回原文。 */
export function memorySink(): LogSink & { lines(): Array<Record<string, unknown>>; text(): string } {
  const chunks: string[] = [];
  return {
    write: line => void chunks.push(line),
    text: () => chunks.join(""),
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter(Boolean)
        .map(line => JSON.parse(line) as Record<string, unknown>),
  };
}

/** 可以手动拨动的时钟（毫秒）。 */
export function fakeClock(start: number): (() => number) & { set(ms: number): void; advance(ms: number): void } {
  let now = start;
  const clock = (() => now) as (() => number) & { set(ms: number): void; advance(ms: number): void };
  clock.set = ms => {
    now = ms;
  };
  clock.advance = ms => {
    now += ms;
  };
  return clock;
}

/** 代码自带的迁移文件名，按编号排序。 */
export function realMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter(name => name.endsWith(".sql")).sort();
}

/**
 * 模拟某一版代码的迁移目录：复制代码自带的前 upTo 个迁移（默认全部），再按编号往后追加 extra 里的迁移。
 * 追加的文件名是 NNNN_<slug>.sql，编号接在复制的最后一个之后，所以以后加了真实迁移也不会撞号。
 */
export function migrationSet(extra: ReadonlyArray<{ slug: string; sql: string }> = [], upTo = Number.POSITIVE_INFINITY): string {
  const dir = tempDir("geek-bot-migrations-");
  const base = realMigrations().slice(0, upTo);
  for (const name of base) copyFileSync(join(MIGRATIONS_DIR, name), join(dir, name));
  extra.forEach(({ slug, sql }, index) => writeFileSync(join(dir, `${String(base.length + index + 1).padStart(4, "0")}_${slug}.sql`), sql));
  return dir;
}

/** 下一版代码的一个只扩不缩迁移：加一张表、给 settings 加一个可空列。 */
export const EXPAND_NEXT = {
  slug: "add_notes",
  sql: ["-- geek-bot-migration shrink=false", "CREATE TABLE notes_next (id INTEGER PRIMARY KEY, body TEXT NOT NULL);", "ALTER TABLE settings ADD COLUMN note TEXT;", ""].join("\n"),
};

/** 下一版代码的一个收缩类迁移（要有 ADR 批准）：抬高兼容版本。 */
export const SHRINK_NEXT = {
  slug: "shrink_example",
  sql: ["-- geek-bot-migration shrink=true", "CREATE TABLE shrunk_next (id INTEGER PRIMARY KEY);", ""].join("\n"),
};
