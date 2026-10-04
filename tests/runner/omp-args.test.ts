import { describe, expect, it } from "vitest";
import { buildOmpArgs, type OmpArgsInput } from "../../app/runner/src/omp-args.js";

function input(patch: Partial<OmpArgsInput> = {}): OmpArgsInput {
  return {
    executor: "sandbox",
    tools: ["grep"],
    model: "fixture-model",
    effort: "high",
    overlayPath: "/tmp/fixture/overlay.json",
    appendSystemPromptPath: "/tmp/fixture/instructions.md",
    maxTimeS: 73,
    ...patch,
  };
}

function valueOf(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

const externalTools = ["eval", "browser", "mcp", "mcp__fixture__read", "fetch", "web_search", "github", "task", "ast_edit"];

describe("executor tool confinement", () => {
  it.each(["write", "edit", "bash", ...externalTools])("sandbox refuses tool expansion through %s", tool => {
    expect(() => buildOmpArgs(input({ tools: ["read", tool] }))).toThrow(/不允许/);
  });

  it.each(externalTools)("VM refuses tool expansion through %s", tool => {
    expect(() => buildOmpArgs(input({ executor: "vm", tools: ["bash", tool] }))).toThrow(/不允许/);
  });

  it.each(["sandbox", "vm"] as const)("%s never falls back to implicit unrestricted tools", executor => {
    expect(() => buildOmpArgs(input({ executor, tools: [] }))).toThrow(/白名单/);
    const args = buildOmpArgs(input({ executor, tools: ["glob", "read", "glob"] }));
    expect(args.filter(arg => arg === "--tools")).toHaveLength(1);
    expect(valueOf(args, "--tools")?.split(",").sort()).toEqual(["glob", "read"]);
  });

  it("VM grants only the requested write/exec subset, not every permitted tool", () => {
    const args = buildOmpArgs(input({ executor: "vm", tools: ["write", "bash"] }));
    expect(valueOf(args, "--tools")?.split(",").sort()).toEqual(["bash", "write"]);
  });

  it.each(["read,bash", "read --tools bash", "--tools=bash", "Read", "read\nwrite"])("refuses compound or disguised tool name %j", tool => {
    expect(() => buildOmpArgs(input({ tools: [tool] }))).toThrow(/不允许/);
  });
});

describe("untrusted CLI operands", () => {
  it.each(["", " ", "model name", "model\n--tools=bash", "model\u0000", "模型", "x".repeat(201)])("refuses malformed model %j", model => {
    expect(() => buildOmpArgs(input({ model }))).toThrow(/模型 id/);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("refuses invalid time budget %s", maxTimeS => {
    expect(() => buildOmpArgs(input({ maxTimeS }))).toThrow(/正整数秒/);
  });

  it("refuses an unknown executor rather than granting VM capabilities", () => {
    expect(() => buildOmpArgs(input({ executor: "other" as OmpArgsInput["executor"] }))).toThrow(/未知执行器/);
  });

  it.each(["--tools=bash", "@instructions.md", "fixture;bash"])("keeps model %j in the provider operand rather than creating an option or file argument", model => {
    const args = buildOmpArgs(input({ model }));
    expect(valueOf(args, "--model")).toBe(`geekbot/${model}`);
    expect(args).not.toContain(model);
    expect(valueOf(args, "--tools")).toBe("grep");
  });

  it("keeps file paths containing option text as indivisible operands", () => {
    const overlayPath = "/tmp/fixture/overlay --tools bash.json";
    const appendSystemPromptPath = "/tmp/fixture/prompt; --tools write.md";
    const args = buildOmpArgs(input({ overlayPath, appendSystemPromptPath }));
    expect(valueOf(args, "--config")).toBe(overlayPath);
    expect(valueOf(args, "--append-system-prompt")).toBe(appendSystemPromptPath);
    expect(args.filter(arg => arg === "--tools")).toHaveLength(1);
    expect(valueOf(args, "--tools")).toBe("grep");
    expect(args).not.toContain("bash");
    expect(args).not.toContain("write");
  });
});
