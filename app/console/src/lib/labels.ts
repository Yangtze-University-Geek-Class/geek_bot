/**
 * 接口里的机器值到中文名与状态色调的映射；界面不直接显示机器值。本文件不导入 Vue。
 * 色调取 TxStatusBadge 的 status：success、warning、danger、info、muted。
 */
import type {
  AdminRole,
  Capability,
  ConnectionProvider,
  DemandStatus,
  Executor,
  MachineStatus,
  TaskKind,
  TaskStatus,
  WriteMode,
} from "@geek-bot/protocol";

export type Tone = "success" | "warning" | "danger" | "info" | "muted";

export interface Labeled {
  readonly label: string;
  readonly tone: Tone;
}

export const ROLE_LABELS: Readonly<Record<AdminRole, string>> = { owner: "所有者", operator: "操作员", viewer: "只读成员" };

export const PROVIDER_LABELS: Readonly<Record<ConnectionProvider, string>> = {
  github: "GitHub",
  gitlab: "GitLab",
  feishu: "飞书",
  webhook: "签名 Webhook",
};

export const WRITE_MODE_LABELS: Readonly<Record<WriteMode, Labeled>> = {
  off: { label: "关闭写入", tone: "muted" },
  dry_run: { label: "演练（只记录不发送）", tone: "info" },
  on: { label: "真实写入", tone: "warning" },
};

export const TASK_KIND_LABELS: Readonly<Record<TaskKind, string>> = {
  review: "审查变更",
  triage: "受理 issue",
  followup: "跟进回复",
  fix: "修复并开变更",
  rework: "返工自己的变更",
};

export const EXECUTOR_LABELS: Readonly<Record<Executor, string>> = {
  sandbox: "只读 sandbox",
  vm: "一次性 VM",
};

/** 任务类型的取值，顺序与表单、模型池页一致（console 对 protocol 只做 type 导入，不引用它的运行时常量）。 */
export const TASK_KIND_VALUES = Object.keys(TASK_KIND_LABELS) as TaskKind[];

export function isTaskKind(value: unknown): value is TaskKind {
  return typeof value === "string" && Object.hasOwn(TASK_KIND_LABELS, value);
}

/** 修复与返工要写代码，只能在一次性 VM 里执行；审查、受理、跟进可以用只读 sandbox。 */
export const VM_ONLY_KINDS: Readonly<Record<TaskKind, boolean>> = { review: false, triage: false, followup: false, fix: true, rework: true };

export const CAPABILITY_LABELS: Readonly<Record<Capability, string>> = {
  monitor: "监控",
  review: "审查",
  triage: "受理",
  followup: "跟进",
  fix: "修复",
  rework: "返工",
};

export const TASK_STATUS_LABELS: Readonly<Record<TaskStatus, Labeled>> = {
  queued: { label: "排队中", tone: "info" },
  running: { label: "运行中", tone: "info" },
  awaiting_publish: { label: "待发布", tone: "warning" },
  completed: { label: "已完成", tone: "success" },
  failed: { label: "失败", tone: "danger" },
  cancelled: { label: "已取消", tone: "muted" },
  superseded: { label: "已被新任务取代", tone: "muted" },
};

export const DEMAND_STATUS_LABELS: Readonly<Record<DemandStatus, Labeled>> = {
  new: { label: "新需求", tone: "info" },
  blocked: { label: "受阻", tone: "warning" },
  queued: { label: "已排队", tone: "info" },
  running: { label: "执行中", tone: "info" },
  completed: { label: "已完成", tone: "success" },
  failed: { label: "失败", tone: "danger" },
};

export const DEMAND_SOURCE_LABELS: Readonly<Record<"manual" | ConnectionProvider, string>> = {
  manual: "后台录入",
  ...PROVIDER_LABELS,
};

export const MACHINE_STATUS_LABELS: Readonly<Record<MachineStatus, Labeled>> = {
  pending: { label: "等待首次心跳", tone: "muted" },
  cordoned: { label: "已停止派发", tone: "warning" },
  ready: { label: "可接任务", tone: "success" },
  draining: { label: "排空中", tone: "warning" },
  offline: { label: "离线", tone: "danger" },
};

export const TRUST_LABELS: Readonly<Record<"standard" | "high", string>> = { standard: "标准", high: "高信任" };

export const PROJECT_STATUS_LABELS: Readonly<Record<"active" | "lost", Labeled>> = {
  active: { label: "可访问", tone: "success" },
  lost: { label: "已失去访问", tone: "danger" },
};

/** 任务是否已经结束：结束的任务不再刷新，也不能取消。 */
export const TASK_TERMINAL: Readonly<Record<TaskStatus, boolean>> = {
  queued: false,
  running: false,
  awaiting_publish: false,
  completed: true,
  failed: true,
  cancelled: true,
  superseded: true,
};

const CONNECTION_STATUS_LABELS: Readonly<Record<string, Labeled>> = {
  ok: { label: "正常", tone: "success" },
  active: { label: "正常", tone: "success" },
  unbound: { label: "未绑定账号", tone: "warning" },
  pending: { label: "等待配置", tone: "warning" },
  error: { label: "出错", tone: "danger" },
  invalid: { label: "凭据无效", tone: "danger" },
  disabled: { label: "已停用", tone: "muted" },
};

/** 连接状态是 control 给的自由字符串；认识的几种给中文名，不认识的原样显示。 */
export function connectionStatus(status: string, enabled: boolean): Labeled {
  if (!enabled) return { label: "已停用", tone: "muted" };
  return CONNECTION_STATUS_LABELS[status] ?? { label: status, tone: "info" };
}
