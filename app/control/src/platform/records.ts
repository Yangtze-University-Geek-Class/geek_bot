/**
 * 库行与公共记录之间的唯一转换（0002_shared_platform.sql ↔ @geek-bot/protocol）。
 * 每个序列化函数逐字段列出公共字段：密文、哈希、内部列永远不会被展开进响应、事件或审计。
 */
import type {
  Capability,
  ConnectionProvider,
  ConnectionRecord,
  DemandRecord,
  DemandStatus,
  Executor,
  ItemRecord,
  MachineRecord,
  MachineStatus,
  PlatformAdministrator,
  ProjectRecord,
  TaskEvent,
  TaskKind,
  TaskRecord,
  TaskResult,
  TaskStatus,
  WriteMode,
} from "@geek-bot/protocol";
import type { AdminRole } from "@geek-bot/protocol";
import { iso, isoOrNull, parseJsonColumn } from "./http.js";

export interface AdminRow {
  github_id: number;
  login: string;
  role: AdminRole;
  note: string | null;
  invited_by: number | null;
  invited_at: number;
  last_login_at: number | null;
}

/** 管理员列表项：PlatformAdministrator 加 A-09 的邀请与登录时间。 */
export interface AdminView extends PlatformAdministrator {
  readonly invited_by: number | null;
  readonly invited_at: string;
  readonly last_login_at: string | null;
}

export function adminRecord(row: AdminRow): AdminView {
  return {
    github_id: row.github_id,
    login: row.login,
    role: row.role,
    invited_by: row.invited_by,
    invited_at: iso(row.invited_at),
    last_login_at: isoOrNull(row.last_login_at),
  };
}

export interface ConnectionRow {
  id: string;
  provider: ConnectionProvider;
  name: string;
  base_url: string;
  enabled: number;
  status: string;
  account_name: string | null;
  account_external_id: string | null;
  scopes: string | null;
  capabilities_json: string;
  last_error: string | null;
  last_synced_at: number | null;
  revision: number;
  created_by: number | null;
  created_at: number;
  updated_at: number;
  /** 由查询 LEFT JOIN connection_credentials 得出：1 表示存在凭据行（不含密文本身）。 */
  secret_configured: number;
}

/** 连接查询：只取凭据行是否存在，不取 credentials_ct。 */
export const CONNECTION_SELECT = `SELECT c.id, c.provider, c.name, c.base_url, c.enabled, c.status, c.account_name, c.account_external_id, c.scopes,
  c.capabilities_json, c.last_error, c.last_synced_at, c.revision, c.created_by, c.created_at, c.updated_at,
  (cc.connection_id IS NOT NULL) AS secret_configured
  FROM connections c LEFT JOIN connection_credentials cc ON cc.connection_id = c.id`;

export function connectionRecord(row: ConnectionRow): ConnectionRecord {
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    base_url: row.base_url,
    enabled: row.enabled === 1,
    status: row.status,
    account_name: row.account_name,
    capabilities: parseJsonColumn<Capability[]>(row.capabilities_json, []),
    secret_configured: row.secret_configured === 1,
    revision: row.revision,
    created_at: iso(row.created_at),
  };
}

export interface ProjectRow {
  id: string;
  connection_id: string;
  external_id: string;
  name: string;
  path: string;
  url: string;
  default_branch: string;
  private: number;
  archived: number;
  permission: string;
  capabilities_json: string;
  status: "active" | "lost";
  enabled: number;
  write_mode: WriteMode;
  review_enabled: number;
  triage_enabled: number;
  fix_enabled: number;
  rework_enabled: number;
  machine_ids_json: string;
  tags_json: string;
  revision: number;
  last_synced_at: number | null;
  created_at: number;
  updated_at: number;
}

