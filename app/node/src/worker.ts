/**
 * 工作节点的编排：心跳与对账、长轮询领任务、每个任务的确认/续租/取包/执行/事件回传/结果回报，以及停机与恢复：
 *   - 事件先写进每个租约的磁盘缓存（spool.ts），再按批回传；control 确认后推进确认点。执行器交回的结果或失败也先落盘，
 *     control 接收之后才删除缓存目录；
 *   - 401（令牌被重置或节点被移除）：立即销毁全部任务，删除全部缓存，停止领任务和心跳，
 *     只等令牌文件换成新内容后用新的 boot_id 重新开始；
 *   - 某个租约的请求返回 409/404（被收回、取消、取代或过期）：只销毁这个任务，删除它的缓存；
 *   - 失联：连续 (lease_lost_after_s - 30) 秒没有收到 control 的任何非 5xx 响应，自行销毁全部任务（control 侧同一期限后收回租约，
 *     两侧对称），缓存保留，恢复联络后用原来的栅栏回放：control 接受就补交事件与结局，作废（409/404）就删除；
 *   - 节点重启：启动时打开上次留下的缓存逐个回放，规则同上。新的 boot_id 让 control 在对账时决定这些租约是否作废；
 *   - SIGTERM：停止领任务，在跑的任务以 node_shutdown 结束，40 秒内交不完的缓存留到下次启动回放。
 * 心跳的 health 里带 boot_id、seq（同一 boot_id 内单调递增）与 leases（自认持有的租约，含待回放的），control 据此对账；
 * 响应的 cancel_task_ids 里的在跑任务立即停止。
 */
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NODE_PROTOCOL_VERSION } from "@geek-bot/protocol";
import type { ExecutionTask, JsonValue, LeaseFence, MachineStatus, TaskEvent } from "@geek-bot/protocol";
import { ControlClient, ControlHttpError } from "./control-client.js";
import type { FailureCode } from "./control-client.js";
import type { ExecutionHandle, ExecutionOutcome, RunnerEventInput } from "./executor.js";
import { collectHostHealth, healthFields, nextSelfCordon } from "./health.js";
import type { HostHealth } from "./health.js";
import { createRedactor } from "./redact.js";
import { SandboxPool } from "./sandbox.js";
import { NOT_CHECKED, selfCheckReport } from "./self-check.js";
import type { CheckResult } from "./self-check.js";
import { TaskSpool } from "./spool.js";
import type { SpooledOutcome } from "./spool.js";
import { VmPool } from "./vm/pool.js";
import type { WorkerConfig } from "./worker-config.js";

export type LogLevel = "info" | "warn" | "error";
export type Logger = (level: LogLevel, message: string, fields?: Record<string, unknown>) => void;

export interface WorkerOptions {
  readonly config: WorkerConfig;
  readonly log: Logger;
  readonly fetchImpl?: typeof fetch;
}

const LEASE_WAIT_S = 25;
const RENEW_MAX_INTERVAL_S = 30;
const EVENT_FLUSH_MS = 1_000;
const EVENT_BATCH_MAX = 500;
const EVENT_BATCH_BYTES = 200 * 1024;
const TIMEOUT_GRACE_S = 60;
const SHUTDOWN_GRACE_MS = 40_000;
const LOST_MARGIN_S = 30;
const TOKEN_POLL_MS = 10_000;
const MODEL_CHECK_INTERVAL_MS = 5 * 60_000;
const MODEL_CHECK_RETRY_MS = 65_000;

type StopReason = "cancelled" | "timeout" | "node_shutdown" | "spool";

/** 一份租约在节点上的回报状态：在跑的任务与待回放的缓存共用。 */
interface LeaseState {
  readonly taskId: string;
  readonly fence: LeaseFence;
  spool: TaskSpool | null;
  /** 写缓存失败的原因；设置后不再写入，任务以 infra_failure 结束。 */
  spoolError: string | null;
  /** 被栅栏挡下、销毁、401 或转交回放：本对象不再回报任何东西。 */
  discarded: boolean;
  flushing: boolean;
}

interface ActiveTask extends LeaseState {
  readonly kind: "active";
  readonly task: ExecutionTask;
  handle: ExecutionHandle | null;
  stopReason: StopReason | null;
  readonly timers: NodeJS.Timeout[];
}

interface Replay extends LeaseState {
  readonly kind: "replay";
  readonly key: string;
  readonly outcome: SpooledOutcome | null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function backoffMs(attempt: number, error?: unknown): number {
  if (error instanceof ControlHttpError && error.retryAfterMs !== null) return error.retryAfterMs;
  const cap = Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 6));
  return Math.floor(Math.random() * cap) + 250;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** ExecutionTask 的最小形状核对（control 是可信方，这里只防止坏数据让节点崩溃）。 */
