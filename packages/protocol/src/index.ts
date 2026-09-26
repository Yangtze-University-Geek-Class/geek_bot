/**
 * control、node、runner、console 共用的协议类型与少量常量。
 * 本包只放类型和常量，不导入任何 app，也不依赖 Node 或浏览器运行时。
 */

/** 节点协议版本（整数，当前为 v1）。control 支持 N 与 N-1，不兼容的节点只收心跳、不派任务。 */
export const NODE_PROTOCOL_VERSION = 1;
export type NodeProtocolVersion = typeof NODE_PROTOCOL_VERSION;

/** 任务类型。review：审查 PR；triage：受理 issue；followup：跟进追问后的回复；fix：修 issue 并开 PR；rework：按审查意见返工机器人自己的 PR。 */
export const TASK_KINDS = Object.freeze(["review", "triage", "followup", "fix", "rework"] as const);
export type TaskKind = (typeof TASK_KINDS)[number];

/** 通道。issue 通道只读、不开 VM；pr 通道每个任务一台临时 VM。 */
export const CHANNELS = Object.freeze(["issue", "pr"] as const);
export type Channel = (typeof CHANNELS)[number];

/** 执行器。sandbox：无网、根只读的独立容器；vm：节点容器里的一次性 QEMU/KVM 虚拟机，任务结束即销毁。 */
export const EXECUTORS = Object.freeze(["sandbox", "vm"] as const);
export type Executor = (typeof EXECUTORS)[number];

/** 任务类型到通道的映射：triage、followup 走 issue 通道；review、fix、rework 走 pr 通道。 */
export const TASK_CHANNEL: Readonly<Record<TaskKind, Channel>> = Object.freeze({
  review: "pr",
  triage: "issue",
  followup: "issue",
  fix: "pr",
  rework: "pr",
});

/** 通道到执行器的映射：issue 通道用 sandbox，不开 VM；pr 通道每个任务一台临时 VM。 */
export const CHANNEL_EXECUTOR: Readonly<Record<Channel, Executor>> = Object.freeze({
  issue: "sandbox",
  pr: "vm",
});

/** PR 通道里任务的来由，用于排优先级。 */
export type PrPriorityReason =
  | "review_others_pr"
  | "rework_own_pr"
  | "fix_assigned_issue"
  | "fix_self_chosen_issue";

export interface PrPriorityEntry {
  readonly reason: PrPriorityReason;
  readonly kind: TaskKind;
  /** 数字越小越先派发。 */
  readonly priority: number;
}

/**
 * PR 通道的默认优先级，按先后排列：
 * 审查别人的 PR > 返工机器人自己的 PR > 修分给机器人的 issue > 修机器人自己决定修的 issue。
 */
export const PR_CHANNEL_PRIORITY: readonly PrPriorityEntry[] = Object.freeze([
  Object.freeze({ reason: "review_others_pr", kind: "review", priority: 10 }),
  Object.freeze({ reason: "rework_own_pr", kind: "rework", priority: 20 }),
  Object.freeze({ reason: "fix_assigned_issue", kind: "fix", priority: 30 }),
  Object.freeze({ reason: "fix_self_chosen_issue", kind: "fix", priority: 40 }),
] satisfies PrPriorityEntry[]);

// ---------------------------------------------------------------------------
// 后台 API 的共用形状（docs/architecture/API.md「约定」）。console 只对这些类型做 type 导入；
// 端点的请求与响应以 control 路由的 contracts.ts 为准，随各端点的 issue 增加并与这里保持一致。
// ---------------------------------------------------------------------------

/** 所有错误响应的形状：只有 code 与 message。code 是稳定的 snake_case 标识，console 按它分支；message 只给人看。 */
export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

/** 列表响应：游标分页，最后一页 next_cursor 为 null。 */
export interface ApiList<T> {
  readonly items: readonly T[];
  readonly next_cursor: string | null;
}

/** 后台角色（ADR-0002）：owner 认领实例；operator 做日常操作；viewer 只读。 */
export type AdminRole = "owner" | "operator" | "viewer";

/** A-08 `GET /api/v1/me`：当前会话的账号。时间是 ISO 8601 的 UTC 字符串。 */
export interface MeResponse {
  readonly github_id: number;
  readonly login: string;
  readonly role: AdminRole;
  readonly is_bot_account: boolean;
  readonly reauth_valid_until: string | null;
  readonly session_expires_at: string;
}

/**
 * A-55 `GET /api/release`：发布身份。display 是界面上显示的版本
 * （正式 `X.Y.Z`，预发布 `X.Y.Z-rc.N@<sha12>`，本机「本地开发 · 未发布」），由部署脚本写入运行时环境。
 */
export interface ReleaseInfo {
  readonly display: string;
  readonly version: string;
  readonly commit: string;
}

/** A-56 `GET /api/v1/stream` 的 topic：每个连接最多 20 个。 */
export type StreamTopic = "overview" | "queue" | "nodes" | "repos" | "alerts" | `task:${string}`;