export function projectRecord(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    connection_id: row.connection_id,
    external_id: row.external_id,
    name: row.name,
    path: row.path,
    url: row.url,
    default_branch: row.default_branch,
    private: row.private === 1,
    archived: row.archived === 1,
    permission: row.permission,
    capabilities: parseJsonColumn<Capability[]>(row.capabilities_json, []),
    status: row.status,
    enabled: row.enabled === 1,
    write_mode: row.write_mode,
    review_enabled: row.review_enabled === 1,
    triage_enabled: row.triage_enabled === 1,
    fix_enabled: row.fix_enabled === 1,
    rework_enabled: row.rework_enabled === 1,
    machine_ids: parseJsonColumn<string[]>(row.machine_ids_json, []),
    tags: parseJsonColumn<string[]>(row.tags_json, []),
    revision: row.revision,
    updated_at: iso(row.updated_at),
  };
}

export interface ItemRow {
  id: string;
  project_id: string;
  external_id: string;
  kind: "issue" | "change";
  origin: string;
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  author: string;
  bot_authored: number;
  head_sha: string | null;
  base_sha: string | null;
  head_ref: string | null;
  base_ref: string | null;
  labels_json: string;
  assignees_json: string;
  updated_at: number;
  synced_at: number;
}

/** 条目上未结束的任务（queued、running、awaiting_publish）；每条目同时最多一个。查询结果，不落库。 */
export type ActiveTaskView = NonNullable<ItemRecord["active_task"]>;
export const ACTIVE_TASK_SQL = "SELECT id, kind, status FROM tasks WHERE item_id = ? AND status IN ('queued', 'running', 'awaiting_publish') ORDER BY created_at DESC, id DESC LIMIT 1";

/** 任务创建时冻结的条目快照：ItemRecord 去掉查询得出的 active_task。 */
export type ItemSnapshot = Omit<ItemRecord, "active_task">;

export function itemSnapshot(row: ItemRow): ItemSnapshot {
  return {
    id: row.id,
    project_id: row.project_id,
    external_id: row.external_id,
    kind: row.kind,
    number: row.number,
    title: row.title,
    body: row.body,
    url: row.url,
    state: row.state,
    author: row.author,
    bot_authored: row.bot_authored === 1,
    head_sha: row.head_sha,
    base_sha: row.base_sha,
    updated_at: iso(row.updated_at),
  };
}

export function itemRecord(row: ItemRow, active: ActiveTaskView | null): ItemRecord {
  return { ...itemSnapshot(row), active_task: active };
}

/** 冻结快照转回 publisher 用的 ItemRecord：编号、类型、head 都是创建任务时的值。 */
export function itemFromSnapshot(json: string): ItemRecord {
  const snapshot = JSON.parse(json) as ItemSnapshot;
  return { ...snapshot, active_task: null };
}

export interface DemandRow {
  id: string;
  title: string;
  body: string;
  project_id: string | null;
  source: DemandRecord["source"];
  source_ref: string;
  source_connection_id: string | null;
  /** 代码平台来源需求对应的条目（唯一）；内部列，不在 DemandRecord 里，source_ref 同值。 */
  item_id: string | null;
  status: DemandStatus;
  revision: number;
  created_by: number | null;
  created_at: number;
  updated_at: number;
}

