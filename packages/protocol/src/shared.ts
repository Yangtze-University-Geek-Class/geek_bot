/** 单实例共享平台的跨包 DTO；凭据不属于公共记录，执行环境只接收任务级凭据。 */
import type { AdminRole, Executor, TaskKind } from "./index.js";

export type ConnectionProvider = "github" | "gitlab" | "feishu" | "webhook";
export type CodeProvider = "github" | "gitlab";
export type WriteMode = "off" | "dry_run" | "on";
export type Capability = "monitor" | "review" | "triage" | "followup" | "fix" | "rework";
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface ConnectionRecord {
  readonly id: string;
  readonly provider: ConnectionProvider;
  readonly name: string;
  readonly base_url: string;
  readonly enabled: boolean;
  readonly status: string;
  readonly account_name: string | null;
  readonly capabilities: readonly Capability[];
  readonly secret_configured: boolean;
  readonly revision: number;
  readonly created_at: string;
}

export interface ProjectRecord {
  readonly id: string;
  readonly connection_id: string;
  readonly external_id: string;
  readonly name: string;
  readonly path: string;
  readonly url: string;
  readonly default_branch: string;
  readonly private: boolean;
  readonly archived: boolean;
  readonly permission: string;
  readonly capabilities: readonly Capability[];
  readonly status: "active" | "lost";
  readonly enabled: boolean;
  readonly write_mode: WriteMode;
  readonly review_enabled: boolean;
  readonly triage_enabled: boolean;
  readonly fix_enabled: boolean;
  readonly rework_enabled: boolean;
  readonly machine_ids: readonly string[];
  readonly tags: readonly string[];
  readonly revision: number;
  readonly updated_at: string;
}

export interface ItemRecord {
  readonly id: string;
  readonly project_id: string;
  readonly external_id: string;
  readonly kind: "issue" | "change";
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly state: string;
  readonly author: string;
  readonly bot_authored: boolean;
  readonly active_task: { readonly id: string; readonly kind: TaskKind; readonly status: TaskStatus } | null;
  readonly head_sha: string | null;
  readonly base_sha: string | null;
  readonly updated_at: string;
}

