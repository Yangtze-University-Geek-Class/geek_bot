/**
 * QEMU/KVM 执行器：每个任务一台一次性 VM，配方沿用 #12 的实测（docs/services/node/vm-feasibility.md）与 ADR-0004/0011：
 *   - qcow2 overlay 叠在只读基础镜像上，任务结束连同整个任务目录删除；
 *   - 输入是只读原始盘上的 tar（task.json 不含任何令牌、bundle.json），结果写在可写原始盘上的 tar；
 *   - 工具盘（squashfs：node、omp、runner.mjs、guest-init.sh）只读挂载；cloud-init 种子只负责挂工具盘并执行 guest-init；
 *   - 网络只有 `-netdev user,restrict=on` 加两条 guestfwd：来宾内部地址上的模型端口与出网代理端口，
 *     各自经 netcat 转到本任务目录里由 node 监听的 unix socket（模型代理、出网 CONNECT 代理）；
 *   - 模型令牌经 `-fw_cfg name=opt/geekbot/token,file=<0600 文件>` 传入，qemu 起来（QMP 可用）后立即删掉文件；
 *   - 实时事件走 virtio-serial（qemu 作为客户端连 node 的 events.sock）；
 *   - `-sandbox on,obsolete=deny,resourcecontrol=deny`（不带 elevateprivileges=deny，ADR-0011），由容器 cap_drop ALL 与 no-new-privileges 兜底；
 *   - 取消：QMP system_powerdown，30 秒后 QMP quit，再 5 秒 SIGKILL；销毁：直接 SIGKILL。
 * 节点启动时结束残留的 qemu 进程并清空 VM 工作目录；之后每 5 分钟回收没有对应活动任务的目录。
 */