export function isExecutionTask(value: unknown): value is ExecutionTask {
  if (typeof value !== "object" || value === null) return false;
  const task = value as Record<string, unknown>;
  const resources = task.resources;
  return typeof task.task_id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(task.task_id)
    && typeof task.lease_id === "string" && task.lease_id !== ""
    && typeof task.epoch === "number" && Number.isInteger(task.epoch) && task.epoch >= 1
    && (task.executor === "sandbox" || task.executor === "vm")
    && typeof task.kind === "string"
    && typeof task.model_token === "string" && task.model_token !== ""
    && typeof task.bundle_sha256 === "string" && /^[0-9a-f]{64}$/.test(task.bundle_sha256)
    && typeof task.timeout_s === "number" && task.timeout_s > 0
    && Array.isArray(task.tools) && Array.isArray(task.model_pool)
    && typeof resources === "object" && resources !== null
    && "cpu" in resources && typeof resources.cpu === "number"
    && "memory_mib" in resources && typeof resources.memory_mib === "number";
}

export class Worker {
  readonly #config: WorkerConfig;
  readonly #log: Logger;
  readonly #client: ControlClient;
  readonly #sandbox: SandboxPool;
  readonly #vm: VmPool;
  readonly #tasks = new Map<string, ActiveTask>();
  readonly #replays = new Map<string, Replay>();
  readonly #redact: (text: string) => string;
  readonly #stop = new AbortController();
  #spoolRoot = "";
  #token: string;
  #tokenDigest: string;
  #bootId = randomUUID();
  #seq = 0;
  #halted = false;
  #shuttingDown = false;
  #status: MachineStatus | null = null;
  #lostAfterS = 600;
  #lastContact = Date.now();
  #lastHeartbeatOk = 0;
  #lostTriggered = false;
  #machineId: string | null = null;
  #modelCheck: CheckResult = NOT_CHECKED;
  /** 本机自我隔离的原因（health 越线、磁盘状态未知）；null 表示没有隔离。带回滞，见 health.ts。 */
  #selfCordon: string | null = null;
  #health: HostHealth | null = null;

