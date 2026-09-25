// 入口回归：脚本经符号链接路径启动时必须真的执行。
//
// 旧写法 `resolve(process.argv[1]) === fileURLToPath(import.meta.url)` 在经链接启动时两边不相等
// （Node 按真实路径加载主模块，argv[1] 却是链接路径），脚本静默不执行、以 0 退出，门禁就会假绿。
// 所有 CLI 改用 scripts/lib/cli.mjs 的 isDirectRun（比较 realpath）。这里在临时目录建一个指向
// 仓库 scripts/ 的符号链接，逐个经链接路径启动。
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isDirectRun } from "../../scripts/lib/cli.mjs";

const scriptsDir = fileURLToPath(new URL("../../scripts", import.meta.url));
let temp = "";
let linked = "";

beforeAll(() => {
  temp = mkdtempSync(join(tmpdir(), "geek-bot-cli-entry-"));
  linked = join(temp, "scripts");
  symlinkSync(scriptsDir, linked, "dir");
});
afterAll(() => {
  if (temp) rmSync(temp, { recursive: true, force: true });
});

/** 经链接路径启动脚本；cwd 放在临时目录，确认不依赖从仓库根目录启动。 */
const viaLink = (script: string, ...args: string[]) =>
  spawnSync(process.execPath, [join(linked, script), ...args], { cwd: temp, encoding: "utf8", timeout: 60000 });

/** 仓库里全部命令行脚本（scripts/*.mjs 里带入口的那些）。 */
const CLIS = [
  "check-runtime.mjs",
  "docs-index.mjs",
  "check-docs.mjs",
  "check-boundaries.mjs",
  "check-secrets.mjs",
  "check-public-safety.mjs",
  "check-branch-invariants.mjs",
  "pr-contract.mjs",
  "task.mjs",
  "note.mjs",
  "tuffex-docs.mjs",
  "labels.mjs",
];

describe("isDirectRun", () => {
  it("链接路径与真实路径比较 realpath；argv[1] 缺失或指向别的文件时为 false", () => {
    const real = pathToFileURL(realpathSync(join(scriptsDir, "task.mjs"))).href;
    const link = join(linked, "task.mjs");
    // 前提：旧写法在这里确实会判错，本测试才有意义
    expect(pathToFileURL(resolve(link)).href).not.toBe(real);
    expect(isDirectRun(real, link)).toBe(true);
    expect(isDirectRun(real, join(scriptsDir, "task.mjs"))).toBe(true);
    expect(isDirectRun(real, join(linked, "pr-contract.mjs"))).toBe(false);
    expect(isDirectRun(real, join(temp, "missing.mjs"))).toBe(false);
    expect(isDirectRun(real, undefined)).toBe(false);
    expect(isDirectRun(real, "")).toBe(false);
  });

  it("被 import 时不执行：导入方的 argv[1] 不是脚本本身", () => {
    const probe = join(temp, "probe.mjs");
    writeFileSync(probe, `import ${JSON.stringify(pathToFileURL(join(scriptsDir, "task.mjs")).href)};\nconsole.log("imported");\n`);
    const result = spawnSync(process.execPath, [probe], { cwd: temp, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("imported");
    expect(result.stderr).toBe("");
  });
});

describe("经符号链接路径启动", () => {
  it.each(["task.mjs", "pr-contract.mjs", "note.mjs"])("%s 不带参数：打印用法到 stderr 并以非 0 退出", (script) => {
    const result = viaLink(script);
    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();
    expect(result.stderr).toContain(`用法：node scripts/${script}`);
  });

  it("check-boundaries.mjs 带不认识的参数：打印用法到 stderr 并以非 0 退出", () => {
    const result = viaLink("check-boundaries.mjs", "--no-such-flag");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("未知参数：--no-such-flag");
    expect(result.stderr).toContain("用法：node scripts/check-boundaries.mjs");
  });

  it("check-boundaries.mjs 不带参数：真的执行检查并给出结论，不静默退出 0", () => {
    const result = viaLink("check-boundaries.mjs");
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toMatch(/模块边界检查(?:通过|未通过)/);
    if (result.status === 0) expect(result.stdout).toContain("模块边界检查通过");
  });

  it.each(CLIS)("%s 带不认识的参数：用法写到 stderr，以非 0 退出", (script) => {
    const result = viaLink(script, "--no-such-flag");
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.status).not.toBeNull();
    expect(result.stderr).toContain("--no-such-flag");
    expect(result.stderr).toMatch(/用法：node scripts\//);
  });

  it.each(CLIS)("%s --help：打印用法并以 0 退出", (script) => {
    const result = viaLink(script, "--help");
    expect(result.status, result.stderr).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/用法|node scripts\//);
  });
});