import { execFile, execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, existsSync, ftruncateSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { Server as HttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import type { Server as NetServer, Socket } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExecutionTask } from "@geek-bot/protocol";
import type { ControlClient, FailureCode } from "../control-client.js";
import { startEgressProxy } from "../egress-proxy.js";
import type { EgressProxy, EgressRecord } from "../egress-proxy.js";
import { RUNNER_FAILURE_CODES, normalizeRunnerEvent, runnerTaskOf, validateTaskResult } from "../executor.js";
import type { ExecutionHandle, ExecutionOutcome, ExecutionSink, TaskExecutor } from "../executor.js";
import { handleModelRequest } from "../model-relay.js";
import { NOT_CHECKED, nodeProcessProblems, parseProbeEvidence } from "../self-check.js";
import type { CheckResult } from "../self-check.js";
import type { WorkerConfig } from "../worker-config.js";
import { QmpClient } from "./qmp.js";
import { readTarSelected, writeTar } from "./tar.js";

const run = promisify(execFile);

/** QEMU 用户态网络里来宾可见的内部地址（guestfwd 目标），运行时由数字拼出。 */
const GUEST_FORWARD_ADDRESS = [10, 0, 2, 100].join(".");
const GUEST_MODEL_PORT = 18080;
const GUEST_PROXY_PORT = 13128;
const OUTPUT_DISK_BYTES = 32 * 1024 * 1024;
const POWERDOWN_GRACE_MS = 30_000;
const QUIT_GRACE_MS = 5_000;
const FIRST_EVENT_TIMEOUT_MS = 300_000;
const GC_INTERVAL_MS = 5 * 60_000;
const MAX_EVENT_LINE = 64 * 1024;
const QEMU_SANDBOX = "on,obsolete=deny,resourcecontrol=deny";

export interface VmPoolOptions {
  readonly config: WorkerConfig;
  readonly client: ControlClient;
  readonly onUnauthorized: () => void;
  /** 出网代理每条决定的记录（不含载荷）。 */
  readonly onEgress: (taskId: string, record: EgressRecord) => void;
  /** 每次探针 VM 结束时调用（记日志）。 */
  readonly onProbe: (result: CheckResult & { readonly seconds: number }) => void;
}

export interface VmReadiness {
  /** 前置条件（KVM、程序、资产、node 容器隔离）满足，且最近一次探针 VM 通过。 */
  readonly ready: boolean;
  readonly reason: string | null;
  readonly kvm: boolean;
}

interface QemuLayout {
  readonly dir: string;
  readonly cpus: number;
  readonly memoryMib: number;
  readonly overlay: string;
  readonly inputDisk: string;
  readonly outputDisk: string;
  readonly modelSocket: string;
  readonly egressSocket: string | null;
  readonly eventsSocket: string;
  readonly tokenFile: string;
  readonly qmpSocket: string;
}

/** 任务 VM 与探针 VM 共用的 qemu 参数（restrict=on、guestfwd、fw_cfg 令牌、virtio-serial、QMP、-sandbox）。 */
function qemuArgs(config: WorkerConfig, layout: QemuLayout): string[] {
  const netdev = [
    "user",
    "id=n0",
    "restrict=on",
    `guestfwd=tcp:${GUEST_FORWARD_ADDRESS}:${GUEST_MODEL_PORT}-cmd:${config.vm.netcat} -U ${layout.modelSocket}`,
    ...(layout.egressSocket ? [`guestfwd=tcp:${GUEST_FORWARD_ADDRESS}:${GUEST_PROXY_PORT}-cmd:${config.vm.netcat} -U ${layout.egressSocket}`] : []),
  ].join(",");
  return [
    "-enable-kvm", "-cpu", "host",
    "-smp", String(Math.max(1, layout.cpus)),
    "-m", String(Math.max(512, layout.memoryMib)),
    "-sandbox", QEMU_SANDBOX,
    "-display", "none", "-monitor", "none", "-no-reboot",
    "-serial", `file:${join(layout.dir, "serial.log")}`,
    "-drive", `file=${layout.overlay},if=virtio,format=qcow2`,
    "-drive", `file=${layout.inputDisk},if=virtio,format=raw,readonly=on`,
    "-drive", `file=${config.vm.toolsImage},if=virtio,format=raw,readonly=on`,
    "-drive", `file=${layout.outputDisk},if=virtio,format=raw`,
    "-drive", `file=${config.vm.seedIso},media=cdrom,format=raw,readonly=on`,
    "-netdev", netdev,
    "-device", "virtio-net-pci,netdev=n0",
    "-device", "virtio-serial-pci",
    "-chardev", `socket,id=ev,path=${layout.eventsSocket}`,
    "-device", "virtserialport,chardev=ev,name=org.geekbot.events",
    "-fw_cfg", `name=opt/geekbot/token,file=${layout.tokenFile}`,
    "-qmp", `unix:${layout.qmpSocket},server=on,wait=off`,
  ];
}

/** 探针 VM 里要求直连失败的目标：宿主别名、用户态网络 DNS、私网、元数据地址、公网地址（运行时由数字拼出）。 */
const PROBE_DIRECT_TARGETS: readonly { host: string; port: number }[] = Object.freeze([
  { host: [10, 0, 2, 2].join("."), port: 22 },
  { host: [10, 0, 2, 3].join("."), port: 53 },
  { host: [192, 168, 1, 1].join("."), port: 80 },
  { host: [169, 254, 169, 254].join("."), port: 80 },
  { host: [1, 1, 1, 1].join("."), port: 443 },
]);
const PROBE_TIMEOUT_MS = 240_000;
const PROBE_INTERVAL_MS = 6 * 60 * 60_000;
const PROBE_RETRY_MS = 10 * 60_000;

interface VmRun {
  readonly task: ExecutionTask;
  readonly dir: string;
  child: ChildProcess | null;
  qmp: QmpClient | null;
  cancelRequested: boolean;
  destroyed: boolean;
  revoked: boolean;
  readonly abort: AbortController;
  readonly timers: NodeJS.Timeout[];
}

export class VmPool implements TaskExecutor {
  readonly #options: VmPoolOptions;
  readonly #root: string;
  readonly #active = new Map<string, VmRun>();
  #readiness: VmReadiness = { ready: false, reason: "尚未检查", kvm: false };
  #checkedAt = 0;
  #gcTimer: NodeJS.Timeout | null = null;
  /** 最近一次探针 VM 的结论；只有它通过，VM 槽位才可用。 */
  #probe: CheckResult = NOT_CHECKED;
  #probeOmpVersion: string | null = null;
  #probeDir: string | null = null;
  #probeAt = 0;
  #probeChild: ChildProcess | null = null;

  constructor(options: VmPoolOptions) {
    this.#options = options;
    this.#root = join(options.config.dataDir, "vm");
  }

  /** 启动时清理：结束命令行指向 VM 工作目录的残留 qemu，删掉全部 VM 工作目录。 */
  sweep(): void {
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    if (existsSync("/proc")) {
      for (const pid of readdirSync("/proc")) {
        if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
        let cmdline = "";
        try {
          cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
        } catch {
          continue;
        }
        if (cmdline.includes(`${this.#root}/`) && /qemu-system/.test(cmdline)) {
          try {
            process.kill(Number(pid), "SIGKILL");
          } catch {
            // 已经退出，或不属于本用户。
          }
        }
      }
    }
    for (const name of readdirSync(this.#root)) rmSync(join(this.#root, name), { recursive: true, force: true });
    this.#gcTimer = setInterval(() => this.#gc(), GC_INTERVAL_MS);
    this.#gcTimer.unref();
  }

  stop(): void {
    this.destroyAll();
    clearInterval(this.#gcTimer ?? undefined);
    this.#probeChild?.kill("SIGKILL");
  }

  #gc(): void {
    const active = new Set([...this.#active.values()].map(vm => vm.dir));
    if (this.#probeDir) active.add(this.#probeDir);
    for (const name of readdirSync(this.#root)) {
      const dir = join(this.#root, name);
      if (!active.has(dir)) rmSync(dir, { recursive: true, force: true });
    }
  }

  /** 前置条件：/dev/kvm 可读写、qemu 与 qemu-img 可执行、三个资产文件存在、node 容器没有 capability 且有 no-new-privileges 与 seccomp。 */
  #prerequisites(): { kvm: boolean; reason: string | null } {
    const { vm } = this.#options.config;
    let kvm = false;
    try {
      accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
      kvm = true;
    } catch {
      kvm = false;
    }
    let reason: string | null = null;
    if (!kvm) reason = "/dev/kvm 不可读写";
    for (const [label, file] of [["基础镜像", vm.baseImage], ["工具盘", vm.toolsImage], ["cloud-init 种子", vm.seedIso]] as const) {
      if (reason === null && !existsSync(file)) reason = `缺少 VM ${label}：${file}`;
    }
    for (const binary of [vm.qemu, vm.qemuImg]) {
      if (reason !== null) break;
      try {
        execFileSync(binary, ["--version"], { stdio: "ignore", timeout: 10_000 });
      } catch {
        reason = `无法执行 ${binary}`;
      }
    }
    if (reason === null) {
      const problems = nodeProcessProblems();
      if (problems.length > 0) reason = problems.join("；");
    }
    return { kvm, reason };
  }

  /**
   * 前置条件（缓存 60 秒）加最近一次探针 VM 的结论。探针到期（通过后 6 小时、失败后 10 分钟）且没有任务在跑时，
   * 在后台起一台新的探针 VM；探针跑完之前保持上一次的结论（首次为未通过）。
   */
  readiness(): VmReadiness {
    if (this.#slots() === 0) return { ready: false, reason: "VM 槽位为 0", kvm: false };
    if (Date.now() - this.#checkedAt >= 60_000) {
      this.#checkedAt = Date.now();
      const prerequisites = this.#prerequisites();
      this.#readiness = { ready: false, reason: prerequisites.reason, kvm: prerequisites.kvm };
    }
    if (this.#readiness.reason !== null) return this.#readiness;
    const due = Date.now() - this.#probeAt >= (this.#probe.ok ? PROBE_INTERVAL_MS : PROBE_RETRY_MS);
    if (due && this.#probeDir === null && this.#active.size === 0) {
      this.#probeAt = Date.now();
      void this.#runProbe();
    }
    return { ready: this.#probe.ok, reason: this.#probe.ok ? null : `探针 VM：${this.#probe.error ?? "未通过"}`, kvm: this.#readiness.kvm };
  }

  /** VM 执行器的自检结论（给心跳的 self_check）。 */
  check(): CheckResult & { readonly ompVersion: string | null } {
    const readiness = this.readiness();
    if (!readiness.ready) return { ok: false, error: readiness.reason, checked_at: this.#probe.checked_at, ompVersion: null };
    return { ...this.#probe, ompVersion: this.#probeOmpVersion };
  }

  /**
   * 起停一台不带仓库的探针 VM：与任务 VM 完全相同的隔离参数，输入盘只有 probe.json，不传任何真实令牌。
   * 通过条件：QMP 可用且报告运行中；来宾里的 runner 发出事件；来宾里降权用户执行 omp --version 成功；
   * 经 guestfwd 的模型端点（节点本地应答，带 fw_cfg 里的一次性探针令牌）返回 200；全部直连目标连不上；规定时间内自行关机。
   */
  async #runProbe(): Promise<void> {
    const { config } = this.#options;
    const dir = join(this.#root, `probe-${randomBytes(6).toString("hex")}`);
    this.#probeDir = dir;
    const probeToken = randomBytes(32).toString("base64url");
    const servers: (HttpServer | NetServer)[] = [];
    const sockets = new Set<Socket>();
    const track = (socket: Socket): void => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    };
    let child: ChildProcess | null = null;
    let qmp: QmpClient | null = null;
    const started = Date.now();
    let result: CheckResult;
    let ompVersion: string | null = null;
    try {
      mkdirSync(dir, { mode: 0o700 });
      const layout: QemuLayout = {
        dir,
        cpus: 1,
        memoryMib: 1024,
        overlay: join(dir, "overlay.qcow2"),
        inputDisk: join(dir, "input.img"),
        outputDisk: join(dir, "output.img"),
        modelSocket: join(dir, "model.sock"),
        egressSocket: null,
        eventsSocket: join(dir, "events.sock"),
        tokenFile: join(dir, "token"),
        qmpSocket: join(dir, "qmp.sock"),
      };
      await run(config.vm.qemuImg, ["create", "-q", "-f", "qcow2", "-b", config.vm.baseImage, "-F", "qcow2", layout.overlay, `${config.vm.diskGib}G`], { timeout: 60_000 });
      const probeJson = JSON.stringify({
        endpoints: { model_host: GUEST_FORWARD_ADDRESS, model_port: GUEST_MODEL_PORT, proxy_url: null },
        direct_targets: PROBE_DIRECT_TARGETS,
      });
      writeFileSync(layout.inputDisk, writeTar([{ name: "probe.json", data: Buffer.from(probeJson) }]), { mode: 0o600 });
      const outputFd = openSync(layout.outputDisk, "w", 0o600);
      ftruncateSync(outputFd, OUTPUT_DISK_BYTES);
      closeSync(outputFd);
      writeFileSync(layout.tokenFile, probeToken, { mode: 0o600 });

      // 探针的模型端点由节点本地应答：验证 guestfwd → netcat → unix socket 这条通路与 fw_cfg 令牌；中继到 control 的连通另由模型自检证明。
      let modelHits = 0;
      const modelServer = createHttpServer((req, res) => {
        const ok = req.method === "GET" && req.url === "/model/v1/models" && req.headers.authorization === `Bearer ${probeToken}`;
        if (ok) modelHits += 1;
        res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
        res.end(JSON.stringify(ok ? { object: "list", data: [] } : { error: { code: "task_token_invalid", message: "探针令牌不符" } }));
      });
      modelServer.on("connection", track);
      servers.push(modelServer);
      await new Promise<void>((resolve, reject) => {
        modelServer.once("error", reject);
        modelServer.listen(layout.modelSocket, () => resolve());
      });
      let guestStarted = false;
      const eventsServer = createNetServer(socket => {
        track(socket);
        socket.on("data", () => {
          guestStarted = true;
        });
        socket.on("error", () => undefined);
      });
      servers.push(eventsServer);
      await new Promise<void>((resolve, reject) => {
        eventsServer.once("error", reject);
        eventsServer.listen(layout.eventsSocket, () => resolve());
      });

      let stderrTail = "";
      const proc = spawn(config.vm.qemu, qemuArgs(config, layout), { cwd: dir, stdio: ["ignore", "ignore", "pipe"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
      child = proc;
      this.#probeChild = proc;
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2_000);
      });
      const exited = new Promise<number | null>(resolve => {
        proc.once("error", error => {
          stderrTail = `${stderrTail}\n${error.message}`;
          resolve(null);
        });
        proc.once("exit", code => resolve(code));
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, PROBE_TIMEOUT_MS);
      try {
        qmp = await Promise.race([QmpClient.open(layout.qmpSocket, 20_000), exited.then(() => null)]);
      } catch {
        qmp = null;
      }
      rmSync(layout.tokenFile, { force: true });
      let running = false;
      if (qmp) {
        const status = await qmp.execute("query-status").catch(() => null);
        running = typeof status === "object" && status !== null && "running" in status && status.running === true;
      } else {
        proc.kill("SIGKILL");
      }
      const exitCode = await exited;
      clearTimeout(timer);
      const problems: string[] = [];
      if (!qmp) problems.push(`qemu 没有起来（QMP 不可用）：${stderrTail.trim().split("\n").pop() ?? ""}`);
      else if (!running) problems.push("QMP 报告 VM 没有在运行");
      if (timedOut) problems.push(`探针 VM ${PROBE_TIMEOUT_MS / 1000} 秒内没有关机，已强制结束`);
      if (qmp && !guestStarted) problems.push(`来宾里的 runner 没有报到（qemu 退出码 ${exitCode ?? "无"}）`);
      // 关机必须是来宾自己发起并经 QMP 确认（SHUTDOWN 事件，原因 guest-shutdown），不能只看进程退出。
      if (qmp && !timedOut && qmp.shutdownReason !== "guest-shutdown") {
        problems.push(`QMP 没有确认来宾自行关机（收到的事件：${qmp.events.join(",") || "无"}，原因 ${qmp.shutdownReason ?? "无"}）`);
      }
      if (problems.length === 0) {
        const raw = readTarSelected(layout.outputDisk, new Set(["probe-result.json"]), 64 * 1024).get("probe-result.json");
        if (!raw) problems.push("探针 VM 没有写出结果");
        else {
          const parsed: unknown = JSON.parse(raw.toString("utf8"));
          const evidence = parseProbeEvidence(parsed);
          const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
          const model = typeof record.model_endpoint === "object" && record.model_endpoint !== null ? (record.model_endpoint as Record<string, unknown>) : {};
          const direct = Array.isArray(record.direct) ? record.direct : [];
          if (!evidence?.omp_version) problems.push(`来宾里 omp 不可用：${evidence?.omp_error ?? "没有版本输出"}`);
          else if (evidence.omp_version !== this.#options.config.ompVersion) problems.push(`来宾 omp 版本 ${evidence.omp_version} 与期望的 ${this.#options.config.ompVersion} 不一致`);
          if (model.status !== 200 || modelHits === 0) problems.push(`经 guestfwd 的模型端点不通（${String(model.status ?? model.error ?? "无响应")}）`);
          if (direct.length !== PROBE_DIRECT_TARGETS.length) problems.push("来宾没有报告全部直连探测");
          for (const item of direct) {
            if (typeof item === "object" && item !== null && "connected" in item && item.connected !== false) {
              problems.push(`来宾直连 ${"host" in item ? String(item.host) : "?"}:${"port" in item ? String(item.port) : "?"} 成功，restrict=on 没有生效`);
            }
          }
          ompVersion = evidence?.omp_version ?? null;
        }
      }
      result = problems.length === 0
        ? { ok: true, error: null, checked_at: new Date().toISOString() }
        : { ok: false, error: problems.join("；").slice(0, 1_000), checked_at: new Date().toISOString() };
    } catch (error) {
      child?.kill("SIGKILL");
      result = { ok: false, error: `探针 VM 出错：${error instanceof Error ? error.message : String(error)}`.slice(0, 1_000), checked_at: new Date().toISOString() };
    } finally {
      qmp?.close();
      for (const server of servers) server.close();
      for (const socket of sockets) socket.destroy();
      rmSync(dir, { recursive: true, force: true });
      this.#probeDir = null;
      this.#probeChild = null;
    }
    this.#probe = result;
    this.#probeOmpVersion = result.ok ? ompVersion : null;
    this.#options.onProbe({ ...result, seconds: Math.round((Date.now() - started) / 1000) });
  }

  #slots(): number {
    return this.#options.config.node.slots.vm;
  }

  /** 空闲 VM 槽位；探针 VM 在跑时占一个位置。 */
  free(): number {
    if (this.#slots() === 0 || !this.readiness().ready) return 0;
    return Math.max(0, this.#slots() - this.#active.size - (this.#probeDir ? 1 : 0));
  }

  running(): number {
    return this.#active.size;
  }

  start(task: ExecutionTask, bundle: Buffer, sink: ExecutionSink): ExecutionHandle {
    if (this.free() <= 0) {
      return {
        done: Promise.resolve<ExecutionOutcome>({ kind: "failure", code: "resource_unavailable", message: this.readiness().reason ?? "没有空闲的 VM 槽位" }),
        cancel: () => undefined,
        destroy: () => undefined,
      };
    }
    const vm: VmRun = {
      task,
      dir: join(this.#root, randomBytes(8).toString("hex")),
      child: null,
      qmp: null,
      cancelRequested: false,
      destroyed: false,
      revoked: false,
      abort: new AbortController(),
      timers: [],
    };
    this.#active.set(vm.dir, vm);
    const done = this.#execute(vm, bundle, sink).finally(() => {
      vm.revoked = true;
      vm.abort.abort();
      for (const timer of vm.timers) clearTimeout(timer);
      vm.qmp?.close();
      this.#active.delete(vm.dir);
      rmSync(vm.dir, { recursive: true, force: true });
    });
    return {
      done,
      cancel: () => this.#cancel(vm),
      destroy: () => this.#destroy(vm),
    };
  }

  destroyAll(): void {
    for (const vm of this.#active.values()) this.#destroy(vm);
  }

  #cancel(vm: VmRun): void {
    if (vm.cancelRequested || vm.destroyed) return;
    vm.cancelRequested = true;
    vm.revoked = true;
    void vm.qmp?.execute("system_powerdown").catch(() => undefined);
    vm.timers.push(setTimeout(() => {
      void vm.qmp?.execute("quit").catch(() => undefined);
      vm.timers.push(setTimeout(() => vm.child?.kill("SIGKILL"), QUIT_GRACE_MS));
    }, POWERDOWN_GRACE_MS));
    // QMP 还没连上（qemu 正在启动）时直接结束进程。
    if (!vm.qmp) vm.child?.kill("SIGKILL");
  }

  #destroy(vm: VmRun): void {
    if (vm.destroyed) return;
    vm.destroyed = true;
    vm.revoked = true;
    vm.abort.abort();
    vm.child?.kill("SIGKILL");
  }

  async #execute(vm: VmRun, bundle: Buffer, sink: ExecutionSink): Promise<ExecutionOutcome> {
    const { config } = this.#options;
    const { task } = vm;
    const servers: (HttpServer | NetServer)[] = [];
    // guestfwd 的 netcat 在 qemu 退出后要等对端关闭才退出：任务结束时主动断开所有本地端点连接。
    const sockets = new Set<Socket>();
    const track = (socket: Socket): void => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    };
    let egress: EgressProxy | null = null;
    try {
      mkdirSync(vm.dir, { mode: 0o700 });
      const overlay = join(vm.dir, "overlay.qcow2");
      const inputDisk = join(vm.dir, "input.img");
      const outputDisk = join(vm.dir, "output.img");
      const tokenFile = join(vm.dir, "token");
      const modelSocket = join(vm.dir, "model.sock");
      const egressSocket = join(vm.dir, "egress.sock");
      const eventsSocket = join(vm.dir, "events.sock");
      const qmpSocket = join(vm.dir, "qmp.sock");

      await run(config.vm.qemuImg, ["create", "-q", "-f", "qcow2", "-b", config.vm.baseImage, "-F", "qcow2", overlay, `${config.vm.diskGib}G`], { timeout: 60_000 });
      const proxyUrl = config.egress.allow.length > 0 ? `http://${GUEST_FORWARD_ADDRESS}:${GUEST_PROXY_PORT}` : null;
      const taskJson = JSON.stringify({
        task: runnerTaskOf(task),
        endpoints: { model_host: GUEST_FORWARD_ADDRESS, model_port: GUEST_MODEL_PORT, proxy_url: proxyUrl },
      });
      writeFileSync(inputDisk, writeTar([{ name: "task.json", data: Buffer.from(taskJson) }, { name: "bundle.json", data: bundle }]), { mode: 0o600 });
      const outputFd = openSync(outputDisk, "w", 0o600);
      ftruncateSync(outputFd, OUTPUT_DISK_BYTES);
      closeSync(outputFd);
      writeFileSync(tokenFile, task.model_token, { mode: 0o600 });

      const modelServer = createHttpServer((req, res) => {
        void handleModelRequest(req, res, {
          client: this.#options.client,
          task,
          signal: vm.abort.signal,
          revoked: () => vm.revoked,
          onUnauthorized: this.#options.onUnauthorized,
        }).then(handled => {
          if (!handled) {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { code: "not_found", message: "VM 的模型端点只有 /model/v1/*" } }));
          }
        }, () => res.destroy());
      });
      modelServer.on("connection", track);
      servers.push(modelServer);
      await new Promise<void>((resolve, reject) => {
        modelServer.once("error", reject);
        modelServer.listen(modelSocket, () => resolve());
      });

      if (proxyUrl) {
        egress = await startEgressProxy({
          socketPath: egressSocket,
          allow: config.egress.allow,
          denyCidrs: config.egress.denyCidrs,
          maxConnections: config.egress.maxConnections,
          maxBytes: config.egress.maxBytes,
          record: entry => this.#options.onEgress(task.task_id, entry),
        });
      }

      let sawEvent = false;
      const eventsServer = createNetServer(socket => {
        track(socket);
        let buffer = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
          buffer += chunk;
          let newline = buffer.indexOf("\n");
          while (newline !== -1) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf("\n");
            try {
              const event = normalizeRunnerEvent(JSON.parse(line));
              if (event) {
                sawEvent = true;
                sink.emit(event);
              }
            } catch {
              // 不是 JSON 的行丢弃（来宾里的程序可能写乱数据）。
            }
          }
          if (buffer.length > MAX_EVENT_LINE) buffer = "";
        });
        socket.on("error", () => undefined);
      });
      servers.push(eventsServer);
      await new Promise<void>((resolve, reject) => {
        eventsServer.once("error", reject);
        eventsServer.listen(eventsSocket, () => resolve());
      });

      if (vm.cancelRequested || vm.destroyed) return { kind: "failure", code: "cancelled", message: "任务在 VM 启动前被取消" };

      const args = qemuArgs(config, {
        dir: vm.dir,
        cpus: task.resources.cpu,
        memoryMib: task.resources.memory_mib,
        overlay,
        inputDisk,
        outputDisk,
        modelSocket,
        egressSocket: proxyUrl ? egressSocket : null,
        eventsSocket,
        tokenFile,
        qmpSocket,
      });
      let stderrTail = "";
      const child = spawn(config.vm.qemu, args, { cwd: vm.dir, stdio: ["ignore", "ignore", "pipe"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
      vm.child = child;
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2_000);
      });
      const exited = new Promise<number | null>(resolve => {
        child.once("error", error => {
          stderrTail = `${stderrTail}\n${error.message}`;
          resolve(null);
        });
        child.once("exit", code => resolve(code));
      });

      try {
        vm.qmp = await Promise.race([QmpClient.open(qmpSocket, 20_000), exited.then(() => null)]);
      } catch {
        vm.qmp = null;
      }
      // fw_cfg 的文件在 qemu 建机器时已读入；QMP 可用说明机器已建好，令牌文件立即删掉。
      try {
        unlinkSync(tokenFile);
      } catch {
        // 已删除。
      }
      if (!vm.qmp) {
        child.kill("SIGKILL");
        await exited;
        if (vm.cancelRequested || vm.destroyed) return { kind: "failure", code: "cancelled", message: "任务在 VM 启动时被取消" };
        return { kind: "failure", code: "vm_start_failed", message: `qemu 没有起来：${stderrTail.trim().split("\n").pop() ?? ""}`.slice(0, 1_000) };
      }
      if (vm.cancelRequested) void vm.qmp.execute("system_powerdown").catch(() => undefined);
      vm.timers.push(setTimeout(() => {
        if (!sawEvent && !vm.cancelRequested && !vm.destroyed) {
          stderrTail = `${stderrTail}\n来宾 ${FIRST_EVENT_TIMEOUT_MS / 1000} 秒内没有发出任何事件`;
          child.kill("SIGKILL");
        }
      }, FIRST_EVENT_TIMEOUT_MS));

      const exitCode = await exited;
      if (vm.destroyed || vm.cancelRequested) return { kind: "failure", code: "cancelled", message: "任务被取消，VM 已关闭" };
      let files: Map<string, Buffer>;
      try {
        files = readTarSelected(outputDisk, new Set(["result.json", "failure.json"]), 4 * 1024 * 1024);
      } catch (error) {
        return { kind: "failure", code: "infra_failure", message: `读不出 VM 的输出盘：${error instanceof Error ? error.message : String(error)}` };
      }
      const resultFile = files.get("result.json");
      if (resultFile) {
        try {
          const parsed: unknown = JSON.parse(resultFile.toString("utf8"));
          const raw = typeof parsed === "object" && parsed !== null && "result" in parsed ? parsed.result : undefined;
          return { kind: "result", result: validateTaskResult(task.kind, raw) };
        } catch (error) {
          return { kind: "failure", code: "schema", message: `VM 交回的结果不合格：${error instanceof Error ? error.message : String(error)}` };
        }
      }
      const failureFile = files.get("failure.json");
      if (failureFile) {
        try {
          const parsed: unknown = JSON.parse(failureFile.toString("utf8"));
          if (typeof parsed === "object" && parsed !== null && "code" in parsed && "message" in parsed && typeof parsed.code === "string" && typeof parsed.message === "string") {
            const code: FailureCode = RUNNER_FAILURE_CODES.has(parsed.code) ? (parsed.code as FailureCode) : "infra_failure";
            return { kind: "failure", code, message: parsed.message.slice(0, 2_000) };
          }
        } catch {
          // 落到下面的通用失败。
        }
      }
      const detail = stderrTail.trim().split("\n").pop() ?? "";
      return {
        kind: "failure",
        code: sawEvent ? "infra_failure" : "vm_start_failed",
        message: `VM 结束（退出码 ${exitCode ?? "无"}）但没有写出结果${detail ? `：${detail}` : ""}`.slice(0, 1_000),
      };
    } catch (error) {
      vm.child?.kill("SIGKILL");
      return { kind: "failure", code: "vm_start_failed", message: `准备 VM 失败：${error instanceof Error ? error.message : String(error)}`.slice(0, 1_000) };
    } finally {
      egress?.close();
      for (const server of servers) server.close();
      for (const socket of sockets) socket.destroy();
    }
  }
}