  constructor(options: WorkerOptions) {
    this.#config = options.config;
    this.#log = options.log;
    this.#token = this.#readToken();
    this.#tokenDigest = createHash("sha256").update(this.#token).digest("hex");
    this.#redact = createRedactor(() => [this.#token, ...[...this.#tasks.values()].map(active => active.task.model_token)]);
    this.#client = new ControlClient({
      baseUrl: options.config.node.controlUrl,
      nodeName: options.config.node.name,
      token: () => this.#token,
      onContact: () => {
        this.#lastContact = Date.now();
        this.#lostTriggered = false;
      },
      fetchImpl: options.fetchImpl,
    });
    const onUnauthorized = (): void => this.#halt("模型中继返回 401：节点令牌已失效");
    this.#sandbox = new SandboxPool({
      slotsDir: options.config.slotsDir,
      count: options.config.node.slots.sandbox,
      client: this.#client,
      onUnauthorized,
      expectedOmpVersion: options.config.ompVersion,
    });
    this.#vm = new VmPool({
      config: options.config,
      client: this.#client,
      onUnauthorized,
      onEgress: (taskId, record) => this.#log(record.decision === "deny" ? "warn" : "info", "出网代理", { task_id: taskId, ...record }),
      onProbe: result => this.#log(result.ok ? "info" : "error", result.ok ? "探针 VM 通过" : "探针 VM 未通过", { seconds: result.seconds, error: result.error }),
    });
  }

  #readToken(): string {
    const token = readFileSync(this.#config.tokenFile, "utf8").trim();
    if (!/^[\x21-\x7e]{16,512}$/.test(token)) throw new Error(`节点令牌文件 ${this.#config.tokenFile} 的内容不是有效令牌`);
    return token;
  }

  /** 启动全部循环；返回的 Promise 在 shutdown() 完成后结束。缓存目录建不起来时直接抛出（不能在没有缓存的情况下接任务）。 */
  async run(): Promise<void> {
    this.#spoolRoot = TaskSpool.ensureRoot(this.#config.dataDir);
    this.#vm.sweep();
    if (this.#config.node.slots.sandbox > 0) await this.#sandbox.listen();
    const recovered = this.#recoverSpools();
    this.#log("info", "节点启动", { name: this.#config.node.name, boot_id: this.#bootId, slots: this.#config.node.slots, vm: this.#vm.readiness(), replaying: recovered });
    const watchdog = setInterval(() => this.#checkLost(), 1_000);
    try {
      await Promise.all([this.#heartbeatLoop(), this.#leaseLoop(), this.#tokenLoop(), this.#modelCheckLoop()]);
    } finally {
      clearInterval(watchdog);
    }
  }

  /** SIGTERM：停止领任务，在跑的任务以 node_shutdown 结束，最多等 40 秒；交不完的留在磁盘上，下次启动回放。 */
  async shutdown(): Promise<void> {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    this.#log("info", "节点停机：停止领任务，正在结束在跑的任务", { running: this.#tasks.size, replaying: this.#replays.size });
    for (const active of this.#tasks.values()) this.#stopTask(active, "node_shutdown");
    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    while (this.#tasks.size + this.#replays.size > 0 && Date.now() < deadline) await sleep(500);
    this.#stop.abort();
    for (const active of [...this.#tasks.values()]) this.#abandon(active, "停机期限已到，缓存留到下次启动回放");
    for (const replay of this.#replays.values()) {
      replay.discarded = true;
      replay.spool?.close();
    }
    this.#sandbox.stop();
    this.#vm.stop();
  }

  // ---------------------------------------------------------------- 心跳

  /** 实际可用的槽位：没通过自检的执行器报 0；自我隔离时全部报 0。 */
  #effectiveSlots(): { sandbox: number; vm: number } {
    if (this.#selfCordon !== null) return { sandbox: 0, vm: 0 };
    return {
      sandbox: this.#config.node.slots.sandbox > 0 && this.#sandbox.check().ok ? this.#config.node.slots.sandbox : 0,
      vm: this.#vm.readiness().ready ? this.#config.node.slots.vm : 0,
    };
  }

  /** 采集主机健康并按回滞更新自我隔离；数据目录读不出时隔离并给出原因。 */
  #refreshHealth(): void {
    let health: HostHealth;
    try {
      health = collectHostHealth(this.#config.dataDir);
    } catch (error) {
      this.#health = null;
      const reason = `读不出数据目录的磁盘状态：${messageOf(error)}`;
      if (this.#selfCordon !== reason) this.#log("error", "自我隔离", { reason });
      this.#selfCordon = reason;
      return;
    }
    this.#health = health;
    const next = nextSelfCordon(this.#selfCordon, health);
    if (next !== this.#selfCordon) this.#log(next === null ? "info" : "warn", next === null ? "解除自我隔离" : "自我隔离", { reason: next });
    this.#selfCordon = next;
  }

  /** 心跳 health：健康字段、自检（固定六个键）、自我隔离与细节。 */
  #healthPayload(): { [key: string]: JsonValue } {
    this.#refreshHealth();
    const vm = this.#vm.readiness();
    const sandbox = this.#sandbox.check();
    const vmCheck = this.#vm.check();
    const report = selfCheckReport({
      ompVersion: sandbox.ompVersion ?? vmCheck.ompVersion,
      sandboxEnabled: this.#config.node.slots.sandbox > 0,
      sandbox,
      vmEnabled: this.#config.node.slots.vm > 0,
      vm: vmCheck,
      model: this.#modelCheck,
    });
    return {
      ...(this.#health ? healthFields(this.#health, vm.kvm) : { kvm_available: vm.kvm }),
      self_check: report.self_check,
      self_check_detail: report.detail,
      self_cordon: this.#selfCordon,
      boot_id: this.#bootId,
      seq: this.#seq,
      leases: this.#heldLeases(),
      running: { sandbox: this.#running("sandbox"), vm: this.#running("vm") },
      replaying: this.#replays.size,
      sandbox_slots: this.#sandbox.describe(),
      vm_ready: vm.ready,
      vm_reason: vm.reason,
    };
  }

  /** 模型中继自检：调 control 的受限探针端点（control 用网关密钥只读检查）；通过后每 5 分钟、失败后约每分钟一次。 */
  async #modelCheckLoop(): Promise<void> {
    while (!this.#stop.signal.aborted) {
      if (this.#halted) {
        await sleep(2_000, this.#stop.signal);
        continue;
      }
      let waitMs = MODEL_CHECK_RETRY_MS;
      try {
        const reply = await this.#client.selfCheckModel();
        const ok = reply.ok === true;
        this.#modelCheck = { ok, error: ok ? null : (typeof reply.error === "string" ? reply.error : "control 报告模型网关不可用"), checked_at: new Date().toISOString() };
        if (ok) waitMs = MODEL_CHECK_INTERVAL_MS;
      } catch (error) {
        if (error instanceof ControlHttpError && error.unauthorized) {
          this.#halt("模型自检返回 401");
          continue;
        }
        this.#modelCheck = { ok: false, error: this.#redact(messageOf(error)).slice(0, 500), checked_at: new Date().toISOString() };
        if (error instanceof ControlHttpError && error.retryAfterMs !== null) waitMs = Math.max(waitMs, error.retryAfterMs);
      }
      await sleep(waitMs, this.#stop.signal);
    }
  }

  #heldLeases(): { task_id: string; lease_id: string; epoch: number }[] {
    const states: LeaseState[] = [...this.#tasks.values(), ...this.#replays.values()];
    return states.filter(state => !state.discarded).map(state => ({ task_id: state.taskId, lease_id: state.fence.lease_id, epoch: state.fence.epoch }));
  }

  async #heartbeatLoop(): Promise<void> {
    let failures = 0;
    while (!this.#stop.signal.aborted) {
      if (this.#halted) {
        await sleep(1_000, this.#stop.signal);
        continue;
      }
      this.#seq += 1;
      try {
        const reply = await this.#client.heartbeat({
          name: this.#config.node.name,
          protocol_version: NODE_PROTOCOL_VERSION,
          capacity: this.#config.capacity,
          slots: this.#effectiveSlots(),
          tags: this.#config.tags,
          health: this.#healthPayload(),
        });
        failures = 0;
        this.#lastHeartbeatOk = Date.now();
        if (this.#status !== reply.status) this.#log("info", "节点状态", { status: reply.status });
        this.#status = reply.status;
        this.#machineId = reply.machine_id;
        if (Number.isInteger(reply.lease_lost_after_s) && reply.lease_lost_after_s >= 60) this.#lostAfterS = reply.lease_lost_after_s;
        for (const taskId of reply.cancel_task_ids ?? []) {
          const active = this.#tasks.get(taskId);
          if (active) {
            this.#log("info", "control 要求停止任务", { task_id: taskId });
            this.#stopTask(active, "cancelled");
          }
        }
        this.#writeStatus();
      } catch (error) {
        if (error instanceof ControlHttpError && error.unauthorized) {
          this.#halt("心跳返回 401");
          continue;
        }
        if (error instanceof ControlHttpError && error.status === 426) this.#status = null;
        failures += 1;
        this.#log("warn", "心跳失败", { error: this.#redact(messageOf(error)) });
        this.#writeStatus();
        await sleep(Math.min(backoffMs(failures, error), this.#config.heartbeatIntervalS * 1000), this.#stop.signal);
        continue;
      }
      await sleep(this.#config.heartbeatIntervalS * 1000, this.#stop.signal);
    }
  }

  #writeStatus(): void {
    const file = join(this.#config.dataDir, "status.json");
    const body = JSON.stringify({
      boot_id: this.#bootId,
      machine_id: this.#machineId,
      status: this.#status,
      halted: this.#halted,
      last_heartbeat_ok_at: this.#lastHeartbeatOk === 0 ? null : new Date(this.#lastHeartbeatOk).toISOString(),
      heartbeat_interval_s: this.#config.heartbeatIntervalS,
      running: this.#tasks.size,
      replaying: this.#replays.size,
    });
    try {
      writeFileSync(`${file}.tmp`, body, { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    } catch (error) {
      // 状态文件只给容器健康检查用；写不进去时健康检查会如实报不健康。
      this.#log("error", "写状态文件失败", { error: messageOf(error) });
    }
  }

  // ---------------------------------------------------------------- 401 与失联

  #halt(reason: string): void {
    if (this.#halted) return;
    this.#halted = true;
    this.#status = null;
    this.#log("error", "节点令牌失效，立即停止一切任务并停止领任务；换上新的令牌文件后自动恢复", { reason });
    for (const active of [...this.#tasks.values()]) this.#drop(active, "节点令牌失效");
    for (const replay of [...this.#replays.values()]) this.#drop(replay, "节点令牌失效");
    this.#sandbox.destroyAll();
    this.#vm.destroyAll();
    // 旧令牌下的租约全部作废：缓存根目录里残留的任何东西都删掉。
    if (this.#spoolRoot !== "") {
      for (const name of readdirSync(this.#spoolRoot)) rmSync(join(this.#spoolRoot, name), { recursive: true, force: true });
    }
    this.#writeStatus();
  }

  async #tokenLoop(): Promise<void> {
    while (!this.#stop.signal.aborted) {
      await sleep(TOKEN_POLL_MS, this.#stop.signal);
      if (!this.#halted) continue;
      let token: string;
      try {
        token = this.#readToken();
      } catch (error) {
        this.#log("warn", "节点令牌文件暂时读不出，继续等待", { error: messageOf(error) });
        continue;
      }
      const digest = createHash("sha256").update(token).digest("hex");
      if (digest === this.#tokenDigest) continue;
      this.#token = token;
      this.#tokenDigest = digest;
      this.#bootId = randomUUID();
      this.#seq = 0;
      this.#halted = false;
      this.#lastContact = Date.now();
      this.#log("info", "检测到新的节点令牌，用新的 boot_id 恢复心跳", { boot_id: this.#bootId });
    }
  }

  #checkLost(): void {
    if (this.#halted || this.#lostTriggered) return;
    const silentS = (Date.now() - this.#lastContact) / 1000;
    if (silentS < this.#lostAfterS - LOST_MARGIN_S) return;
    this.#lostTriggered = true;
    if (this.#tasks.size === 0) return;
    this.#log("error", "与 control 失联，自行销毁全部任务；事件与结局留在磁盘上，恢复联络后回放", { silent_s: Math.round(silentS), lost_after_s: this.#lostAfterS });
    for (const active of [...this.#tasks.values()]) this.#abandon(active, "与 control 失联");
  }

  // ---------------------------------------------------------------- 缓存的恢复与回放

  /** 打开上次留下的缓存，逐个开始回放；返回开始回放的数量。读不出的缓存记错误后删除（无法回放，也不能当作已交付）。 */
  #recoverSpools(): number {
    let count = 0;
    for (const name of readdirSync(this.#spoolRoot)) {
      const dir = join(this.#spoolRoot, name);
      if (!TaskSpool.isSpoolDir(name)) {
        this.#log("warn", "缓存根目录里有不认识的条目，删除", { name });
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      let spool: TaskSpool;
      try {
        spool = TaskSpool.open(dir, this.#config.spoolMaxBytes);
      } catch (error) {
        this.#log("error", "上次留下的事件缓存已损坏，无法回放，删除", { name, error: messageOf(error) });
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      let outcome: SpooledOutcome | null = null;
      let spoolError: string | null = null;
      try {
        outcome = spool.outcome();
      } catch (error) {
        spoolError = `结局文件损坏：${messageOf(error)}`;
        this.#log("error", "上次留下的结局文件损坏，按基础设施失败回报", { name, error: messageOf(error) });
      }
      this.#log("info", "回放上次留下的租约", { task_id: spool.lease.task_id, epoch: spool.lease.epoch, previous_boot_id: spool.lease.boot_id, pending_events: spool.pendingCount, has_outcome: outcome !== null });
      this.#startReplay({
        kind: "replay",
        key: name,
        taskId: spool.lease.task_id,
        fence: { lease_id: spool.lease.lease_id, epoch: spool.lease.epoch },
        spool,
        spoolError,
        discarded: false,
        flushing: false,
        outcome,
      });
      count += 1;
    }
    return count;
  }

  #startReplay(replay: Replay): void {
    if (this.#replays.has(replay.key)) return;
    this.#replays.set(replay.key, replay);
    const outcome: SpooledOutcome = replay.outcome ?? {
      kind: "failure",
      code: "infra_failure",
      message: "节点重启或与 control 失联，任务已在本机中断，没有产生结果",
    };
    void this.#deliver(replay, outcome).catch(error => {
      this.#log("error", "回放出错", { task_id: replay.taskId, error: this.#redact(messageOf(error)) });
    }).finally(() => {
      if (this.#replays.get(replay.key) === replay) this.#replays.delete(replay.key);
    });
  }

  // ---------------------------------------------------------------- 领任务

  #running(executor: "sandbox" | "vm"): number {
    return [...this.#tasks.values()].filter(active => active.task.executor === executor).length;
  }

  #used(): { cpu: number; memory_mib: number } {
    let cpu = 0;
    let memory = 0;
    for (const active of this.#tasks.values()) {
      cpu += active.task.resources.cpu;
      memory += active.task.resources.memory_mib;
    }
    return { cpu, memory_mib: memory };
  }

  async #leaseLoop(): Promise<void> {
    let key: string | null = null;
    let failures = 0;
    while (!this.#stop.signal.aborted) {
      // 门控：自我隔离或模型自检没通过时不领任务（control 侧同样拒绝，两侧一致）。
      if (this.#halted || this.#shuttingDown || this.#status !== "ready" || this.#selfCordon !== null || !this.#modelCheck.ok) {
        key = null;
        await sleep(2_000, this.#stop.signal);
        continue;
      }
      const used = this.#used();
      const resources = { cpu: this.#config.capacity.cpu - used.cpu, memory_mib: this.#config.capacity.memory_mib - used.memory_mib };
      // 已领到但还没交给执行器的任务（正在确认、取包）也占着执行器的位置。
      const pending = (executor: "sandbox" | "vm"): number => [...this.#tasks.values()].filter(active => active.task.executor === executor && active.handle === null).length;
      const available = {
        sandbox: Math.max(0, Math.min(this.#sandbox.free() - pending("sandbox"), this.#config.node.slots.sandbox - this.#running("sandbox"))),
        vm: Math.max(0, this.#vm.free() - pending("vm")),
      };
      if (available.sandbox + available.vm === 0 || resources.cpu < 1 || resources.memory_mib < 128) {
        key = null;
        await sleep(2_000, this.#stop.signal);
        continue;
      }
      key ??= randomUUID();
      try {
        const task = await this.#client.lease({ available, resources, wait_s: LEASE_WAIT_S }, key);
        key = null;
        failures = 0;
        if (task) this.#accept(task);
      } catch (error) {
        if (error instanceof ControlHttpError && error.unauthorized) {
          this.#halt("领任务返回 401");
          continue;
        }
        failures += 1;
        // 网络错误与 5xx：响应可能丢了，用同一个 Idempotency-Key 重试，control 会返回同一个任务。
        if (!(error instanceof ControlHttpError && error.retryable)) key = null;
        if (error instanceof ControlHttpError && error.status === 409) this.#status = null;
        this.#log("warn", "领任务失败", { error: this.#redact(messageOf(error)) });
        await sleep(backoffMs(failures, error), this.#stop.signal);
      }
    }
  }

  #accept(raw: unknown): void {
    if (!isExecutionTask(raw)) {
      this.#log("error", "control 下发的任务形状不对，忽略", {});
      return;
    }
    const task = raw;
    if (this.#tasks.has(task.task_id)) return;
    let spool: TaskSpool | null = null;
    let spoolError: string | null = null;
    try {
      spool = TaskSpool.create(this.#spoolRoot, {
        task_id: task.task_id,
        lease_id: task.lease_id,
        epoch: task.epoch,
        boot_id: this.#bootId,
        created_at: new Date().toISOString(),
      }, this.#config.spoolMaxBytes);
    } catch (error) {
      spoolError = `建不起事件缓存：${messageOf(error)}`;
      this.#log("error", "建不起事件缓存，任务将以基础设施失败结束", { task_id: task.task_id, error: messageOf(error) });
    }
    const active: ActiveTask = {
      kind: "active",
      task,
      taskId: task.task_id,
      fence: { lease_id: task.lease_id, epoch: task.epoch },
      spool,
      spoolError,
      discarded: false,
      flushing: false,
      handle: null,
      stopReason: null,
      timers: [],
    };
    this.#tasks.set(task.task_id, active);
    this.#log("info", "领到任务", { task_id: task.task_id, kind: task.kind, executor: task.executor, epoch: task.epoch });
    void this.#runTask(active).catch(error => {
      this.#log("error", "任务编排出错", { task_id: task.task_id, error: this.#redact(messageOf(error)) });
    }).finally(() => {
      for (const timer of active.timers) clearTimeout(timer);
      if (this.#tasks.get(task.task_id) === active) this.#tasks.delete(task.task_id);
    });
  }

  // ---------------------------------------------------------------- 单个租约

  /** 销毁并作废：不再回报，删除缓存（409/404、401）。 */
  #drop(state: ActiveTask | Replay, reason: string): void {
    if (state.discarded) return;
    state.discarded = true;
    this.#log("warn", "租约作废，销毁任务并删除缓存", { task_id: state.taskId, epoch: state.fence.epoch, reason });
    if (state.kind === "active") {
      state.handle?.destroy();
      for (const timer of state.timers) clearTimeout(timer);
    }
    try {
      state.spool?.remove();
    } catch (error) {
      this.#log("error", "删除事件缓存失败", { task_id: state.taskId, error: messageOf(error) });
    }
  }

  /** 销毁在跑的任务但保留缓存（失联、停机期限到），转交回放。 */
  #abandon(active: ActiveTask, reason: string): void {
    if (active.discarded) return;
    active.discarded = true;
    this.#log("warn", "销毁任务，缓存保留待回放", { task_id: active.taskId, reason });
    active.handle?.destroy();
    for (const timer of active.timers) clearTimeout(timer);
    if (this.#tasks.get(active.taskId) === active) this.#tasks.delete(active.taskId);
    const spool = active.spool;
    if (!spool || spool.removed) return;
    if (this.#stop.signal.aborted) {
      spool.close();
      return;
    }
    let outcome: SpooledOutcome | null = null;
    let spoolError = active.spoolError;
    try {
      outcome = spool.outcome();
    } catch (error) {
      spoolError ??= `结局文件损坏：${messageOf(error)}`;
    }
    this.#startReplay({
      kind: "replay",
      key: `${active.taskId}@${active.fence.epoch}`,
      taskId: active.taskId,
      fence: active.fence,
      spool,
      spoolError,
      discarded: false,
      flushing: false,
      outcome,
    });
  }

  /** 请求任务停下（取消、超时、停机、缓存写坏）；结局按停止原因回报。 */
  #stopTask(active: ActiveTask, reason: StopReason): void {
    if (active.discarded || active.stopReason !== null) return;
    active.stopReason = reason;
    active.handle?.cancel();
  }

  #spoolFailure(state: ActiveTask | Replay, error: unknown): void {
    if (state.spoolError !== null) return;
    state.spoolError = messageOf(error);
    this.#log("error", "事件缓存读写失败，任务以基础设施失败结束", { task_id: state.taskId, error: state.spoolError });
    if (state.kind === "active") this.#stopTask(state, "spool");
  }

  /** 处理租约请求的错误：401 全局停机、409/404 作废；返回 true 表示调用方应放弃本次操作。 */
  #fatalForLease(state: ActiveTask | Replay, error: unknown): boolean {
    if (error instanceof ControlHttpError && error.unauthorized) {
      this.#halt("任务请求返回 401");
      return true;
    }
    if (error instanceof ControlHttpError && error.fenced) {
      this.#drop(state, `control 拒绝了这个租约：${error.message}`);
      return true;
    }
    return state.discarded;
  }

  #abandoned(state: LeaseState): boolean {
    return state.discarded || this.#halted || this.#stop.signal.aborted;
  }

  /** 带退避重试直到成功、被作废、全局停机、节点停止或遇到不可重试的错误；成功返回值，否则返回 null。 */
  async #retry<T>(state: ActiveTask | Replay, label: string, operation: () => Promise<T>, maxAttempts = Number.POSITIVE_INFINITY): Promise<T | null> {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (this.#abandoned(state)) return null;
      try {
        return await operation();
      } catch (error) {
        if (this.#fatalForLease(state, error)) return null;
        if (!(error instanceof ControlHttpError && error.retryable)) {
          this.#log("error", `${label}失败，不再重试`, { task_id: state.taskId, error: this.#redact(messageOf(error)) });
          return null;
        }
        await sleep(backoffMs(attempt, error), this.#stop.signal);
      }
    }
    return null;
  }

  #emit(active: ActiveTask, event: RunnerEventInput): void {
    if (active.discarded || active.spoolError !== null || !active.spool) return;
    try {
      active.spool.append({ at: event.at, kind: event.kind, text: this.#redact(event.text) });
    } catch (error) {
      this.#spoolFailure(active, error);
    }
  }

  /** 回传一批事件：先落盘，control 接收后推进确认点。返回是否有进展。 */
  async #flushEvents(state: ActiveTask | Replay): Promise<boolean> {
    const spool = state.spool;
    if (state.flushing || this.#abandoned(state) || state.spoolError !== null || !spool || spool.removed || spool.pendingCount === 0) return false;
    state.flushing = true;
    try {
      let batch: TaskEvent[];
      try {
        spool.sync();
        batch = spool.batch(EVENT_BATCH_MAX, EVENT_BATCH_BYTES);
      } catch (error) {
        this.#spoolFailure(state, error);
        return false;
      }
      if (batch.length === 0) return false;
      try {
        await this.#client.events(state.taskId, state.fence, batch);
      } catch (error) {
        this.#fatalForLease(state, error);
        return false;
      }
      if (state.discarded || spool.removed) return false;
      try {
        spool.ack(batch[batch.length - 1].seq);
      } catch (error) {
        this.#spoolFailure(state, error);
        return false;
      }
      return true;
    } finally {
      state.flushing = false;
    }
  }

  async #runTask(active: ActiveTask): Promise<void> {
    const { task } = active;
    // 1. 确认：领到后立即第一次续租。
    const ack = await this.#retry(active, "确认租约", () => this.#client.renew(task.task_id, active.fence), 20);
    if (!ack) {
      if (!active.discarded && !this.#halted) this.#drop(active, "确认租约失败");
      return;
    }
    if (active.spoolError !== null) {
      await this.#finish(active, { kind: "failure", code: "infra_failure", message: `事件缓存不可用：${active.spoolError}` });
      return;
    }
    if (ack.cancel) {
      await this.#finish(active, { kind: "failure", code: "cancelled", message: "任务在开始前被取消" });
      return;
    }
    const renewEveryMs = Math.max(5, Math.min(RENEW_MAX_INTERVAL_S, Math.floor((ack.lease_ttl_s || this.#lostAfterS) / 3))) * 1000;
    const renew = async (): Promise<void> => {
      if (active.discarded) return;
      try {
        const reply = await this.#client.renew(task.task_id, active.fence);
        if (reply.cancel) this.#stopTask(active, "cancelled");
      } catch (error) {
        this.#fatalForLease(active, error);
      }
      if (!active.discarded) active.timers.push(setTimeout(() => void renew(), renewEveryMs));
    };
    active.timers.push(setTimeout(() => void renew(), renewEveryMs));
    const flushLoop = (): void => {
      if (active.discarded) return;
      void this.#flushEvents(active).finally(() => {
        if (!active.discarded) active.timers.push(setTimeout(flushLoop, EVENT_FLUSH_MS));
      });
    };
    active.timers.push(setTimeout(flushLoop, EVENT_FLUSH_MS));

    // 2. 取任务包并核对 sha256。
    const bundle = await this.#retry(active, "取任务包", () => this.#client.bundle(task.task_id, active.fence), 5);
    if (active.discarded) return;
    if (!bundle) {
      await this.#finish(active, { kind: "failure", code: "infra_failure", message: "取任务包失败" });
      return;
    }
    if (createHash("sha256").update(bundle).digest("hex") !== task.bundle_sha256) {
      await this.#finish(active, { kind: "failure", code: "bundle_invalid", message: "任务包 sha256 与任务声明不符" });
      return;
    }

    // 3. 交给执行器。fix/rework 只能进 VM。
    if ((task.kind === "fix" || task.kind === "rework") && task.executor !== "vm") {
      await this.#finish(active, { kind: "failure", code: "resource_unavailable", message: "fix 与 rework 只能在 VM 里执行" });
      return;
    }
    if (active.stopReason !== null) {
      await this.#finish(active, this.#stopOutcome(active, active.stopReason) ?? { kind: "failure", code: "infra_failure", message: "任务在开始执行前被停止" });
      return;
    }
    const executor = task.executor === "vm" ? this.#vm : this.#sandbox;
    const handle = executor.start(task, bundle, { emit: event => this.#emit(active, event) });
    active.handle = handle;
    if (active.discarded) handle.destroy();
    if (active.stopReason !== null) handle.cancel();
    active.timers.push(setTimeout(() => this.#stopTask(active, "timeout"), (task.timeout_s + TIMEOUT_GRACE_S) * 1000));
    const outcome = await handle.done;
    if (active.discarded) return;

    // 4. 停止原因优先：取消、超时、停机、缓存写坏分别回报对应失败码。
    const stopped = active.stopReason === null ? null : this.#stopOutcome(active, active.stopReason);
    await this.#finish(active, stopped ?? outcome);
  }

  #stopOutcome(active: ActiveTask, reason: StopReason): ExecutionOutcome | null {
    switch (reason) {
      case "timeout":
        return { kind: "failure", code: "timeout", message: "任务超过时长上限，已停止" };
      case "cancelled":
        return { kind: "failure", code: "cancelled", message: "任务已按 control 的要求停止" };
      case "node_shutdown":
        return { kind: "failure", code: "node_shutdown", message: "节点停机，任务已停止" };
      case "spool":
        return { kind: "failure", code: "infra_failure", message: `事件缓存读写失败：${active.spoolError ?? "未知原因"}` };
      default:
        return null;
    }
  }

  /** 在跑任务的结局：先落盘，再交付。落盘失败时照常交付（结局只是不再耐重启），并记错误。 */
  async #finish(active: ActiveTask, outcome: ExecutionOutcome): Promise<void> {
    if (active.discarded) return;
    const spooled: SpooledOutcome = outcome.kind === "result"
      ? outcome
      : { kind: "failure", code: outcome.code, message: this.#redact(outcome.message) };
    if (active.spool && !active.spool.removed && active.spoolError === null) {
      try {
        active.spool.saveOutcome(spooled);
      } catch (error) {
        this.#spoolFailure(active, error);
      }
    }
    await this.#deliver(active, spooled);
  }

  /**
   * 交付一份租约：发完缓存里的事件，再回报结局；control 接收后删除缓存。
   * control 拒收结果（4xx 且不是栅栏）时改报 schema 失败；节点停止或失联时保留缓存，留待回放。
   */
  async #deliver(state: ActiveTask | Replay, outcome: SpooledOutcome): Promise<void> {
    for (let attempt = 0; !this.#abandoned(state) && state.spoolError === null && state.spool && !state.spool.removed && state.spool.pendingCount > 0; ) {
      if (await this.#flushEvents(state)) attempt = 0;
      else {
        attempt += 1;
        await sleep(backoffMs(attempt), this.#stop.signal);
      }
    }
    if (this.#abandoned(state)) return;
    const { taskId, fence } = state;
    let accepted: unknown = null;
    if (outcome.kind === "result") {
      accepted = await this.#retry(state, "回报结果", () => this.#client.result(taskId, fence, outcome.result));
      if (accepted === null && !this.#abandoned(state)) {
        accepted = await this.#retry(state, "回报失败", () => this.#client.failure(taskId, fence, "schema", "control 拒收了节点交回的结果"));
      }
      if (accepted !== null) this.#log("info", "任务完成，结果已交给 control", { task_id: taskId });
    } else {
      const code: FailureCode = outcome.code;
      accepted = await this.#retry(state, "回报失败", () => this.#client.failure(taskId, fence, code, outcome.message));
      if (accepted !== null) this.#log("info", "任务失败已回报", { task_id: taskId, code });
    }
    if (this.#abandoned(state)) return;
    if (accepted === null) this.#log("error", "control 不接受这份租约的结局，删除缓存", { task_id: taskId, epoch: fence.epoch });
    state.discarded = true;
    try {
      state.spool?.remove();
    } catch (error) {
      this.#log("error", "删除事件缓存失败", { task_id: taskId, error: messageOf(error) });
    }
  }
}
