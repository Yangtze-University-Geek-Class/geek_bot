import { describe, expect, it } from "vitest";
import { ISSUE_CHANNEL_TOOLS, buildOmpArgs } from "../../app/runner/src/index.js";
import type { Channel } from "../../packages/protocol/src/index.js";

/** omp 里能改文件、执行命令或联网的工具；issue 通道一个都不能给。 */
const WRITE_OR_EXEC_TOOLS = ["bash", "edit", "ast_edit", "write", "eval", "task", "github", "browser", "web_search", "fetch"];

function valueOf(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe("omp 参数", () => {
  it("两条通道都带 -p <prompt>、--mode json、--no-extensions、--no-lsp、--approval-mode yolo", () => {
    for (const channel of ["issue", "pr"] as const) {
      const args = buildOmpArgs({ channel, prompt: "@prompt.md" });
      expect(args.slice(0, 2)).toEqual(["-p", "@prompt.md"]);
      expect(valueOf(args, "--mode")).toBe("json");
      expect(args).toContain("--no-extensions");
      expect(args).toContain("--no-lsp");
      expect(valueOf(args, "--approval-mode")).toBe("yolo");
    }
  });

  it("issue 通道用 --tools 只给 read、grep、glob", () => {
    const args = buildOmpArgs({ channel: "issue", prompt: "按 prompt.md 受理这个 issue" });
    expect(args).toEqual(["-p", "按 prompt.md 受理这个 issue", "--mode", "json", "--no-extensions", "--no-lsp", "--approval-mode", "yolo", "--tools", "read,grep,glob"]);
    expect(args.filter(arg => arg === "--tools")).toHaveLength(1);
    const tools = valueOf(args, "--tools")?.split(",");
    expect(tools).toEqual(["read", "grep", "glob"]);
    expect([...ISSUE_CHANNEL_TOOLS]).toEqual(["read", "grep", "glob"]);
    for (const tool of WRITE_OR_EXEC_TOOLS) expect(tools).not.toContain(tool);
    expect(Object.isFrozen(ISSUE_CHANNEL_TOOLS)).toBe(true);
  });

  it("pr 通道目前不带 --tools（工具白名单由 #17 加入）", () => {
    const args = buildOmpArgs({ channel: "pr", prompt: "@prompt.md" });
    expect(args).not.toContain("--tools");
    expect(args).toEqual(["-p", "@prompt.md", "--mode", "json", "--no-extensions", "--no-lsp", "--approval-mode", "yolo"]);
  });

  it("每次返回新数组，调用方改动不影响下一次", () => {
    const first = buildOmpArgs({ channel: "issue", prompt: "@prompt.md" });
    first.push("--tools", "bash");
    expect(buildOmpArgs({ channel: "issue", prompt: "@prompt.md" })).not.toContain("bash");
  });

  it("提示为空、以 - 开头或通道未知时拒绝", () => {
    expect(() => buildOmpArgs({ channel: "issue", prompt: "  " })).toThrow("omp 提示不能为空");
    expect(() => buildOmpArgs({ channel: "pr", prompt: "--tools=bash" })).toThrow("omp 提示不能以 - 开头");
    expect(() => buildOmpArgs({ channel: "push" as unknown as Channel, prompt: "@prompt.md" })).toThrow("未知通道");
  });
});