export function demandRecord(row: DemandRow): DemandRecord {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    project_id: row.project_id,
    source: row.source,
    source_ref: row.source_ref,
    source_connection_id: row.source_connection_id,
    status: row.status,
    revision: row.revision,
    created_by: row.created_by,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

export interface MachineRow {
  id: string;
  name: string;
  status: MachineStatus | "disabled";
  /** 健康门没通过的原因（JSON 字符串数组）；空数组表示可派任务，null 表示还没有心跳。 */
  health_gate_json: string | null;
  trust: "standard" | "high";
  tags_json: string;
  heartbeat_seq: number | null;
  slots_sandbox: number;
  slots_vm: number;
  capacity_cpu: number;
  capacity_memory_mib: number;
  declared_json: string | null;
  protocol_version: number | null;
  boot_id: string | null;
  health_json: string | null;
  token_hash: string | null;
  last_seen_at: number | null;
  revision: number;
  created_by: number | null;
  created_at: number;
  updated_at: number;
}

export interface MachineUsage {
  cpu: number;
  memory_mib: number;
  sandbox: number;
  vm: number;
}

/** 心跳超过这么久没来，联络状态记为 offline，不再派任务（节点协议「时钟与超时」）。 */
export const OFFLINE_AFTER_MS = 90_000;

/** 管理状态叠加联络状态：ready/draining/cordoned 的机器 90 秒没心跳显示为 offline。disabled 不出现在公开记录里。 */
export function effectiveMachineStatus(row: MachineRow, now: number): MachineStatus {
  if (row.status === "disabled") return "offline";
  if (row.status === "pending") return "pending";
  if (row.last_seen_at === null || now - row.last_seen_at > OFFLINE_AFTER_MS) return "offline";
  // 健康门打开（越线或自检未过）的 ready 机器对外显示为 cordoned：不派任务，恢复后自动回到 ready。
  if (row.status === "ready" && healthGateOpen(row)) return "cordoned";
  return row.status;
}

/** 健康门是否打开：没有心跳过、或最近一次心跳判定的原因列表非空。 */
export function healthGateOpen(row: Pick<MachineRow, "health_gate_json">): boolean {
  return row.health_gate_json === null || parseJsonColumn<string[]>(row.health_gate_json, []).length > 0;
}

export function machineRecord(row: MachineRow, used: MachineUsage, now: number): MachineRecord {
  return {
    id: row.id,
    name: row.name,
    status: effectiveMachineStatus(row, now),
    trust: row.trust,
    tags: parseJsonColumn<string[]>(row.tags_json, []),
    slots: { sandbox: row.slots_sandbox, vm: row.slots_vm },
    capacity: { cpu: row.capacity_cpu, memory_mib: row.capacity_memory_mib },
    used: { cpu: used.cpu, memory_mib: used.memory_mib, sandbox: used.sandbox, vm: used.vm },
    last_seen_at: isoOrNull(row.last_seen_at),
    revision: row.revision,
  };
}

export interface TaskRow {
  id: string;
  project_id: string;
  demand_id: string | null;
  item_id: string | null;
  kind: TaskKind;
  executor: Executor;
  status: TaskStatus;
  priority: number;
  cpu: number;
  memory_mib: number;
  required_tags_json: string;
  required_trust: "standard" | "high";
  machine_id: string | null;
  epoch: number;
  lease_id: string | null;
  lease_expires_at: number | null;
  lease_acked_at: number | null;
  lease_request_key: string | null;
  model_token_hash: string | null;
  model_pool_json: string | null;
  token_budget: number;
  tokens_used: number;
  request_budget: number;
  requests_used: number;
  timeout_s: number;
  prompt: string;
  tools_json: string;
  head_sha: string | null;
  base_sha: string | null;
  item_snapshot_json: string | null;
  item_version: string | null;
  bundle_json: string | null;
  bundle_sha256: string | null;
  result_json: string | null;
  result_lease_id: string | null;
  error: string | null;
  infra_failures: number;
  excluded_machines_json: string;
  cancel_requested: number;
  created_by: number | null;
  created_at: number;
  updated_at: number;
}

export function taskRecord(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    project_id: row.project_id,
    demand_id: row.demand_id,
    item_id: row.item_id,
    kind: row.kind,
    executor: row.executor,
    status: row.status,
    priority: row.priority,
    resources: { cpu: row.cpu, memory_mib: row.memory_mib },
    machine_id: row.machine_id,
    epoch: row.epoch,
    lease_id: row.lease_id,
    lease_expires_at: isoOrNull(row.lease_expires_at),
    head_sha: row.head_sha,
    base_sha: row.base_sha,
    result: parseJsonColumn<TaskResult | null>(row.result_json, null),
    error: row.error,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

export interface TaskEventRow {
  task_id: string;
  seq: number;
  at: number;
  kind: TaskEvent["kind"];
  text: string;
  lease_id: string | null;
}

export function taskEventRecord(row: TaskEventRow): TaskEvent {
  return { seq: row.seq, at: iso(row.at), kind: row.kind, text: row.text };
}
