/**
 * omp（钉死 18.4.4）的命令行参数。每个参数都已按 omp 的 CLI 文档与实测核对：
 *   -p --mode json            非交互，stdout 输出 JSONL 事件；提示从 stdin 读入（不受 argv 长度限制，也不会被当作选项）
 *   --config <overlay>        本次运行的设置层：关闭全部发现源（AGENTS.md、CLAUDE.md、.omp、.claude、mcp.json 等）
 *   --model geekbot/<id>      只用 runner 生成的 models.yml 里的那个模型
 *   --no-extensions --no-skills --no-rules --no-lsp --no-session --no-title --no-pty
 *   --approval-mode yolo      不等人工确认；隔离由 sandbox 与一次性 VM 保证，工具由 --tools 白名单限定
 *   --tools <list>            工具白名单：两种执行器都必须显式给出，不存在「默认全部工具」的路径
 *   --max-time <s>            本次尝试的时长上限
 *   --append-system-prompt <file>  base 分支规则与结果格式说明
 * runner 只能用 Node 标准库；对 @geek-bot/protocol 只做 type 导入。
 */
import type { Executor } from "@geek-bot/protocol";

/** omp 内置工具里只读的三个；sandbox（无网、根只读）只能用它们。 */
export const READ_ONLY_TOOLS = Object.freeze(["read", "grep", "glob"] as const);
/** VM 里额外允许改文件和执行命令；联网、子代理、浏览器、eval、MCP 一类工具不在任何白名单里。 */
export const VM_TOOLS = Object.freeze(["read", "grep", "glob", "edit", "write", "bash"] as const);

/** omp `--thinking` 接受的档位。模型池里的档位不在其中时不传 --thinking。 */
export const OMP_THINKING_LEVELS: ReadonlySet<string> = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** runner 生成的 models.yml 里唯一的 provider id。 */
export const RELAY_PROVIDER_ID = "geekbot";

export interface OmpArgsInput {
  readonly executor: Executor;
  /** 任务要求的工具；必须是执行器白名单的非空子集。 */
  readonly tools: readonly string[];
  readonly model: string;
  readonly effort: string;
  readonly overlayPath: string;
  readonly appendSystemPromptPath: string;
  readonly maxTimeS: number;
}

/** 执行器允许的工具白名单。 */
export function allowedTools(executor: Executor): readonly string[] {
  switch (executor) {
    case "sandbox":
      return READ_ONLY_TOOLS;
    case "vm":
      return VM_TOOLS;
    default:
      throw new Error(`未知执行器：${JSON.stringify(executor satisfies never)}`);
  }
}

/** 返回一份新的参数数组；工具不在白名单、模型 id 为空或时长不合法时抛错。 */
export function buildOmpArgs(input: OmpArgsInput): string[] {
  const allowed = allowedTools(input.executor);
  if (input.tools.length === 0) throw new Error("任务没有给出工具白名单");
  const rejected = input.tools.filter(tool => !allowed.includes(tool));
  if (rejected.length > 0) throw new Error(`执行器 ${input.executor} 不允许这些工具：${rejected.join(",")}`);
  if (!/^[\x21-\x7e]{1,200}$/.test(input.model)) throw new Error("模型 id 不合法");
  if (!Number.isInteger(input.maxTimeS) || input.maxTimeS < 1) throw new Error("omp 时长上限必须是正整数秒");
  const args = [
    "-p",
    "--mode", "json",
    "--config", input.overlayPath,
    "--model", `${RELAY_PROVIDER_ID}/${input.model}`,
    "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--no-session", "--no-title", "--no-pty",
    "--approval-mode", "yolo",
    "--tools", [...new Set(input.tools)].join(","),
    "--max-time", String(input.maxTimeS),
    "--append-system-prompt", input.appendSystemPromptPath,
  ];
  if (OMP_THINKING_LEVELS.has(input.effort)) args.push("--thinking", input.effort);
  return args;
}
