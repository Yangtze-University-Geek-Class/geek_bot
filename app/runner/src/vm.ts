/**
 * VM 模式：runner 在一次性 QEMU/KVM 来宾里以 root 启动（guest-init.sh），omp 降到普通用户运行。
 *   输入：只读原始盘上的 tar（task.json：任务字段与两个 guestfwd 端点；bundle.json：任务包原始字节）；
 *   令牌：fw_cfg 的 opt/geekbot/token（只有 root 可读），只留在 runner 的内存里；
 *   事件：virtio-serial 端口，一行一个 JSON；
 *   输出：可写原始盘上的 tar（result.json 或 failure.json），写完落盘后由 guest-init 关机。
 * 来宾只能经 restrict=on 用户态网络里的两条 guestfwd 出去：模型端点（node 的本地模型代理）与出网 CONNECT 代理。
 * 取消由节点经 QMP 发 system_powerdown：systemd 关机时给本进程发 SIGTERM，runner 停下 omp 并尽量写出 cancelled。
 */
import { createWriteStream, readFileSync } from "node:fs";
import type { WriteStream } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import type { RunnerEvent } from "./events.js";
import { collectProbe } from "./probe.js";
import { runTask, validateRunnerTask } from "./run.js";
import type { RunOutcome } from "./run.js";
import { readTarFile, writeTarFile } from "./tar.js";

export interface VmOptions {
  readonly inputDevice: string;
  readonly outputDevice: string;
  readonly eventsPort: string;
  readonly tokenFile: string;
  readonly workRoot: string;
  readonly runAs: string;
  readonly ompPath: string;
  readonly ompDataDir: string;
  readonly nodeBinDir: string;
}

interface GuestEndpoints {
  readonly model_host: string;
  readonly model_port: number;
  readonly proxy_url: string | null;
}

/** 从 /etc/passwd 查用户的 uid、gid（来宾里没有别的用户数据库）。 */
function lookupUser(name: string): { uid: number; gid: number } {
  for (const line of readFileSync("/etc/passwd", "utf8").split("\n")) {
    const fields = line.split(":");
    if (fields[0] === name && fields.length >= 4) return { uid: Number(fields[2]), gid: Number(fields[3]) };
  }
  throw new Error(`来宾里没有用户 ${name}`);
}

function parseEndpoints(value: unknown): GuestEndpoints {
  if (typeof value !== "object" || value === null) throw new Error("task.json 缺少端点");
  const record = value as Record<string, unknown>;
  const host = record.model_host;
  const port = record.model_port;
  const proxy = record.proxy_url;
  if (typeof host !== "string" || !/^[0-9.]+$/.test(host)) throw new Error("task.json 的 model_host 不合法");
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("task.json 的 model_port 不合法");
  if (proxy !== null && (typeof proxy !== "string" || !/^http:\/\/[0-9.]+:\d{1,5}$/.test(proxy))) throw new Error("task.json 的 proxy_url 不合法");
  return { model_host: host, model_port: port, proxy_url: proxy };
}

function writeOutcome(device: string, outcome: RunOutcome): void {
  const entry = outcome.ok
    ? { name: "result.json", data: Buffer.from(JSON.stringify({ result: outcome.result })) }
    : { name: "failure.json", data: Buffer.from(JSON.stringify({ code: outcome.code, message: outcome.message })) };
  writeTarFile(device, [entry]);
}

/**
 * 自检模式（输入盘里只有 probe.json，没有任务包）：采集隔离证据、在降权用户下执行 omp --version，
 * 再从来宾内部探测：经 guestfwd 的本地模型端点必须连得上（GET /model/v1/models，带 fw_cfg 里的探针令牌），
 * 直连外部与宿主地址必须连不上（restrict=on）。结果写进输出盘的 probe-result.json。
 */
