// 发布 tag 的语法与只读 Git 查询（发版只靠打 tag，见 docs/conventions/RELEASES.md）。
//
// 发布 tag 只有两种（SemVer 写法）：
//   vX.Y.Z-rc.N  预发布（N ≥ 1）：提交必须在 stage 上 → 预发布实例（preview）
//   vX.Y.Z       正式：提交必须在 main 上 → 正式实例（production）
// X.Y.Z 必须等于该提交里根 package.json 的 version。
//
// 本模块是纯库：不创建 tag、不写文件、不 fetch、不连远端。check-branch-invariants.mjs 用它判定 tag 推送；
// 部署规划（release-policy.mjs，计划中，见 #7）以后也从这里取同一份语法，不再各写一份。

import { spawnSync } from "node:child_process";

/** 发布 tag 的唯一正则：RELEASES.md 的 tag 表逐字引用它（tests/tooling/release-tags.test.ts 核对两处一致）。 */
export const RELEASE_TAG_RE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-rc\.([1-9]\d*))?$/;
/** tag 种类 → 环境与提交必须所在的长期分支。 */
export const TAG_KINDS = Object.freeze({
  rc: Object.freeze({ environment: "preview", branch: "stage" }),
  final: Object.freeze({ environment: "production", branch: "main" }),
});
const VERSION_RE = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;

function git(repo, args) {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 20000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw new Error(`无法执行 git ${args.join(" ")}：${result.error.message}`);
  return result;
}

/**
 * 解析发布 tag；不合规返回 null（调用方决定报错措辞）。
 * @param {unknown} tag
 * @returns {{ tag: string, kind: "rc" | "final", version: string, rc: number | null, environment: string, branch: string } | null}
 */
export function parseReleaseTag(tag) {
  if (typeof tag !== "string") return null;
  const match = RELEASE_TAG_RE.exec(tag);
  if (!match) return null;
  const kind = match[5] ? "rc" : "final";
  return {
    tag,
    kind,
    version: `${match[1]}.${match[2]}.${match[3]}`,
    rc: match[5] ? Number(match[5]) : null,
    ...TAG_KINDS[kind],
  };
}

/** 读取某个提交里根 package.json 的 version（不看工作区，避免未提交改动冒充发布版本）。 */
export function packageVersionAt(repo, commit) {
  const result = git(repo, ["show", `${commit}:package.json`]);
  if (result.status !== 0) throw new Error(`提交 ${commit.slice(0, 12)} 里读不到根 package.json`);
  let manifest;
  try {
    manifest = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`提交 ${commit.slice(0, 12)} 的 package.json 不是合法 JSON：${error.message}`);
  }
  const version = manifest?.version;
  if (typeof version !== "string" || !VERSION_RE.test(version)) {
    throw new Error(`提交 ${commit.slice(0, 12)} 的 package.json version 必须是 X.Y.Z：${version}`);
  }
  return version;
}

/** 列出本地所有 tag 与它们最终指向的提交（附注 tag 取剥开后的对象）。 */
export function listTagCommits(repo) {
  const result = git(repo, ["for-each-ref", "--format=%(refname:strip=2)%09%(objectname)%09%(*objectname)", "refs/tags"]);
  if (result.status !== 0) throw new Error(`无法枚举 tag：${(result.stderr ?? "").trim()}`);
  return (result.stdout ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, object, peeled] = line.split("\t");
      return { name, commit: peeled || object };
    });
}

/** 同一提交上、同一 X.Y.Z 的预发布 tag（按 N 升序）：正式发布前必须至少有一个。 */
export function previewTagsFor(repo, version, commit) {
  return listTagCommits(repo)
    .map((entry) => ({ ...entry, release: parseReleaseTag(entry.name) }))
    .filter((entry) => entry.release?.kind === "rc" && entry.release.version === version && entry.commit === commit)
    .sort((left, right) => left.release.rc - right.release.rc)
    .map((entry) => entry.name);
}
