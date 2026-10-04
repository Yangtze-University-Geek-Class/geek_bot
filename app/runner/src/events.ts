/**
 * 把 omp `--mode json` 的 JSONL 事件归并成任务事件（protocol TaskEvent 去掉 seq，seq 由节点分配），
 * 并记下判断本次尝试结果所需的状态：最后一条 assistant 消息的文本、stopReason、错误码与是否见到终止的 agent_end。
 * 事件形状按 omp 18.4.4 实测：message_end（message.role/content/stopReason/errorStatus/errorMessage）、
 * tool_execution_start/end（toolName、args、isError）、auto_retry_start（attempt、maxAttempts、errorMessage）、
 * agent_end（isTerminal 缺省视为终止）。
 */
import type { TaskEvent } from "@geek-bot/protocol";

export type RunnerEvent = Omit<TaskEvent, "seq">;

export interface AttemptState {
  /** 最后一条 assistant 消息的全部文本块。 */
  finalText: string;
  stopReason: string | null;
  errorStatus: number | null;
  errorMessage: string | null;
  /** 见到 isTerminal !== false 的 agent_end。 */
  terminal: boolean;
  outputTokens: number;
}

const MAX_EVENT_TEXT = 4_000;

function clip(text: string, max = MAX_EVENT_TEXT): string {
  return text.length > max ? `${text.slice(0, max)}…（已截断）` : text;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function textOf(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record && record.type === "text" && typeof record.text === "string") parts.push(record.text);
  }
  return parts.join("");
}

function summarizeArgs(args: unknown): string {
  const record = asRecord(args);
  if (!record) return "";
  for (const key of ["path", "pattern", "command", "glob"]) {
    const value = record[key];
    if (typeof value === "string") return clip(value, 300);
  }
  return clip(JSON.stringify(record), 300);
}

export function createAttemptState(): AttemptState {
  return { finalText: "", stopReason: null, errorStatus: null, errorMessage: null, terminal: false, outputTokens: 0 };
}

/** 处理一行 omp 输出；返回要转发的任务事件（可能没有）。不是 JSON 的行原样作为 text 事件。 */
export function mapOmpLine(line: string, state: AttemptState, now: () => string): RunnerEvent | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { at: now(), kind: "text", text: clip(trimmed) };
  }
  const event = asRecord(parsed);
  if (!event) return null;
  switch (event.type) {
    case "message_end": {
      const message = asRecord(event.message);
      if (!message || message.role !== "assistant") return null;
      const text = textOf(message);
      state.finalText = text;
      state.stopReason = typeof message.stopReason === "string" ? message.stopReason : null;
      state.errorStatus = typeof message.errorStatus === "number" ? message.errorStatus : null;
      state.errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : null;
      const usage = asRecord(message.usage);
      if (usage && typeof usage.output === "number") state.outputTokens += usage.output;
      if (state.stopReason === "error") return { at: now(), kind: "error", text: clip(`模型请求失败（${state.errorStatus ?? "无状态码"}）：${state.errorMessage ?? ""}`) };
      return text ? { at: now(), kind: "text", text: clip(text) } : null;
    }
    case "tool_execution_start": {
      const name = typeof event.toolName === "string" ? event.toolName : "tool";
      return { at: now(), kind: "tool", text: clip(`${name} ${summarizeArgs(event.args)}`.trim()) };
    }
    case "tool_execution_end":
      if (event.isError === true) {
        const name = typeof event.toolName === "string" ? event.toolName : "tool";
        return { at: now(), kind: "error", text: clip(`${name} 执行失败`) };
      }
      return null;
    case "auto_retry_start":
      return {
        at: now(),
        kind: "retry",
        text: clip(`omp 重试 ${String(event.attempt ?? "?")}/${String(event.maxAttempts ?? "?")}：${typeof event.errorMessage === "string" ? event.errorMessage : ""}`),
      };
    case "agent_end":
      if (event.isTerminal !== false) state.terminal = true;
      return null;
    default:
      return null;
  }
}
