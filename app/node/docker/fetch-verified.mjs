#!/usr/bin/env node
/**
 * 镜像构建用的下载器：只用 Node 标准库（slim 基础镜像里没有 curl），边下载边算摘要，摘要与钉死的值不符时删掉文件并以 1 退出。
 *
 *   node fetch-verified.mjs <https URL> <sha256|sha512> <十六进制摘要> <输出路径>
 */
import { createHash } from "node:crypto";
import { createWriteStream, rmSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const [url, algorithm, expected, output] = process.argv.slice(2);
if (!url || !/^https:\/\//.test(url) || !["sha256", "sha512"].includes(algorithm) || !/^[0-9a-f]+$/.test(expected ?? "") || !output) {
  process.stderr.write("用法：node fetch-verified.mjs <https URL> <sha256|sha512> <十六进制摘要> <输出路径>\n");
  process.exit(2);
}

const hash = createHash(algorithm);
try {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`);
  const source = Readable.fromWeb(response.body);
  source.on("data", chunk => hash.update(chunk));
  await pipeline(source, createWriteStream(output, { mode: 0o644 }));
  const actual = hash.digest("hex");
  if (actual !== expected) throw new Error(`${algorithm} 不符：期望 ${expected}，实际 ${actual}`);
  process.stdout.write(`已校验 ${output}（${algorithm} ${actual}）\n`);
} catch (error) {
  rmSync(output, { force: true });
  process.stderr.write(`${url}：${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
