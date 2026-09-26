#!/usr/bin/env node
// 构建的最后一步：把 src/db/migrations/*.sql 复制到 dist/db/migrations/（tsc 只输出 .js）。
// 运行时迁移器按 import.meta.url 找同目录下的 migrations/，源码与构建产物各用各的一份。
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "src", "db", "migrations");
const to = join(root, "dist", "db", "migrations");

rmSync(to, { recursive: true, force: true });
mkdirSync(to, { recursive: true });
const files = readdirSync(from).filter(name => name.endsWith(".sql")).sort();
for (const name of files) copyFileSync(join(from, name), join(to, name));
console.log(`已复制 ${files.length} 个迁移文件到 dist/db/migrations/`);
