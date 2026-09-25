/**
 * 根据通道拼 omp 的命令行参数。
 * runner 只能用 Node 标准库；对 @geek-bot/protocol 只做 type 导入，编译后不留运行时依赖。
 */
import type { Channel } from "@geek-bot/protocol";

/** issue 通道只给这三个只读工具，不给 bash、edit、write 这类能改文件或执行命令的工具。 */
export const ISSUE_CHANNEL_TOOLS = Object.freeze(["read", "grep", "glob"] as const);

/**
 * 两条通道都带的参数（-p 与提示之后）：
 * --mode json 输出 JSONL 事件；--no-extensions 不加载扩展；--no-lsp 不启用 LSP 工具、格式化和诊断；
 * --approval-mode yolo 不等人工确认（隔离由 sandbox 与一次性 VM 保证）。
 */
const COMMON_FLAGS = Object.freeze(["--mode", "json", "--no-extensions", "--no-lsp", "--approval-mode", "yolo"] as const);

export interface OmpArgsInput {
  readonly channel: Channel;
  /** 交给 omp 的提示；以 @ 开头时 omp 把它当作文件引用。 */
  readonly prompt: string;
}

/**
 * 按通道返回一份新的参数数组：总是 -p <prompt> 加上 COMMON_FLAGS。
 * issue 通道另加 --tools read,grep,glob。pr 通道目前不带 --tools：工具白名单由 #17 加入（清单来自 TaskSpec 的 omp 参数），
 * 见 docs/services/runner/README.md「已知限制」。
 */
export function buildOmpArgs(input: OmpArgsInput): string[] {
  const { channel, prompt } = input;
  if (prompt.trim() === "") throw new Error("omp 提示不能为空");
  // -p 是开关，提示是随后的位置参数；以 - 开头的提示会被 omp 当成选项解析。
  if (prompt.startsWith("-")) throw new Error("omp 提示不能以 - 开头");
  const args = ["-p", prompt, ...COMMON_FLAGS];
  switch (channel) {
    case "issue":
      args.push("--tools", ISSUE_CHANNEL_TOOLS.join(","));
      return args;
    case "pr":
      return args;
    default:
      throw new Error(`未知通道：${JSON.stringify(channel satisfies never)}`);
  }
}
