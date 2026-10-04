import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BundleError, parseBundle } from "../../app/runner/src/bundle.js";

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function file(path: string, content = "fixture content", encoding = "utf8") {
  return { path, content, encoding };
}

function bytes(files: ReturnType<typeof file>[], patch: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({ files, diff: "fixture diff", rules: [], meta: { fixture: true }, ...patch }));
}

function parse(data: Buffer) {
  return parseBundle(data, digest(data));
}

describe("untrusted bundle parsing", () => {
  it("returns decoded bytes, diff, rules and metadata from a verified bundle", () => {
    const binary = Buffer.from([0, 255, 128, 10]);
    const data = bytes([file("src/fixture.txt", "λ\n"), file("assets/fixture.bin", binary.toString("base64"), "base64")], {
      rules: [{ path: "docs/fixture.md", content: "fixture rule" }],
      meta: { head_sha: "a".repeat(40), base_sha: "b".repeat(40) },
    });
    const result = parse(data);
    expect([...result.files.entries()]).toEqual([
      ["src/fixture.txt", Buffer.from("λ\n")],
      ["assets/fixture.bin", binary],
    ]);
    expect(result.diff).toBe("fixture diff");
    expect(result.rules).toEqual([{ path: "docs/fixture.md", content: "fixture rule" }]);
    expect(result.meta).toEqual({ head_sha: "a".repeat(40), base_sha: "b".repeat(40) });
  });

  it("rejects changed bytes even when they still form a valid bundle", () => {
    const original = bytes([file("src/fixture.txt", "before")]);
    const changed = bytes([file("src/fixture.txt", "after")]);
    expect(() => parseBundle(changed, digest(original))).toThrow(BundleError);
  });

  it.each(["", "not-a-digest", "A".repeat(64), "0".repeat(63)])("rejects invalid digest %j", expected => {
    expect(() => parseBundle(bytes([]), expected)).toThrow(BundleError);
  });

  it.each(["{", "null", "[]", "42"])("rejects independently hashed malformed/top-level input %j", text => {
    expect(() => parse(Buffer.from(text))).toThrow(BundleError);
  });

  it.each([
    { name: "unknown extension field", patch: { extensions: [{ path: "fixture.js" }] } },
    { name: "missing file array", patch: { files: null } },
    { name: "non-string diff", patch: { diff: [] } },
    { name: "non-array rules", patch: { rules: {} } },
    { name: "non-object metadata", patch: { meta: [] } },
  ])("rejects $name", ({ patch }) => {
    expect(() => parse(bytes([], patch))).toThrow(BundleError);
  });

  it.each(["", "../fixture", "src/../../fixture", "/fixture", "src//fixture", "./fixture", "src/./fixture", "src\\fixture", "src/fixture\u0000", "src/fixture\n", "src/fixture\u007f", "é".repeat(128)])("rejects unsafe file path %j", path => {
    expect(() => parse(bytes([file(path)]))).toThrow(BundleError);
  });

  it.each(["../fixture.md", "/fixture.md", "docs\\fixture.md", "docs/./fixture.md"])("rejects unsafe rule path %j", path => {
    expect(() => parse(bytes([], { rules: [{ path, content: "fixture rule" }] }))).toThrow(BundleError);
  });

  it.each([
    "src/.OMP/extensions/fixture.js", "src/.Claude/fixture.md", ".pi/extensions/fixture.ts",
    ".agents/fixture.js", ".git/config", "src/MCP.JSON", "src/.mcp.json",
    "src/mcp_config.json", ".vscode/mcp.json", "src/.env", "src/.ENV.fixture",
    "src/.cursorrules", "src/.windsurfrules", "src/.clinerules",
  ])("refuses repository-discovered extension/configuration path %j", path => {
    expect(() => parse(bytes([file(path)]))).toThrow(BundleError);
  });

  it.each([
    { name: "exact duplicate", paths: ["src/fixture.txt", "src/fixture.txt"] },
    { name: "case alias", paths: ["src/Fixture.txt", "SRC/fixture.TXT"] },
    { name: "file before directory", paths: ["src", "SRC/fixture.txt"] },
    { name: "directory before file", paths: ["SRC/fixture.txt", "src"] },
  ])("rejects $name", ({ paths }) => {
    expect(() => parse(bytes(paths.map(path => file(path))))).toThrow(BundleError);
  });

  it.each([
    { name: "unsupported encoding", content: "fixture", encoding: "hex" },
    { name: "invalid alphabet", content: "!!!!", encoding: "base64" },
    { name: "truncated quartet", content: "YQ=", encoding: "base64" },
    { name: "embedded padding", content: "Y=Q=", encoding: "base64" },
  ])("rejects $name rather than silently decoding attacker bytes", ({ content, encoding }) => {
    expect(() => parse(bytes([file("src/fixture.bin", content, encoding)]))).toThrow(BundleError);
  });
});
