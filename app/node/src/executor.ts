/**
 * 执行器（sandbox 槽位池、QEMU/KVM VM 池）与任务编排之间的接口，以及对 runner 交回内容的校验。
 * runner 跑在不可信的环境里：事件与结果都按 protocol 的形状和长度重新核对，不合格的结果按 schema 失败处理。
 */
import type { ExecutionTask, TaskEvent, TaskResult } from "@geek-bot/protocol";
import type { FailureCode } from "./control-client.js";

export type RunnerEventInput = Omit<TaskEvent, "seq">;

export interface ExecutionSink {
  emit(event: RunnerEventInput): void;
}

export type ExecutionOutcome =
  | { readonly kind: "result"; readonly result: TaskResult }
  | { readonly kind: "failure"; readonly code: FailureCode; readonly message: string };

export interface ExecutionHandle {
  readonly done: Promise<ExecutionOutcome>;
  /** 请求停止：sandbox 通知 runner 停下 omp，VM 发 ACPI 关机；宽限期后强制结束。结果为 cancelled。 */
  cancel(): void;
  /** 立即强制销毁，不再等任何结果（401、失联、租约被收回）。 */
  destroy(): void;
}

export interface TaskExecutor {
  /** 现在还能接的任务数。 */
  free(): number;
  start(task: ExecutionTask, bundle: Buffer, sink: ExecutionSink): ExecutionHandle;
  /** 销毁全部在跑的任务。 */
  destroyAll(): void;
}

/** runner 能报告的失败码（其余失败码只由节点自己产生）。 */
export const RUNNER_FAILURE_CODES: ReadonlySet<string> = new Set(["bundle_invalid", "infra_failure", "timeout", "model", "schema", "cancelled"]);

const EVENT_KINDS: ReadonlySet<string> = new Set(["text", "tool", "error", "retry", "model"]);
const SEVERITIES: ReadonlySet<string> = new Set(["blocking", "warning", "suggestion"]);
const MAX_EVENT_TEXT = 8_000;

/** 核对 runner 发来的一条事件；不合格返回 null。时间不可信时改用节点时间。 */
export function normalizeRunnerEvent(value: unknown): RunnerEventInput | null {
  if (typeof value !== "object" || value === null) return null;
  const { kind, text, at } = value as Record<string, unknown>;
  if (typeof kind !== "string" || !EVENT_KINDS.has(kind) || typeof text !== "string") return null;
  const timestamp = typeof at === "string" && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : new Date().toISOString();
  return { at: timestamp, kind: kind as TaskEvent["kind"], text: text.length > MAX_EVENT_TEXT ? `${text.slice(0, MAX_EVENT_TEXT)}…` : text };
}

/** 按 TASK_RESULT_SCHEMA 核对结果；不合格抛 Error（消息给 control 看）。审查结果不得带 patch，fix/rework 必须带。 */
export function validateTaskResult(kind: ExecutionTask["kind"], value: unknown): TaskResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("结果不是对象");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!["summary", "body", "findings", "patch"].includes(key)) throw new Error(`结果里有不认识的字段 ${key}`);
  const { summary, body, findings, patch } = record;
  if (typeof summary !== "string" || summary.length < 1 || summary.length > 2_000) throw new Error("summary 长度必须在 1 到 2000 之间");
  if (typeof body !== "string" || body.length > 60_000) throw new Error("body 必须是不超过 60000 字的字符串");
  const result: { summary: string; body: string; findings?: TaskResult["findings"]; patch?: string } = { summary, body };
  if (findings !== undefined) {
    if (!Array.isArray(findings) || findings.length > 200) throw new Error("findings 必须是不超过 200 条的数组");
    result.findings = findings.map((item, index) => {
      if (typeof item !== "object" || item === null) throw new Error(`findings[${index}] 不是对象`);
      const finding = item as Record<string, unknown>;
      if (Object.keys(finding).some(key => !["severity", "path", "line", "message"].includes(key))) throw new Error(`findings[${index}] 有不认识的字段`);
      if (typeof finding.severity !== "string" || !SEVERITIES.has(finding.severity)) throw new Error(`findings[${index}].severity 不合法`);
      if (typeof finding.path !== "string" || finding.path.length > 1_024) throw new Error(`findings[${index}].path 不合法`);
      if (typeof finding.line !== "number" || !Number.isInteger(finding.line) || finding.line < 1) throw new Error(`findings[${index}].line 不合法`);
      if (typeof finding.message !== "string" || finding.message.length > 4_000) throw new Error(`findings[${index}].message 不合法`);
      return { severity: finding.severity as "blocking" | "warning" | "suggestion", path: finding.path, line: finding.line, message: finding.message };
    });
  }
  if (patch !== undefined) {
    if (typeof patch !== "string" || Buffer.byteLength(patch) > 1_048_576) throw new Error("patch 必须是不超过 1 MiB 的字符串");
    result.patch = patch;
  }
  if ((kind === "fix" || kind === "rework") && !result.patch) throw new Error("fix 与 rework 的结果必须带补丁");
  if (kind !== "fix" && kind !== "rework" && result.patch !== undefined) throw new Error(`${kind} 的结果不能带补丁`);
  return result;
}

/** runner 需要的任务字段：不含租约、令牌与 control 内部字段。 */
export function runnerTaskOf(task: ExecutionTask): Record<string, unknown> {
  return {
    task_id: task.task_id,
    kind: task.kind,
    executor: task.executor,
    timeout_s: task.timeout_s,
    bundle_sha256: task.bundle_sha256,
    prompt: task.prompt,
    tools: task.tools,
    model_pool: task.model_pool,
  };
}
