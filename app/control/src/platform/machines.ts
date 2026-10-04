/**
 * 全局共享机器池（S-12；API.md A-36…A-44；节点协议 N-01）。
 *
 * - 节点令牌 gbn_ + 256 位随机数，只在登记或重置的那一次响应里出现，库里只存 SHA-256；重置后旧令牌立即 401。
 * - 新机器 pending；用令牌的第一次心跳变 cordoned；owner 或 operator 解除隔离后才 ready、才派任务。
 * - 信任等级默认 standard；调到 high 只归 owner 并要求重新认证（S-09 第 4 项）。
 * - 心跳：名字必须与令牌对应；按 health.seq 丢弃旧心跳；boot_id 变化或已确认租约缺席时收回重排；返回要终止的任务。
 */
import type { ExecutorSlots, HeartbeatReply, MachineHeartbeat, MachineRecord, ResourceBudget } from "@geek-bot/protocol";
import { NODE_PROTOCOL_VERSION } from "@geek-bot/protocol";
import type { SessionInfo } from "./auth.js";
import type { IdempotentResult, PlatformContext } from "./context.js";
import { decodeCursor, newId, notFound, PlatformError, pageOf, parseJsonColumn, randomToken, sha256Hex } from "./http.js";
import { gateReasons, healthWarnings, parseHealth, readySlots } from "./health.js";
import { healthGateOpen, machineRecord, type MachineRow } from "./records.js";
import type { TasksService } from "./tasks.js";

/** control 支持的节点协议版本范围：N 与 N-1（N-1 为 0 时不存在）。 */
export const PROTOCOL_RANGE = Object.freeze({ min: Math.max(1, NODE_PROTOCOL_VERSION - 1), max: NODE_PROTOCOL_VERSION });
const MAX_HEALTH_BYTES = 64 * 1024;

export interface MachineInput {
  readonly name: string;
  readonly trust: "standard" | "high";
  readonly tags: readonly string[];
  readonly slots: ExecutorSlots;
  readonly capacity: ResourceBudget;
}

export interface NodeIdentity {
  readonly id: string;
  readonly name: string;
}

export interface MachinesService {
  get(id: string): MachineRecord;
  list(query: { limit: number; cursor?: string }): { items: MachineRecord[]; next_cursor: string | null };
  /** 在幂等事务里执行；响应含一次性令牌。 */
  create(actor: SessionInfo, input: MachineInput): IdempotentResult;
  update(actor: SessionInfo, id: string, patch: Partial<MachineInput>, ifMatch: (revision: number) => void, reauthValid: boolean): MachineRecord;
  transition(actor: SessionInfo, id: string, action: "cordon" | "uncordon" | "drain"): MachineRecord;
  resetToken(actor: SessionInfo, id: string): IdempotentResult;
  /** 节点令牌认证：令牌无效、被重置或机器已移除时 401。 */
  authenticate(authorization: string | undefined): NodeIdentity;
  heartbeat(node: NodeIdentity, protocolHeader: number, body: MachineHeartbeat): HeartbeatReply;
}

