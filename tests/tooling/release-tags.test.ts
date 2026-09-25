import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { RELEASE_TAG_RE, TAG_KINDS, listTagCommits, packageVersionAt, parseReleaseTag, previewTagsFor } from "../../scripts/release-tags.mjs";

// 夹具全部是临时目录里合成的假仓库；从不改动本仓库的分支、tag 或工作区。
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false", "-c", "user.name=Release fixture", "-c", "user.email=fixture@example.invalid", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

const writeVersion = (cwd: string, version: unknown) => writeFileSync(join(cwd, "package.json"), `${JSON.stringify({ name: "fixture", version }, null, 2)}\n`);

/** main 在 0.1.0 的基线上；stage 比 main 多一个提交。 */
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "geek-bot-release-tags-"));
  roots.push(cwd);
  writeVersion(cwd, "0.1.0");
  git(cwd, "init", "--initial-branch=main");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "main baseline");
  const mainTip = git(cwd, "rev-parse", "HEAD");
  git(cwd, "checkout", "-b", "stage");
  git(cwd, "commit", "--allow-empty", "-m", "stage integration");
  const stageTip = git(cwd, "rev-parse", "HEAD");
  return { cwd, mainTip, stageTip };
}

describe("release tag grammar", () => {
  it("pins the exact SemVer tag regex and maps rc → preview/stage, final → production/main", () => {
    expect(RELEASE_TAG_RE.source).toBe("^v(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(-rc\\.([1-9]\\d*))?$");
    expect(TAG_KINDS).toEqual({ rc: { environment: "preview", branch: "stage" }, final: { environment: "production", branch: "main" } });
    expect(parseReleaseTag("v0.1.0-rc.1")).toEqual({ tag: "v0.1.0-rc.1", kind: "rc", version: "0.1.0", rc: 1, environment: "preview", branch: "stage" });
    expect(parseReleaseTag("v10.20.30-rc.12")).toMatchObject({ kind: "rc", version: "10.20.30", rc: 12 });
    expect(parseReleaseTag("v0.1.0")).toEqual({ tag: "v0.1.0", kind: "final", version: "0.1.0", rc: null, environment: "production", branch: "main" });
  });

  it("rejects branch names, SHAs, latest and every malformed tag", () => {
    for (const bad of [
      "main", "stage", "task/7/tag_release", "dev/alice", "latest", "HEAD",
      "a".repeat(40), "abcdef123456", "0.1.0", "v0.1", "v0.1.0.0", "V0.1.0", "v01.1.0", "v0.01.0", "v0.1.00",
      "v0.1.0-rc", "v0.1.0-rc.0", "v0.1.0-rc.01", "v0.1.0-rc1", "v0.1.0-RC.1", "v0.1.0-beta.1", "v0.1.0-rc.1.1",
      "v0.1.0+build", "v0.1.0-rc.1@abcdef123456", "release-0.1.0", "prev-0.1.0", " v0.1.0", "v0.1.0\n", "",
    ]) {
      expect(parseReleaseTag(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(parseReleaseTag(undefined)).toBeNull();
    expect(parseReleaseTag(1)).toBeNull();
  });

  it("keeps the tag regex in RELEASES.md identical to the script", () => {
    const doc = readFileSync(join(repoRoot, "docs/conventions/RELEASES.md"), "utf8");
    expect(doc).toContain(`\`${RELEASE_TAG_RE.source}\``);
  });
});

describe("read-only Git queries", () => {
  it("reads package.json version from the commit, not from the working tree", () => {
    const f = fixture();
    writeVersion(f.cwd, "9.9.9"); // 未提交的改动不能冒充发布版本
    expect(packageVersionAt(f.cwd, f.stageTip)).toBe("0.1.0");
  });

  it("fails on a commit whose package.json version is not X.Y.Z", () => {
    const f = fixture();
    writeVersion(f.cwd, "0.2");
    git(f.cwd, "commit", "-am", "bad version");
    expect(() => packageVersionAt(f.cwd, git(f.cwd, "rev-parse", "HEAD"))).toThrow("X.Y.Z");
  });

  it("lists tags with the peeled commit of annotated tags", () => {
    const f = fixture();
    git(f.cwd, "tag", "v0.1.0-rc.1", f.mainTip);
    git(f.cwd, "tag", "-a", "v0.1.0-rc.2", "-m", "annotated rc", f.stageTip);
    const tags = listTagCommits(f.cwd);
    expect(tags).toEqual(expect.arrayContaining([
      { name: "v0.1.0-rc.1", commit: f.mainTip },
      { name: "v0.1.0-rc.2", commit: f.stageTip },
    ]));
  });

  it("finds the rc tags of the same version on the same commit, ordered by N", () => {
    const f = fixture();
    git(f.cwd, "tag", "v0.1.0-rc.10", f.mainTip);
    git(f.cwd, "tag", "-a", "v0.1.0-rc.2", "-m", "annotated rc", f.mainTip);
    git(f.cwd, "tag", "v0.1.0-rc.3", f.stageTip); // 另一个提交
    git(f.cwd, "tag", "v0.2.0-rc.1", f.mainTip); // 另一个版本
    git(f.cwd, "tag", "note", f.mainTip); // 不是发布 tag
    expect(previewTagsFor(f.cwd, "0.1.0", f.mainTip)).toEqual(["v0.1.0-rc.2", "v0.1.0-rc.10"]);
    expect(previewTagsFor(f.cwd, "0.3.0", f.mainTip)).toEqual([]);
  });
});
