// 本仓库的规范独立完整，不引用、不依赖别的项目（ADR-0001，#26）。
// 已知的旧项目标识一旦出现在入库或未忽略的文件里（上游 Tuffex 快照除外）就失败，防止以后改规范时再混进来。
// 标识在运行时拼出来，本文件自己也在扫描范围里，不留明文。
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
/** 上游快照目录：内容是 Tuffex 原文，不属于本仓库的规范。 */
const UPSTREAM_SNAPSHOTS = ["docs/components/tuffex/reference/", "docs/components/tuffex/snapshot/"];
/** 旧项目的仓库名（两种写法）与旧规范的来源提交号。 */
const FORBIDDEN = [["geek", "main"].join("_"), ["geek", "main"].join("-"), ["0fa", "8dcc"].join("")];

function listFiles() {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter(Boolean)
    .filter((file) => !UPSTREAM_SNAPSHOTS.some((prefix) => file.startsWith(prefix)));
}

/** 一段文本里出现的旧标识（不分大小写）。 */
function hits(text: string) {
  const lower = text.toLowerCase();
  return FORBIDDEN.filter((word) => lower.includes(word));
}

describe("不引用别的项目", () => {
  it("扫描器本身能认出旧标识（大小写都算），也不误报普通文字", () => {
    expect(hits(`见 ${FORBIDDEN[0].toUpperCase()} 的规范`)).toEqual([FORBIDDEN[0]]);
    expect(hits(`来自 ${FORBIDDEN[1]} stage ${FORBIDDEN[2]}`)).toEqual([FORBIDDEN[1], FORBIDDEN[2]]);
    expect(hits("geek_bot 的 main 分支；geek-bot-control 镜像")).toEqual([]);
  });

  it("入库与未忽略的文件（上游快照除外）的路径和内容里没有旧项目名、旧仓库名和旧提交号", () => {
    const files = listFiles();
    expect(files.length).toBeGreaterThan(50);
    const found: string[] = [];
    for (const file of files) {
      for (const word of hits(file)) found.push(`${file}（路径）：${word}`);
      let stat;
      try {
        stat = lstatSync(join(ROOT, file));
      } catch {
        continue; // 已删除但还没提交删除的文件
      }
      if (stat.isSymbolicLink()) {
        for (const word of hits(readlinkSync(join(ROOT, file)))) found.push(`${file}（链接目标）：${word}`);
        continue;
      }
      if (!stat.isFile()) continue; // 子模块只看路径
      const text = readFileSync(join(ROOT, file), "utf8");
      text.split("\n").forEach((line, index) => {
        for (const word of hits(line)) found.push(`${file}:${index + 1}：${word}`);
      });
    }
    expect(found).toEqual([]);
  });
});
