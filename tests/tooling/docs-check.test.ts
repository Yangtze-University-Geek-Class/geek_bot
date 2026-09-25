// 文档门禁（scripts/check-docs.mjs）的反例与正例：全部在临时目录的合成仓库里跑，不读本仓库的文档。
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ROOT, SERVICE_PARENTS, checkDocs, serviceDirectories } from "../../scripts/check-docs.mjs";

const script = fileURLToPath(new URL("../../scripts/check-docs.mjs", import.meta.url));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const doc = (title: string) => `# ${title}\n\n> ${title}的一句话说明。\n\n状态：\`current\` · 更新：2026-09-25 · 适用：测试夹具\n`;

/** 五个包各有一份服务契约、入口齐全、两个技能链接都指向 .agents/skills/code-review 的最小仓库。 */
const BASE: Record<string, string> = {
  "AGENTS.md": `${doc("入口")}\n[docs](docs/README.md)\n`,
  "README.md": doc("说明"),
  "docs/README.md": `${doc("文档")}\n[control](services/control/README.md)\n`,
  ".agents/skills/code-review/SKILL.md": doc("审查"),
  "app/control/package.json": "{}\n",
  "app/console/package.json": "{}\n",
  "app/node/package.json": "{}\n",
  "app/runner/package.json": "{}\n",
  "packages/protocol/package.json": "{}\n",
  "docs/services/control/README.md": doc("control"),
  "docs/services/console/README.md": doc("console"),
  "docs/services/node/README.md": doc("node"),
  "docs/services/runner/README.md": doc("runner"),
  "docs/services/protocol/README.md": doc("protocol"),
};
const SKILL_LINKS = [".omp/skills/code-review", ".claude/skills/code-review"];

/** 建一个合成仓库。files 里值为 null 的路径从基线里删掉；links 为 false 时不建技能链接。 */
function fixture(files: Record<string, string | null> = {}, { links = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "geek-bot-docs-"));
  roots.push(root);
  for (const [path, text] of Object.entries({ ...BASE, ...files })) {
    if (text === null) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  if (links) {
    for (const link of SKILL_LINKS) {
      mkdirSync(dirname(join(root, link)), { recursive: true });
      symlinkSync("../../.agents/skills/code-review", join(root, link), "dir");
    }
  }
  return root;
}

const errorsOf = (root: string) => checkDocs(root).errors as string[];

describe("服务契约：每个 app/<name> 与 packages/<name> 都要有 docs/services/<name>/README.md", () => {
  it("五个包齐全的仓库通过", () => {
    const root = fixture();
    expect(errorsOf(root)).toEqual([]);
    expect(serviceDirectories(root).map((item: { parent: string; name: string }) => `${item.parent}/${item.name}`)).toEqual([
      "app/console",
      "app/control",
      "app/node",
      "app/runner",
      "packages/protocol",
    ]);
  });

  it("新增 app/foo 但缺 docs/services/foo/README.md：失败", () => {
    const errors = errorsOf(fixture({ "app/foo/package.json": "{}\n" }));
    expect(errors).toEqual(["app/foo 缺少服务契约 docs/services/foo/README.md"]);
  });

  it("补上 docs/services/foo/README.md 之后通过", () => {
    expect(errorsOf(fixture({ "app/foo/package.json": "{}\n", "docs/services/foo/README.md": doc("foo") }))).toEqual([]);
  });

  it("新增 packages/<name> 同样要有契约；删掉已有包的契约也失败", () => {
    expect(errorsOf(fixture({ "packages/schema/package.json": "{}\n" }))).toEqual(["packages/schema 缺少服务契约 docs/services/schema/README.md"]);
    expect(errorsOf(fixture({ "docs/services/protocol/README.md": null }))).toEqual(["packages/protocol 缺少服务契约 docs/services/protocol/README.md"]);
  });

  it("没有 app/ 目录、或 app/ 下没有任何服务：失败", () => {
    const empty = fixture({ "app/control/package.json": null, "app/console/package.json": null, "app/node/package.json": null, "app/runner/package.json": null });
    rmSync(join(empty, "app"), { recursive: true, force: true });
    expect(errorsOf(empty)).toContain("缺少 app/ 目录");
    mkdirSync(join(empty, "app"));
    expect(errorsOf(empty)).toContain("app/ 下没有任何服务目录");
  });

  it("点开头的目录不算服务", () => {
    expect(errorsOf(fixture({ "app/.cache/x.json": "{}\n" }))).toEqual([]);
    expect(SERVICE_PARENTS).toEqual(["app", "packages"]);
  });
});

