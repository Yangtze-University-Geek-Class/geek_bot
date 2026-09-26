#!/usr/bin/env node
// pnpm dev:control：本机开发用的 control（先由根脚本构建 protocol 与 control，再运行这里）。
//
// - 库、备份、本地通道放在仓库根的 data/（已被 .gitignore 忽略）；
// - 第一次运行时在 data/dev-secrets/ 生成本机用的一次性 master key 与备份加密密钥（权限 0600），
//   它们不是任何实例的密钥，删掉 data/ 就一起没了；
// - 默认实例角色 preview、只绑回环地址 127.0.0.1:8080、日志级别 debug；环境变量里已经设置的值优先。
//
// control 在子进程里运行构建后的 dist/index.js：Ctrl-C 由终端直接发给子进程，SIGTERM 转发给它，
// 两者都触发 control 的优雅停机；本进程随子进程的退出码退出。
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(packageDir, "..", "..");
const dataDir = join(repoRoot, "data");
const secretsDir = join(dataDir, "dev-secrets");

/** 本机用的一次性密钥：已有就沿用，没有才生成。 */
function devKey(name) {
  const path = join(secretsDir, name);
  if (!existsSync(path)) writeFileSync(path, `${randomBytes(32).toString("base64")}\n`, { mode: 0o600, flag: "wx" });
  return path;
}

// 仓库根的 .env.local（从 .env.example 复制，已被忽略）有就先读进来。
const localEnv = join(repoRoot, ".env.local");
if (existsSync(localEnv)) process.loadEnvFile(localEnv);

mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
const env = {
  GEEK_BOT_INSTANCE_ROLE: "preview",
  GEEK_BOT_HOST: "127.0.0.1",
  GEEK_BOT_PORT: "8080",
  GEEK_BOT_DB_PATH: join(dataDir, "geek-bot.db"),
  GEEK_BOT_MASTER_KEY_FILE: devKey("master_key"),
  GEEK_BOT_BACKUP_KEY_FILE: devKey("backup_key"),
  GEEK_BOT_LOG_LEVEL: "debug",
};
// 环境变量里有值的项优先；留空的项不覆盖上面的本机默认值。
for (const [name, value] of Object.entries(process.env)) if (value !== undefined && value !== "") env[name] = value;

const child = spawn(process.execPath, [join(packageDir, "dist", "index.js")], { stdio: "inherit", env });
process.on("SIGINT", () => {});
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
