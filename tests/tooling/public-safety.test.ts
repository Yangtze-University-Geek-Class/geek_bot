// 公开安全门禁（scripts/check-public-safety.mjs）的反例与正例。
//
// 私网地址、组网主机名这类反例全部在运行时拼出来；被禁 token 的用例注入测试自己的哈希表，
// 不在仓库里留下任何真实的被禁词。本文件自己也在被扫描的范围里。
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ALLOW_FILE,
  DENYLIST_FILE,
  SKIPPED_PREFIXES,
  TUFFEX_MANIFEST,
  applyAllowlist,
  auditRepository,
  classifyIPv4,
  hashTerm,
  hashTermProblem,
  loadAllowlist,
  loadDenylist,
  maskPath,
  scanPath,
  scanText,
  sha256,
  tokensOf,
} from "../../scripts/check-public-safety.mjs";

const script = fileURLToPath(new URL("../../scripts/check-public-safety.mjs", import.meta.url));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ip = (...octets: number[]) => octets.join(".");
const meshHost = (...labels: string[]) => [...labels.slice(0, 1), "mesh", ...labels.slice(1)].join(".");
/** 测试用的被禁词：一个虚构的组织名，只以哈希形式注入。 */
const FAKE_ORG = "acmecorp";
const denylist = new Set([hashTerm(FAKE_ORG), sha256(ip(203, 0, 113, 77))]);
/**
 * 仓库被禁清单里必须有的哈希（只写哈希，不写明文）：契约列出的五个词与一个公网 IPv4，
 * 以及组织品牌用过的一个缩写变体。删掉或换掉任何一条，这里就失败。
 */
const REQUIRED_HASHES = [
  "24212b0f79f1b571b1e00afee55af8dd33e8868c1e5376cc9973e1924718f76f",
  "f933253424a92057143d4279eb5de037859e048747d9432c96c0b73362cc40e8",
  "a321596281a5402553f7028a410f96b2d46f6de9a8de9a0d31124af3ee61fbde",
  "c320ed23d8d5e1f97f77948addd777637dc1b327b863ba4b12d8f10a41b5d14c",
  "e911c6318d80d4bbd2835e60ee84d52648029544962bbaaf733ed76f578f2e77",
  "e39f7ec7ac1886f6f62ac465ba944e5d31cc814af46e562f0f6176e6090a010e",
  "79db64e46b917772cd7081b8cb5e9ca9fcd0180ad4439d807586fd59d6fee6b7",
];

const scan = (text: string, file = "docs/x.md") => scanText(file, text, { denylist });

/** 在临时目录建一个 Git 仓库，按路径写入文件；tracked 里的路径会 git add。 */
function repo(files: Record<string, string | Buffer>, tracked: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "geek-bot-public-safety-"));
  roots.push(root);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  if (tracked.length) execFileSync("git", ["add", "--", ...tracked], { cwd: root });
  return root;
}

describe("规则 1：私网、CGNAT、链路本地 IPv4", () => {
  it("五类受限网段都命中，边界外的地址不命中", () => {
    expect(classifyIPv4([10, 1, 2, 3])).toContain("10/8");
    expect(classifyIPv4([172, 16, 0, 1])).toContain("172.16/12");
    expect(classifyIPv4([172, 31, 255, 254])).toContain("172.16/12");
    expect(classifyIPv4([192, 168, 1, 1])).toContain("192.168/16");
    expect(classifyIPv4([100, 64, 0, 1])).toContain("100.64/10");
    expect(classifyIPv4([100, 127, 255, 255])).toContain("100.64/10");
    expect(classifyIPv4([169, 254, 1, 1])).toContain("169.254/16");
    for (const octets of [[172, 15, 0, 1], [172, 32, 0, 1], [100, 63, 0, 1], [100, 128, 0, 1], [192, 169, 0, 1], [203, 0, 113, 10], [8, 8, 8, 8], [10, 0, 0, 256]]) {
      expect(classifyIPv4(octets), octets.join(".")).toBeNull();
    }
  });

  it("文本里的私网地址命中，报告只保留第一段", () => {
    const address = ip(10, 1, 2, 3);
    const found = scan(`control 监听 ${address}:8080`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ file: "docs/x.md", line: 1, value: address, shown: "10.*.*.*" });
    expect(scan(`节点地址 ${ip(192, 168, 1, 20)}，组网地址 ${ip(100, 64, 3, 4)}`)).toHaveLength(2);
  });

  it("版本号片段、越界数字与文档地址不算", () => {
    expect(scan(`版本 ${ip(10, 1, 2, 3, 4)}；${ip(10, 1, 2, 300)}；v${ip(1, 10, 0, 1)}.2`)).toEqual([]);
    expect(scan(`示例地址 ${ip(203, 0, 113, 10)}`)).toEqual([]);
  });
});