describe("入口、技能链接、相对链接与 historical 标记", () => {
  it("缺 AGENTS.md、README.md、docs/README.md：逐个报出", () => {
    const errors = errorsOf(fixture({ "AGENTS.md": null, "README.md": null, "docs/README.md": null }));
    expect(errors).toEqual(expect.arrayContaining(["缺少 AGENTS.md", "缺少 README.md", "缺少 docs/README.md"]));
  });

  it("技能目录是复制品而不是符号链接：失败；链接缺失也失败", () => {
    const copied = fixture({}, { links: false });
    cpSync(join(copied, ".agents/skills/code-review"), join(copied, ".omp/skills/code-review"), { recursive: true });
    const errors = errorsOf(copied).join("\n");
    expect(errors).toContain(".omp/skills/code-review：必须是指向 .agents/skills/code-review 的符号链接，不能是复制品");
    expect(errors).toContain("缺少技能链接 .claude/skills/code-review");
  });

  it("技能链接指向别处或悬空：失败", () => {
    const root = fixture({ "other/SKILL.md": doc("别的技能") }, { links: false });
    mkdirSync(join(root, ".omp/skills"), { recursive: true });
    mkdirSync(join(root, ".claude/skills"), { recursive: true });
    symlinkSync("../../other", join(root, ".omp/skills/code-review"), "dir");
    symlinkSync("../../missing", join(root, ".claude/skills/code-review"), "dir");
    const errors = errorsOf(root).join("\n");
    expect(errors).toContain(".omp/skills/code-review：符号链接必须解析到 .agents/skills/code-review");
    expect(errors).toContain(".claude/skills/code-review：符号链接必须解析到 .agents/skills/code-review");
  });

  it("相对链接指向不存在的文件：失败；外链、锚点与代码里的链接不查", () => {
    const errors = errorsOf(
      fixture({
        "docs/ops/README.md": `${doc("运维")}\n[部署](DEPLOY.md)\n[外链](https://geek-bot.example.com/docs)\n[锚点](#运维)\n\`[代码](missing.md)\`\n\n\`\`\`md\n[围栏](missing.md)\n\`\`\`\n`,
      }),
    );
    expect(errors).toEqual(["docs/ops/README.md：链接目标不存在 DEPLOY.md"]);
  });

  it("入口文件里的坏链接同样报出", () => {
    expect(errorsOf(fixture({ "README.md": `${doc("说明")}\n[规范](docs/conventions/README.md)\n` }))).toEqual(["README.md：链接目标不存在 docs/conventions/README.md"]);
  });

  it("docs/history 下的文档没标 historical：失败", () => {
    expect(errorsOf(fixture({ "docs/history/old.md": doc("旧文档") }))).toEqual(["docs/history/old.md：docs/history 下的文档必须标 historical 状态"]);
    expect(errorsOf(fixture({ "docs/history/old.md": "# 旧文档\n\n> 旧。\n\n状态：`historical`\n" }))).toEqual([]);
  });
});

describe("命令行", () => {
  it("--root：缺契约以 1 退出并指出路径；齐全的仓库以 0 退出", () => {
    const failed = spawnSync(process.execPath, [script, "--root", fixture({ "app/foo/package.json": "{}\n" })], { encoding: "utf8" });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("app/foo 缺少服务契约 docs/services/foo/README.md");
    const passed = spawnSync(process.execPath, [script, "--root", fixture()], { encoding: "utf8" });
    expect(passed.status, passed.stderr).toBe(0);
    expect(passed.stdout).toContain("文档检查通过");
  });

  it("不认识的参数、--root 缺值：打印用法到 stderr 并以非 0 退出", () => {
    for (const args of [["--no-such-flag"], ["--root"], ["extra"]]) {
      const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
      expect(result.status, args.join(" ")).not.toBe(0);
      expect(result.stderr, args.join(" ")).toContain("用法：node scripts/check-docs.mjs");
    }
  });

  it("默认根目录是脚本所在仓库", () => {
    expect(ROOT).toBe(fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, ""));
  });
});