async function runProbe(options: VmOptions, probeJson: Buffer): Promise<void> {
  const parsed: unknown = JSON.parse(probeJson.toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || !("endpoints" in parsed) || !("direct_targets" in parsed)) throw new Error("probe.json 形状不对");
  const endpoints = parseEndpoints(parsed.endpoints);
  const targets = Array.isArray(parsed.direct_targets) ? parsed.direct_targets.filter((item): item is { host: string; port: number } =>
    typeof item === "object" && item !== null && "host" in item && "port" in item && typeof item.host === "string" && typeof item.port === "number") : [];
  const token = readFileSync(options.tokenFile, "utf8").trim();
  const evidence = await collectProbe(options.ompPath, options.ompDataDir, lookupUser(options.runAs));
  const model = await new Promise<{ status: number | null; error: string | null }>(resolve => {
    const req = httpRequest({ host: endpoints.model_host, port: endpoints.model_port, path: "/model/v1/models", method: "GET", headers: { authorization: `Bearer ${token}` }, timeout: 15_000 }, res => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? null, error: null }));
    });
    req.on("timeout", () => req.destroy(new Error("超时")));
    req.on("error", error => resolve({ status: null, error: error.message }));
    req.end();
  });
  const direct: { host: string; port: number; connected: boolean; error: string | null }[] = [];
  for (const target of targets.slice(0, 16)) {
    direct.push(await new Promise(resolve => {
      const socket = connect({ host: target.host, port: target.port, timeout: 4_000 });
      socket.once("connect", () => {
        socket.destroy();
        resolve({ ...target, connected: true, error: null });
      });
      socket.once("timeout", () => {
        socket.destroy();
        resolve({ ...target, connected: false, error: "timeout" });
      });
      socket.once("error", error => resolve({ ...target, connected: false, error: "code" in error && typeof error.code === "string" ? error.code : error.message }));
    }));
  }
  writeTarFile(options.outputDevice, [{ name: "probe-result.json", data: Buffer.from(JSON.stringify({ ...evidence, model_endpoint: model, direct })) }]);
}

/** 运行 VM 里的唯一任务（或自检）；返回进程退出码。 */
export async function runVm(options: VmOptions): Promise<number> {
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  let events: WriteStream | null = null;
  let outcome: RunOutcome;
  try {
    events = createWriteStream(options.eventsPort, { flags: "w" });
    events.on("error", () => undefined);
    events.write(`${JSON.stringify({ at: new Date().toISOString(), kind: "model", text: "VM 里的 runner 已启动" })}\n`);
    const input = readTarFile(options.inputDevice, { maxEntries: 4, maxFileBytes: 512 * 1024 * 1024, maxTotalBytes: 600 * 1024 * 1024 });
    const probeJson = input.get("probe.json");
    if (probeJson) {
      await runProbe(options, probeJson);
      const stream = events;
      await new Promise<void>(resolve => stream.end(() => resolve()));
      return 0;
    }
    const taskJson = input.get("task.json");
    const bundleBytes = input.get("bundle.json");
    if (!taskJson || !bundleBytes) throw new Error("输入盘缺少 task.json 或 bundle.json");
    const parsed: unknown = JSON.parse(taskJson.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || !("task" in parsed) || !("endpoints" in parsed)) throw new Error("task.json 形状不对");
    const task = validateRunnerTask(parsed.task);
    const endpoints = parseEndpoints(parsed.endpoints);
    const modelToken = readFileSync(options.tokenFile, "utf8").trim();
    if (modelToken === "") throw new Error("fw_cfg 里没有模型令牌");
    const sink = events;
    const emit = (event: RunnerEvent): void => {
      sink.write(`${JSON.stringify(event)}\n`);
    };
    outcome = await runTask({
      task,
      bundleBytes,
      modelToken,
      upstream: { host: endpoints.model_host, port: endpoints.model_port },
      workRoot: options.workRoot,
      ompPath: options.ompPath,
      ompDataDir: options.ompDataDir,
      runAs: lookupUser(options.runAs),
      proxyUrl: endpoints.proxy_url ?? undefined,
      extraPath: [options.nodeBinDir],
      emit,
      signal: controller.signal,
    });
  } catch (error) {
    outcome = { ok: false, code: "infra_failure", message: `VM 里的 runner 出错：${error instanceof Error ? error.message : String(error)}`.slice(0, 1_000) };
  }
  writeOutcome(options.outputDevice, outcome);
  const stream = events;
  if (stream) await new Promise<void>(resolve => stream.end(() => resolve()));
  return 0;
}