export function createMachinesService(ctx: PlatformContext, tasks: TasksService): MachinesService {
  const { db, clock, auditor, bus, config } = ctx;
  const rowOf = (id: string) => db.prepare("SELECT * FROM machines WHERE id = ? AND status <> 'disabled'").get(id) as MachineRow | undefined;
  const recordOf = (row: MachineRow) => machineRecord(row, tasks.usage(row.id), clock());

  function publish(id: string): void {
    const row = rowOf(id);
    if (row) bus.publish("machine.updated", ["machines", "nodes", "overview"], recordOf(row));
    tasks.wake();
  }

  function issueToken(): { token: string; hash: string } {
    const token = `gbn_${randomToken(32)}`;
    ctx.redactor.addKnownSecret(token);
    return { token, hash: sha256Hex(token) };
  }

  function checkSlotsDeclared(row: MachineRow, slots: ExecutorSlots | undefined, capacity: ResourceBudget | undefined): void {
    const declared = parseJsonColumn<{ capacity?: ResourceBudget; slots?: ExecutorSlots } | null>(row.declared_json, null);
    if (!declared) return;
    if (slots && declared.slots && (slots.sandbox > declared.slots.sandbox || slots.vm > declared.slots.vm)) throw new PlatformError(422, "slots_exceed_declared", "槽位超过节点心跳声明的上限");
    if (capacity && declared.capacity && (capacity.cpu > declared.capacity.cpu || capacity.memory_mib > declared.capacity.memory_mib)) {
      throw new PlatformError(422, "slots_exceed_declared", "资源超过节点心跳声明的上限");
    }
  }

  const service: MachinesService = {
    get(id) {
      const row = rowOf(id);
      if (!row) throw notFound("机器");
      return recordOf(row);
    },

    list({ limit, cursor }) {
      const key = decodeCursor("machines", cursor, 2);
      const rows = (key
        ? db.prepare("SELECT * FROM machines WHERE status <> 'disabled' AND (name, id) > (?, ?) ORDER BY name, id LIMIT ?").all(String(key[0]), String(key[1]), limit + 1)
        : db.prepare("SELECT * FROM machines WHERE status <> 'disabled' ORDER BY name, id LIMIT ?").all(limit + 1)) as MachineRow[];
      return pageOf(rows, limit, "machines", row => [row.name, row.id], recordOf);
    },

    create(actor, input) {
      if (db.prepare("SELECT 1 FROM machines WHERE name = ?").get(input.name)) throw new PlatformError(409, "node_name_taken", "已有同名机器");
      const now = clock();
      const id = newId("mch");
      const { token, hash } = issueToken();
      db.prepare(
        `INSERT INTO machines (id, name, status, trust, tags_json, slots_sandbox, slots_vm, capacity_cpu, capacity_memory_mib, declared_json, protocol_version, boot_id, heartbeat_seq, health_json, token_hash, last_seen_at, revision, created_by, created_at, updated_at)
         VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, NULL, 1, ?, ?, ?)`,
      ).run(id, input.name, input.trust, JSON.stringify(input.tags), input.slots.sandbox, input.slots.vm, input.capacity.cpu, input.capacity.memory_mib, hash, actor.githubId, now, now);
      auditor.write({ actorType: "user", actorId: String(actor.githubId), action: "machine.create", target: `machine/${id}`, detail: { name: input.name, trust: input.trust, tags: input.tags, slots: input.slots }, reauth: true });
      const machine = recordOf(rowOf(id) as MachineRow);
      bus.publish("machine.updated", ["machines", "nodes", "overview"], machine);
      return { status: 201, body: { machine, node_token: token }, secret: true };
    },

    update(actor, id, patch, ifMatch, reauthValid) {
      db.transaction(() => {
        const row = rowOf(id);
        if (!row) throw notFound("机器");
        ifMatch(row.revision);
        if (patch.trust === "high" && row.trust !== "high" && !reauthValid) throw new PlatformError(403, "reauth_required", "把信任等级调到 high 前需要在 10 分钟内重新认证");
        if (patch.name !== undefined && patch.name !== row.name && db.prepare("SELECT 1 FROM machines WHERE name = ? AND id <> ?").get(patch.name, id)) throw new PlatformError(409, "node_name_taken", "已有同名机器");
        checkSlotsDeclared(row, patch.slots, patch.capacity);
        db.prepare(
          "UPDATE machines SET name = ?, trust = ?, tags_json = ?, slots_sandbox = ?, slots_vm = ?, capacity_cpu = ?, capacity_memory_mib = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
        ).run(
          patch.name ?? row.name, patch.trust ?? row.trust, JSON.stringify(patch.tags ?? parseJsonColumn<string[]>(row.tags_json, [])),
          patch.slots?.sandbox ?? row.slots_sandbox, patch.slots?.vm ?? row.slots_vm, patch.capacity?.cpu ?? row.capacity_cpu, patch.capacity?.memory_mib ?? row.capacity_memory_mib, clock(), id,
        );
        auditor.write({ actorType: "user", actorId: String(actor.githubId), action: "machine.update", target: `machine/${id}`, detail: { ...patch }, reauth: patch.trust === "high" && row.trust !== "high" });
      })();
      publish(id);
      return service.get(id);
    },

    transition(actor, id, action) {
      db.transaction(() => {
        const row = rowOf(id);
        if (!row) throw notFound("机器");
        const target = action === "cordon" ? "cordoned" : action === "drain" ? "draining" : "ready";
        if (row.status === target) return;
        if (row.status === "pending") throw new PlatformError(409, "invalid_state", "机器还没有用令牌心跳过");
        if (action === "uncordon") {
          if (row.protocol_version === null || row.protocol_version < PROTOCOL_RANGE.min || row.protocol_version > PROTOCOL_RANGE.max) {
            throw new PlatformError(409, "protocol_unsupported", "节点协议版本不在支持范围内，先升级节点");
          }
          if (row.last_seen_at === null || clock() - row.last_seen_at > 90_000) throw new PlatformError(409, "invalid_state", "机器已离线，等它恢复心跳再解除隔离");
          // S-12：自检没通过不能解除隔离；健康门没关（越线、未知、自行隔离）同样不能。
          const health = row.health_json === null ? null : parseHealth(JSON.parse(row.health_json) as { readonly [key: string]: unknown });
          if (!health?.self_check?.passed || !health.self_check.model_ready) throw new PlatformError(409, "self_check_failed", `节点自检没有通过${health?.self_check?.error ? `：${health.self_check.error.slice(0, 200)}` : ""}`);
          const ready = readySlots(health, { sandbox: row.slots_sandbox, vm: row.slots_vm });
          if (ready.sandbox + ready.vm === 0) throw new PlatformError(409, "self_check_failed", "节点自检没有任何就绪的执行器");
          if (healthGateOpen(row)) throw new PlatformError(409, "health_gate_active", `健康门控未恢复：${parseJsonColumn<string[]>(row.health_gate_json, ["还没有心跳"]).join("、")}`);
        }
        db.prepare("UPDATE machines SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ?").run(target, clock(), id);
        auditor.write({ actorType: "user", actorId: String(actor.githubId), action: `machine.${action}`, target: `machine/${id}`, detail: { from: row.status } });
      })();
      publish(id);
      return service.get(id);
    },

    resetToken(actor, id) {
      const row = rowOf(id);
      if (!row) throw notFound("机器");
      const { token, hash } = issueToken();
      // 收回全部租约（epoch 加一）、回到 pending；旧令牌的哈希被替换，下一次请求即 401。
      tasks.reclaimMachine(id, "节点令牌已重置", false);
      db.prepare("UPDATE machines SET token_hash = ?, status = 'pending', boot_id = NULL, heartbeat_seq = NULL, health_json = NULL, health_gate_json = NULL, revision = revision + 1, updated_at = ? WHERE id = ?").run(hash, clock(), id);
      auditor.write({ actorType: "user", actorId: String(actor.githubId), action: "machine.reset_token", target: `machine/${id}`, reauth: true });
      const machine = recordOf(rowOf(id) as MachineRow);
      bus.publish("machine.updated", ["machines", "nodes", "overview"], machine);
      return { status: 200, body: { machine, node_token: token }, secret: true };
    },

    authenticate(authorization) {
      const match = /^Bearer (gbn_[A-Za-z0-9_-]{20,100})$/.exec(authorization ?? "");
      const row = match ? (db.prepare("SELECT id, name FROM machines WHERE token_hash = ? AND status <> 'disabled'").get(sha256Hex(match[1] as string)) as NodeIdentity | undefined) : undefined;
      if (!row) throw new PlatformError(401, "unauthenticated", "节点令牌无效、已被重置或机器已移除");
      return { id: row.id, name: row.name };
    },

    heartbeat(node, protocolHeader, body) {
      if (body.name !== node.name) throw new PlatformError(401, "unauthenticated", "心跳里的机器名与令牌对应的机器不一致");
      if (body.protocol_version !== protocolHeader) throw new PlatformError(400, "validation_failed", "协议版本头与请求体不一致");
      const healthText = JSON.stringify(ctx.redactor.redactValue(body.health));
      if (Buffer.byteLength(healthText) > MAX_HEALTH_BYTES) throw new PlatformError(413, "payload_too_large", "health 超过 64 KB");
      const health = body.health;
      // 自检与主机健康按约定校验（类型不对 400）；缺失的字段按不健康处理，不当作通过。
      const parsedHealth = parseHealth(health);
      const bootId = typeof health.boot_id === "string" ? health.boot_id.slice(0, 128) : null;
      const seq = typeof health.seq === "number" && Number.isSafeInteger(health.seq) ? health.seq : null;
      const leases = Array.isArray(health.leases)
        ? health.leases.flatMap(item => {
            if (item === null || typeof item !== "object" || Array.isArray(item)) return [];
            return typeof item.task_id === "string" && typeof item.lease_id === "string" && typeof item.epoch === "number" ? [{ task_id: item.task_id, lease_id: item.lease_id, epoch: item.epoch }] : [];
          })
        : null;
      const result = db.transaction(() => {
        const row = rowOf(node.id) as MachineRow;
        const now = clock();
        let cancel: string[] = [];
        // 同一次进程启动里比已处理的 seq 小的心跳是迟到的旧心跳，只更新联络时间。
        const stale = bootId !== null && bootId === row.boot_id && seq !== null && row.heartbeat_seq !== null && seq <= row.heartbeat_seq;
        if (!stale) {
          if (bootId !== null && row.boot_id !== null && bootId !== row.boot_id) cancel = tasks.reclaimMachine(node.id, "节点进程重启（boot_id 变化）", true);
          cancel = [...new Set([...cancel, ...tasks.reconcile(node.id, leases)])];
          const status = row.status === "pending" ? "cordoned" : row.status;
          const reasons = gateReasons(parsedHealth, healthGateOpen(row));
          // 声明的槽位按自检收紧：没就绪的执行器为 0；健康门打开时调度器不派任何任务。
          const declaredSlots = readySlots(parsedHealth, body.slots);
          const declared = { capacity: body.capacity, slots: declaredSlots, tags: body.tags, mem_available_mib: parsedHealth.mem_available_mib };
          db.prepare(
            "UPDATE machines SET status = ?, declared_json = ?, protocol_version = ?, boot_id = COALESCE(?, boot_id), heartbeat_seq = ?, health_json = ?, health_gate_json = ?, last_seen_at = ?, updated_at = ? WHERE id = ?",
          ).run(status, JSON.stringify(declared), body.protocol_version, bootId, seq, healthText, JSON.stringify(reasons), now, now, node.id);
          if (row.status === "pending") auditor.write({ actorType: "node", actorId: node.id, action: "machine.register", target: `machine/${node.id}`, detail: { sensor_warnings: healthWarnings(parsedHealth) } });
          if (reasons.length > 0 !== healthGateOpen(row)) {
            auditor.write({ actorType: "node", actorId: node.id, action: reasons.length > 0 ? "machine.health_gate.open" : "machine.health_gate.close", target: `machine/${node.id}`, detail: { reasons } });
            if (reasons.length > 0) ctx.alerts.raise({ kind: "machine_health_gate", severity: "warning", subject: `machine/${node.id}`, message: `机器 ${node.name} 停止派任务：${reasons.join("、")}` });
            else ctx.alerts.resolve("machine_health_gate", `machine/${node.id}`);
          }
        } else {
          db.prepare("UPDATE machines SET last_seen_at = ? WHERE id = ?").run(now, node.id);
          cancel = tasks.reconcile(node.id, null);
        }
        const current = rowOf(node.id) as MachineRow;
        const changed = current.status !== row.status || current.health_gate_json !== row.health_gate_json || row.last_seen_at === null || now - row.last_seen_at > 90_000;
        return { record: recordOf(current), cancel, statusChanged: changed };
      })();
      if (result.statusChanged) publish(node.id);
      else tasks.wake();
      return { machine_id: node.id, status: result.record.status, lease_lost_after_s: config.leaseLostAfterS, cancel_task_ids: result.cancel };
    },
  };
  return service;
}