export type DemandStatus = "new" | "blocked" | "queued" | "running" | "completed" | "failed";
export interface DemandRecord {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly project_id: string | null;
  readonly source: "manual" | ConnectionProvider;
  readonly source_ref: string;
  readonly source_connection_id: string | null;
  readonly status: DemandStatus;
  readonly revision: number;
  readonly created_by: number | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ResourceBudget { readonly cpu: number; readonly memory_mib: number }
export interface ExecutorSlots { readonly sandbox: number; readonly vm: number }
export type MachineStatus = "pending" | "cordoned" | "ready" | "draining" | "offline";
export interface MachineRecord {
  readonly id: string;
  readonly name: string;
  readonly status: MachineStatus;
  readonly trust: "standard" | "high";
  readonly tags: readonly string[];
  readonly slots: ExecutorSlots;
  readonly capacity: ResourceBudget;
  readonly used: ResourceBudget & ExecutorSlots;
  readonly last_seen_at: string | null;
  readonly revision: number;
}

export type TaskStatus = "queued" | "running" | "awaiting_publish" | "completed" | "failed" | "cancelled" | "superseded";
export interface TaskFinding {
  readonly severity: "blocking" | "warning" | "suggestion";
  readonly path: string;
  readonly line: number;
  readonly message: string;
}
export interface TaskResult {
  readonly summary: string;
  readonly body: string;
  readonly findings?: readonly TaskFinding[];
  readonly patch?: string;
}
export interface TaskRecord {
  readonly id: string;
  readonly project_id: string;
  readonly demand_id: string | null;
  readonly item_id: string | null;
  readonly kind: TaskKind;
  readonly executor: Executor;
  readonly status: TaskStatus;
  readonly priority: number;
  readonly resources: ResourceBudget;
  readonly machine_id: string | null;
  readonly epoch: number;
  readonly lease_id: string | null;
  readonly head_sha: string | null;
  readonly base_sha: string | null;
  readonly lease_expires_at: string | null;
  readonly result: TaskResult | null;
  readonly error: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ModelPoolEntry { readonly model: string; readonly effort: string }
export interface ExecutionTask extends TaskRecord {
  readonly task_id: string;
  readonly lease_id: string;
  readonly model_token: string;
  readonly model_pool: readonly ModelPoolEntry[];
  readonly timeout_s: number;
  readonly bundle_sha256: string;
  readonly prompt: string;
  readonly tools: readonly string[];
  readonly api_style: "openai";
}
export interface BundleFile {
  readonly path: string;
  readonly content: string;
  readonly encoding: "utf8" | "base64";
}
export interface TaskBundle {
  readonly files: readonly BundleFile[];
  readonly diff: string;
  readonly rules: readonly { readonly path: string; readonly content: string }[];
  readonly meta: { readonly [key: string]: JsonValue };
}
export interface TaskEvent {
  readonly seq: number;
  readonly at: string;
  readonly kind: "text" | "tool" | "error" | "retry" | "model";
  readonly text: string;
}
export interface LeaseFence { readonly lease_id: string; readonly epoch: number }
export interface MachineHeartbeat {
  readonly name: string;
  readonly protocol_version: number;
  readonly capacity: ResourceBudget;
  readonly slots: ExecutorSlots;
  readonly tags: readonly string[];
  readonly health: { readonly [key: string]: JsonValue };
}
export interface HeartbeatReply {
  readonly machine_id: string;
  readonly status: MachineStatus;
  readonly lease_lost_after_s: number;
  readonly cancel_task_ids: readonly string[];
}
export interface LeaseRequest {
  readonly available: ExecutorSlots;
  readonly resources: ResourceBudget;
  readonly wait_s: number;
}
export interface OverviewResponse {
  readonly projects: number;
  readonly demands: number;
  readonly machines: number;
  readonly queued: number;
  readonly running: number;
  readonly awaiting_publish: number;
  readonly failed: number;
  readonly connections: number;
}
export interface PlatformAdministrator {
  readonly github_id: number;
  readonly login: string;
  readonly role: AdminRole;
}

export interface AuthStateResponse {
  readonly claimed: boolean;
  readonly login_methods: readonly string[];
  readonly insecure_context: boolean;
  readonly bot_bound: boolean;
}
export type DeviceFlowPurpose = "claim" | "login" | "reauth" | "connection";
export interface DeviceFlowStartRequest {
  readonly purpose: DeviceFlowPurpose;
  readonly connection_id?: string;
}
export interface DeviceFlowStartResponse {
  readonly flow_id: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly expires_in_s: number;
  readonly interval_s: number;
}
export interface DeviceFlowPollResponse {
  readonly status: "pending" | "slow_down" | "expired" | "denied" | "done";
}
/** 仅用于配置请求；绝不成为连接列表、任务包或审计记录的一部分。 */
export interface ConnectionCredentials {
  readonly token?: string;
  readonly app_id?: string;
  readonly app_secret?: string;
  readonly verification_token?: string;
  readonly encrypt_key?: string;
  readonly signing_secret?: string;
  readonly webhook_url?: string;
}
export interface MachineSecretResponse {
  readonly machine: MachineRecord;
  readonly node_token: string;
}
export interface DiscoverResponse { readonly discovered: number; readonly lost: number }
export interface SyncResponse { readonly projects: number; readonly items: number }
export interface ProjectSyncResponse { readonly items: number }
export interface CatalogModel {
  readonly id: string;
  readonly name: string;
  readonly efforts: readonly string[];
}
export interface ModelPool {
  readonly kind: TaskKind;
  readonly entries: readonly ModelPoolEntry[];
  readonly revision: number;
}
export interface ModelPoolsResponse {
  readonly catalog: { readonly models: readonly CatalogModel[]; readonly error: string | null };
  readonly pools: readonly ModelPool[];
}

/** Fastify 和节点协议校验复用的 JSON Schema；对象边界拒绝未知字段。 */
export const RESOURCE_BUDGET_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false, required: ["cpu", "memory_mib"],
  properties: { cpu: { type: "integer", minimum: 1, maximum: 256 }, memory_mib: { type: "integer", minimum: 128, maximum: 1048576 } },
} as const);
export const EXECUTOR_SLOTS_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false, required: ["sandbox", "vm"],
  properties: { sandbox: { type: "integer", minimum: 0, maximum: 256 }, vm: { type: "integer", minimum: 0, maximum: 256 } },
} as const);
export const LEASE_FENCE_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false, required: ["lease_id", "epoch"],
  properties: { lease_id: { type: "string", minLength: 1, maxLength: 128 }, epoch: { type: "integer", minimum: 1 } },
} as const);
export const TASK_RESULT_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false, required: ["summary", "body"],
  properties: {
    summary: { type: "string", minLength: 1, maxLength: 2000 }, body: { type: "string", maxLength: 60000 },
    patch: { type: "string", maxLength: 1048576 },
    findings: { type: "array", maxItems: 200, items: {
      type: "object", additionalProperties: false, required: ["severity", "path", "line", "message"],
      properties: { severity: { enum: ["blocking", "warning", "suggestion"] }, path: { type: "string", maxLength: 1024 }, line: { type: "integer", minimum: 1 }, message: { type: "string", maxLength: 4000 } },
    } },
  },
} as const);
