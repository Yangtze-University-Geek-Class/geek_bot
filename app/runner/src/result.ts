/**
 * 从最后一条 assistant 文本里取出结构化结果，并按 protocol TASK_RESULT_SCHEMA 的长度与形状校验。
 * 模型只提供 summary、body（审查另有 findings）；补丁永远由 runner 按文件改动生成，模型给的 patch 字段一律忽略。
 */
import type { TaskFinding, TaskKind, TaskResult } from "@geek-bot/protocol";

export const RESULT_LIMITS = Object.freeze({
  summary: 2_000,
  body: 60_000,
  findings: 200,
  path: 1_024,
  message: 4_000,
  patchBytes: 1_048_576,
});

export class ResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResultError";
  }
}

const SEVERITIES: ReadonlySet<string> = new Set(["blocking", "warning", "suggestion"]);

function parseCandidate(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 依次尝试：整段是 JSON；最后一个 ```json 代码块；第一个 { 到最后一个 }。 */
export function extractJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fences = [...trimmed.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  if (fences.length > 0) candidates.push(fences[fences.length - 1][1].trim());
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    const value = parseCandidate(candidate);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  }
  throw new ResultError("模型的最终回复里没有 JSON 对象");
}

function requireString(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") throw new ResultError(`结果字段 ${field} 必须是字符串`);
  if (value.length < min || value.length > max) throw new ResultError(`结果字段 ${field} 长度必须在 ${min} 到 ${max} 之间`);
  return value;
}

function parseFindings(value: unknown): TaskFinding[] {
  if (!Array.isArray(value)) throw new ResultError("审查结果的 findings 必须是数组");
  if (value.length > RESULT_LIMITS.findings) throw new ResultError(`findings 最多 ${RESULT_LIMITS.findings} 条`);
  return value.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new ResultError(`findings[${index}] 必须是对象`);
    const { severity, path, line, message } = item as Record<string, unknown>;
    if (typeof severity !== "string" || !SEVERITIES.has(severity)) throw new ResultError(`findings[${index}].severity 只能是 blocking、warning 或 suggestion`);
    if (typeof line !== "number" || !Number.isInteger(line) || line < 1) throw new ResultError(`findings[${index}].line 必须是从 1 起的整数`);
    return {
      severity: severity as TaskFinding["severity"],
      path: requireString(path, `findings[${index}].path`, 1, RESULT_LIMITS.path),
      line,
      message: requireString(message, `findings[${index}].message`, 1, RESULT_LIMITS.message),
    };
  });
}

/** 按任务类型组装结果；fix/rework 的补丁由调用方传入（runner 生成），必须非空。 */
export function buildTaskResult(kind: TaskKind, finalText: string, patch: string | null): TaskResult {
  const raw = extractJsonObject(finalText);
  const summary = requireString(raw.summary, "summary", 1, RESULT_LIMITS.summary);
  const body = requireString(raw.body ?? "", "body", 0, RESULT_LIMITS.body);
  switch (kind) {
    case "review":
      return { summary, body, findings: parseFindings(raw.findings ?? []) };
    case "triage":
    case "followup":
      return { summary, body };
    case "fix":
    case "rework":
      if (patch === null || patch === "") throw new ResultError("修复任务没有产生任何文件改动");
      if (Buffer.byteLength(patch) > RESULT_LIMITS.patchBytes) throw new ResultError("补丁超过 1 MiB 上限");
      return { summary, body, patch };
    default:
      throw new ResultError(`未知任务类型：${JSON.stringify(kind satisfies never)}`);
  }
}