describe("规则 2：带 .mesh. 段的主机名", () => {
  it("命中组网主机名，不回显主机名", () => {
    const host = meshHost("node1", "example", "net");
    const found = scan(`ssh ops@${host}`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ rule: expect.stringContaining(".mesh."), value: host, shown: "*.mesh.*" });
  });

  it("没有前一段标签、或 mesh 只是词的一部分时不算", () => {
    expect(scan(["mesh", "example", "net"].join("."))).toEqual([]);
    expect(scan(["refresh", "meshes", "net"].join("."))).toEqual([]);
    expect(scan("service mesh 与 sidecar")).toEqual([]);
  });
});

describe("规则 3：被禁 token 与 IPv4 的哈希", () => {
  it("token 按小写切分并兼顾驼峰写法", () => {
    expect([...tokensOf("Acme-Corp acmecorp_bot AcmecorpBot")]).toEqual(expect.arrayContaining(["acme", "corp", "acmecorp", "bot", "acmecorpbot"]));
    expect(tokensOf("fooAcmecorpBar").has(FAKE_ORG)).toBe(true);
    expect(tokensOf("ACMECORPBot").has(FAKE_ORG)).toBe(true);
  });

  it("被禁词不论大小写、放在路径或 URL 里都命中；只报哈希前缀", () => {
    for (const text of ["ACMECORP", "https://acmecorp.example.com", "/opt/acmecorp/data", "<!-- acmecorp:track v1 -->", "fooAcmecorpBar"]) {
      const found = scan(text);
      expect(found, text).toHaveLength(1);
      expect(found[0].value).toBe(hashTerm(FAKE_ORG));
      expect(found[0].shown).toBe(`sha256:${hashTerm(FAKE_ORG).slice(0, 12)}`);
      expect(found[0].shown).not.toContain(FAKE_ORG);
    }
    expect(scan("acme corp")).toEqual([]);
    expect(scan("acmecorporation")).toEqual([]);
  });

  it("被禁的公网 IPv4 按整体哈希命中", () => {
    const found = scan(`部署到 ${ip(203, 0, 113, 77)}`);
    expect(found).toHaveLength(1);
    expect(found[0].rule).toContain("被禁 IPv4");
    expect(scan(`部署到 ${ip(203, 0, 113, 78)}`)).toEqual([]);
  });

  it("仓库的被禁清单只有 64 位十六进制哈希，且包含必须登记的每一项", () => {
    const list = loadDenylist();
    expect([...list]).toEqual(expect.arrayContaining(REQUIRED_HASHES));
    const raw = JSON.parse(readFileSync(DENYLIST_FILE, "utf8"));
    expect(Object.keys(raw)).toEqual(["sha256"]);
    for (const item of raw.sha256) expect(item).toMatch(/^[a-f0-9]{64}$/);
  });

  it("被禁清单格式不对就失败，不静默放行", () => {
    const root = repo({ "bad.json": JSON.stringify({ sha256: ["not-a-hash"] }), "empty.json": JSON.stringify({ sha256: [] }) });
    expect(() => loadDenylist(join(root, "bad.json"))).toThrow(/SHA-256/);
    expect(() => loadDenylist(join(root, "empty.json"))).toThrow(/非空/);
  });

  it("--hash 打印小写、去首尾空白后的 SHA-256", () => {
    const result = spawnSync(process.execPath, [script, "--hash", "  AcmeCorp "], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(sha256(FAKE_ORG));
    const address = spawnSync(process.execPath, [script, "--hash", ip(203, 0, 113, 77)], { encoding: "utf8" });
    expect(address.status).toBe(0);
    expect(address.stdout.trim()).toBe(sha256(ip(203, 0, 113, 77)));
    const missing = spawnSync(process.execPath, [script, "--hash"], { encoding: "utf8" });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("用法：node scripts/check-public-safety.mjs");
  });

  it("--hash 拒绝永远匹配不上的输入：多个 token、汉字、越界 IPv4、其它字符", () => {
    // 这些输入的哈希扫描时永远不会命中：登记进清单只会让人以为已经拦住。
    const hanWord = String.fromCodePoint(0x7532, 0x4e59, 0x4e19);
    for (const term of ["acme-corp", "acme corp", hanWord, ip(10, 0, 0, 256), "a.b", "--"]) {
      expect(hashTermProblem(term), term).not.toBeNull();
    }
    expect(hashTermProblem("acme-corp")).toContain("acme、corp");
    expect(hashTermProblem(hanWord)).toContain("汉字");
    for (const term of ["acmecorp", " AcmeCorp ", ip(203, 0, 113, 77)]) expect(hashTermProblem(term), term).toBeNull();
    // 被拒绝的输入算出的哈希确实匹配不上：同一段文本按 token 扫描不会命中
    expect(scanText("docs/x.md", "acme-corp", { denylist: new Set([hashTerm("acme-corp")]) })).toEqual([]);
    const rejected = spawnSync(process.execPath, [script, "--hash", "acme-corp"], { encoding: "utf8" });
    expect(rejected.status).toBe(2);
    expect(rejected.stdout).toBe("");
    expect(rejected.stderr).toContain("acme、corp");
    expect(rejected.stderr).toContain("用法：node scripts/check-public-safety.mjs");
  });
});

describe("规则 4：放行清单", () => {
  it("逐条按路径与原文放行；没用上的放行项报出来", () => {
    const address = ip(10, 0, 2, 100);
    const found = scan(`guestfwd ${address}`, "app/node/src/qemu.ts");
    const allowed = applyAllowlist(found, [{ path: "app/node/src/qemu.ts", value: address, reason: "QEMU 用户态网络的 guestfwd 地址，只在 VM 内可见" }]);
    expect(allowed.findings).toEqual([]);
    expect(allowed.unused).toEqual([]);
    const elsewhere = applyAllowlist(scan(`guestfwd ${address}`, "docs/x.md"), [{ path: "app/node/src/qemu.ts", value: address, reason: "只放行 qemu.ts" }]);
    expect(elsewhere.findings).toHaveLength(1);
    expect(elsewhere.unused).toHaveLength(1);
  });

  it("放行项缺路径、原文或理由、或多了别的字段：失败；文件不存在当作空", () => {
    expect(loadAllowlist(repo({}))).toEqual([]);
    const root = repo({ "scripts/public-safety-allow.json": JSON.stringify([{ path: "a", value: "b", reason: " " }]) });
    expect(() => loadAllowlist(root)).toThrow(/reason/);
    const notArray = repo({ "scripts/public-safety-allow.json": JSON.stringify({ path: "a" }) });
    expect(() => loadAllowlist(notArray)).toThrow(/数组/);
    const extra = repo({ "scripts/public-safety-allow.json": JSON.stringify([{ path: "a", value: "b", reason: "c", note: "d" }]) });
    expect(() => loadAllowlist(extra)).toThrow(/note/);
  });

  it("放行清单自己的 reason、path 照常扫描：写进被禁词或别的私网地址就失败，而且不能再被放行", () => {
    const address = ip(10, 0, 2, 100);
    const root = repo({
      "docs/qemu.md": `QEMU 用户态网络的 guestfwd 地址 ${address}\n`,
      [ALLOW_FILE]: JSON.stringify(
        [
          { path: "docs/qemu.md", value: address, reason: `在 ${FAKE_ORG}-arch 上实测，内网 ${ip(192, 168, 1, 1)}` },
          { path: ALLOW_FILE, value: ip(192, 168, 1, 1), reason: "想放行清单自己的命中" },
        ],
        null,
        2,
      ),
    });
    const report = auditRepository({ root, denylist });
    expect(report.ok).toBe(false);
    const own = report.findings.filter((item) => item.file === ALLOW_FILE);
    expect(own.map((item) => item.rule).sort()).toEqual([
      expect.stringContaining("第 1 项的 reason：私网地址（192.168/16）"),
      expect.stringContaining("第 1 项的 reason：被禁 token"),
    ].sort());
    expect(own.every((item) => item.line === 5)).toBe(true);
    expect(report.findings.filter((item) => item.file === "docs/qemu.md")).toEqual([]);
    expect(report.unused.map((entry) => entry.path)).toEqual([ALLOW_FILE]);
  });
});

describe("扫描整个仓库", () => {
  it("已跟踪文件里出现私网 IP 或 .mesh. 主机名：失败", () => {
    const root = repo(
      {
        "docs/ops/nodes.md": `# 节点\n\n节点地址 ${ip(192, 168, 10, 2)}\n`,
        "app/node/src/join.ts": `export const CONTROL = "https://${meshHost("control", "example", "net")}";\n`,
      },
      ["docs/ops/nodes.md", "app/node/src/join.ts"],
    );
    const report = auditRepository({ root, denylist });
    expect(report.ok).toBe(false);
    expect(report.findings.map((item) => `${item.file}:${item.line}`).sort()).toEqual(["app/node/src/join.ts:1", "docs/ops/nodes.md:3"]);
  });

  it("未跟踪但没被忽略的新文件同样扫描；被忽略的文件、登记过的上游快照与二进制文件的内容跳过", () => {
    const secretLine = `地址 ${ip(10, 9, 8, 7)}\n`;
    const root = repo({
      ".gitignore": "local/\n",
      "docs/new.md": secretLine,
      "local/notes.md": secretLine,
      [TUFFEX_MANIFEST]: JSON.stringify({ files: [{ path: "reference/button.md" }, { path: "snapshot/source.txt" }] }),
      [`${SKIPPED_PREFIXES[0]}button.md`]: secretLine,
      [`${SKIPPED_PREFIXES[1]}source.txt`]: secretLine,
      "assets/logo.png": Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]), Buffer.from(secretLine)]),
    });
    const report = auditRepository({ root, denylist });
    expect(report.findings.map((item) => item.file)).toEqual(["docs/new.md"]);
  });

  it("上游快照目录里没登记进 manifest 的文件照常扫描", () => {
    const secretLine = `地址 ${ip(10, 9, 8, 7)}，由 ${FAKE_ORG} 维护\n`;
    const root = repo({
      [TUFFEX_MANIFEST]: JSON.stringify({ files: [{ path: "snapshot/source.txt" }] }),
      [`${SKIPPED_PREFIXES[1]}source.txt`]: secretLine,
      [`${SKIPPED_PREFIXES[0]}zz-extra.md`]: secretLine,
      [`${SKIPPED_PREFIXES[1]}zz-extra.txt`]: secretLine,
    });
    const report = auditRepository({ root, denylist });
    expect([...new Set(report.findings.map((item) => item.file))].sort()).toEqual([`${SKIPPED_PREFIXES[0]}zz-extra.md`, `${SKIPPED_PREFIXES[1]}zz-extra.txt`]);
    // 没有 manifest 时两个快照目录整个照常扫描
    const bare = repo({ [`${SKIPPED_PREFIXES[1]}source.txt`]: secretLine });
    expect(auditRepository({ root: bare, denylist }).findings.map((item) => item.file)).toContain(`${SKIPPED_PREFIXES[1]}source.txt`);
  });

  it("文件名、目录名与符号链接目标都扫描：路径与链接目标随仓库公开", () => {
    const root = repo({
      [`docs/${FAKE_ORG}-dir/a.md`]: "safe content\n",
      [`docs/${FAKE_ORG}-dir/b.md`]: "safe content\n",
      [`docs/x/${FAKE_ORG}-notes.md`]: "safe content\n",
      [`${SKIPPED_PREFIXES[1]}${FAKE_ORG}.txt`]: "safe content\n",
      [TUFFEX_MANIFEST]: JSON.stringify({ files: [{ path: `snapshot/${FAKE_ORG}.txt` }] }),
      "docs/ok.md": "safe content\n",
    });
    mkdirSync(join(root, "links"));
    symlinkSync(`/Users/${FAKE_ORG}/secret`, join(root, "links", "home"));
    symlinkSync(`../docs/ok.md`, join(root, "links", "ok"));
    const report = auditRepository({ root, denylist });
    expect(report.ok).toBe(false);
    expect(report.links).toBe(2);
    const where = report.findings.map((item) => `${item.file}:${item.line} ${item.rule.split("：")[0]}`).sort();
    // manifest 里登记的路径同样是文本内容，照常命中；登记过的快照只跳过内容，不跳过路径。
    expect(where).toEqual([
      `docs/${FAKE_ORG}-dir:0 路径`,
      `docs/x/${FAKE_ORG}-notes.md:0 路径`,
      `${SKIPPED_PREFIXES[1]}${FAKE_ORG}.txt:0 路径`,
      `${TUFFEX_MANIFEST}:1 被禁 token（哈希命中）`,
      "links/home:1 符号链接目标",
    ].sort());
    // 同一个目录只报一次；放行清单按「路径前缀 + value」生效
    expect(scanPath(`docs/${FAKE_ORG}-dir/c.md`, { denylist, seen: new Set([`docs/${FAKE_ORG}-dir`]) })).toEqual([]);
    const allowed = applyAllowlist(report.findings, [{ path: `docs/${FAKE_ORG}-dir`, value: hashTerm(FAKE_ORG), reason: "测试" }]);
    expect(allowed.findings.map((item) => item.file)).not.toContain(`docs/${FAKE_ORG}-dir`);
    expect(maskPath(`docs/${FAKE_ORG}-dir/a.md`, { denylist })).toBe("docs/***/a.md");
  });

  it("被禁 token 与放行清单在仓库级别生效", () => {
    const address = ip(10, 0, 2, 100);
    const root = repo({
      "README.md": `由 ${FAKE_ORG.toUpperCase()} 维护\n`,
      "app/node/src/qemu.ts": `export const GUEST_FORWARD = "${address}";\n`,
      "scripts/public-safety-allow.json": JSON.stringify([{ path: "app/node/src/qemu.ts", value: address, reason: "QEMU 用户态网络的 guestfwd 地址" }]),
    });
    const report = auditRepository({ root, denylist });
    expect(report.findings.map((item) => item.file)).toEqual(["README.md"]);
    expect(report.unused).toEqual([]);
  });

  it("命令行 --root：命中以 1 退出，报告不回显地址与主机名", () => {
    const address = ip(172, 20, 1, 5);
    const host = meshHost("db", "example", "net");
    const root = repo({ "docs/x.md": `${address}\n${host}\n` });
    const result = spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/x.md:1:");
    expect(result.stderr).toContain("docs/x.md:2:");
    expect(result.stderr).toContain("172.*.*.*");
    expect(result.stderr).not.toContain(address);
    expect(result.stderr).not.toContain(host);
    const unknown = spawnSync(process.execPath, [script, "--no-such-flag"], { encoding: "utf8" });
    expect(unknown.status).not.toBe(0);
    expect(unknown.stderr).toContain("用法：node scripts/check-public-safety.mjs");
  });

  it("命令行 --root：路径里的命中只打印打码后的路径", () => {
    const address = ip(10, 1, 2, 3);
    const root = repo({ [`docs/${address}.md`]: "safe content\n" });
    const result = spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/***:0: 路径：私网地址（10/8）：10.*.*.*");
    expect(result.stderr).not.toContain(address);
  });

  it("本仓库当前的文件通过（真实被禁清单与放行清单）", () => {
    const report = auditRepository();
    expect(report.findings.map((item) => `${item.file}:${item.line} ${item.rule}`)).toEqual([]);
    expect(report.unused).toEqual([]);
    expect(report.checked).toBeGreaterThan(50);
  });
});
