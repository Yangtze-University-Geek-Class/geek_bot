#!/usr/bin/env node
// 运行时基线：Node 22 且不低于 22.13（与 .nvmrc、.node-version、根 package.json 的 engines 一致）。
//
//   node scripts/check-runtime.mjs
import { isDirectRun, parseFlags, runCli } from "./lib/cli.mjs";

const USAGE = "用法：node scripts/check-runtime.mjs\n  断言当前 Node 是 22 且不低于 22.13；不接受其它参数。";

/** @param {string} version process.versions.node 形式的版本号 */
export function checkRuntime(version = process.versions.node) {
  const [major, minor] = version.split(".").map(Number);
  return major === 22 && minor >= 13;
}

function main(argv) {
  const { flags } = parseFlags(argv, { flags: ["--help", "-h"] });
  if (flags.has("--help") || flags.has("-h")) {
    console.log(USAGE);
    return;
  }
  if (!checkRuntime()) {
    console.error(`需要 Node 22 且不低于 22.13，当前是 ${process.version}。按 .nvmrc 切换版本，换版本后重新安装依赖。`);
    process.exitCode = 1;
    return;
  }
  console.log(`运行时基线通过：${process.version}`);
}

if (isDirectRun(import.meta.url)) runCli(main, USAGE);
