/**
 * sandbox 槽位模式：runner 在无网、根只读的 sandbox 容器里运行，唯一的对外通道是共享卷里由 node 监听的 unix socket。
 * 一个进程只做一个任务：长轮询领任务 → 取任务包 → 执行（事件每秒批量交给 node，响应里带取消标志）→ 交结果或失败 → 退出。
 * 容器的重启策略把进程拉起来时 tmpfs 工作目录是全新的，所以任务之间不留任何状态。
 * 本地端点（node 提供，消息形状见 docs/services/node/protocol.md「sandbox 与 VM 怎样访问节点」）：
 *   GET  /v1/task?wait=25   → 200 { task, model_token } | 204
 *   GET  /v1/bundle         → 任务包原始字节
 *   POST /v1/events         { events } → { cancel }
 *   POST /v1/result         { result }
 *   POST /v1/failure        { code, message }
 *   /model/v1/*             模型请求（Authorization: Bearer <模型令牌>）
 * 每个请求都带 X-Runner-Session（本进程启动时生成），node 只认领到任务的那个会话。
 */
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { RunnerEvent } from "./events.js";
import { collectProbe } from "./probe.js";
import { runTask, validateRunnerTask } from "./run.js";
import type { RunOutcome } from "./run.js";

export interface SlotOptions {
  readonly socketPath: string;
  readonly workRoot: string;
  readonly ompPath: string;
  readonly ompDataDir: string;
}

interface SlotResponse {
  readonly status: number;
  readonly body: Buffer;
}

const MAX_RESPONSE_BYTES = 512 * 1024 * 1024;
const EVENT_BATCH = 200;

function slotRequest(options: SlotOptions, session: string, method: string, path: string, body: unknown, timeoutMs: number): Promise<SlotResponse> {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      socketPath: options.socketPath,
      method,
      path,
      headers: {
        "x-runner-session": session,
        ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
      },
      timeout: timeoutMs,
    }, res => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy(new Error("node 的响应超过上限"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("请求 node 超时")));
    req.on("error", reject);
    req.end(payload);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 运行一个任务后返回进程退出码。 */
export async function runSlot(options: SlotOptions): Promise<number> {
  const session = randomUUID();
  // 领任务之前先报到：交出自检证据（omp --version、隔离状态），node 据此判断这个槽位能不能接任务。
  const evidence = await collectProbe(options.ompPath, options.ompDataDir);
  let backoff = 1_000;
  for (;;) {
    try {
      const response = await slotRequest(options, session, "POST", "/v1/hello", evidence, 15_000);
      if (response.status === 200) break;
    } catch {
      // node 还没起来：稍后重试。
    }
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 10_000);
  }
  backoff = 1_000;
  let assignment: { task: unknown; model_token: unknown } | null = null;
  while (assignment === null) {
    let response: SlotResponse;
    try {
      response = await slotRequest(options, session, "GET", "/v1/task?wait=25", undefined, 40_000);
    } catch {
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 10_000);
      continue;
    }
    backoff = 1_000;
    if (response.status === 204) continue;
    if (response.status === 200) {
      assignment = JSON.parse(response.body.toString("utf8")) as { task: unknown; model_token: unknown };
      break;
    }
    if (response.status === 409) return 0;
    if (response.status === 403) {
      // 没通过自检，或 node 重启后不认识这个会话：稍等后退出，由容器重启策略换新进程重新报到、重新采集证据。
      process.stderr.write(`node 不接受这个会话：${response.body.toString("utf8").slice(0, 500)}\n`);
      await sleep(30_000);
      return 1;
    }
    await sleep(2_000);
  }

  const controller = new AbortController();
  const queue: RunnerEvent[] = [];
  const report = async (path: string, body: unknown): Promise<void> => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        const response = await slotRequest(options, session, "POST", path, body, 30_000);
        if (response.status < 500) return;
      } catch {
        // node 暂时不可用：稍后重试。
      }
      await sleep(1_000 * 2 ** attempt);
    }
  };

  let outcome: RunOutcome;
  try {
    const task = validateRunnerTask(assignment.task);
    if (typeof assignment.model_token !== "string" || assignment.model_token === "") throw new Error("node 没有给出模型令牌");
    const modelToken = assignment.model_token;
    const bundle = await slotRequest(options, session, "GET", "/v1/bundle", undefined, 120_000);
    if (bundle.status !== 200) throw new Error(`取任务包失败（${bundle.status}）`);

    let failures = 0;
    const flushOnce = async (): Promise<void> => {
      const events = queue.splice(0, EVENT_BATCH);
      try {
        const response = await slotRequest(options, session, "POST", "/v1/events", { events }, 15_000);
        if (response.status === 200) {
          failures = 0;
          const parsed: unknown = JSON.parse(response.body.toString("utf8"));
          if (typeof parsed === "object" && parsed !== null && "cancel" in parsed && parsed.cancel === true) controller.abort();
          return;
        }
        if (response.status === 409 || response.status === 404) {
          controller.abort();
          return;
        }
        failures += 1;
      } catch {
        failures += 1;
      }
      queue.unshift(...events);
      // 连续 30 次（约 30 秒）交不出事件：node 已经不在了，停下 omp，不再继续消耗模型。
      if (failures >= 30) controller.abort();
    };
    // 事件请求串行发送：同一时刻最多一个在途，定时器在上一个没回来时不叠加新的。
    let chain: Promise<void> = Promise.resolve();
    let pending = false;
    const flush = (): Promise<void> => {
      if (!pending) {
        pending = true;
        chain = chain.then(flushOnce).finally(() => {
          pending = false;
        });
      }
      return chain;
    };
    const pump = setInterval(() => void flush(), 1_000);
    try {
      outcome = await runTask({
        task,
        bundleBytes: bundle.body,
        modelToken,
        upstream: { socketPath: options.socketPath, headers: { "x-runner-session": session } },
        workRoot: options.workRoot,
        ompPath: options.ompPath,
        ompDataDir: options.ompDataDir,
        emit: event => {
          queue.push(event);
        },
        signal: controller.signal,
      });
    } finally {
      clearInterval(pump);
    }
    await chain;
    for (let round = 0; round < 10 && queue.length > 0 && failures < 3; round += 1) await flush();
  } catch (error) {
    outcome = { ok: false, code: "infra_failure", message: error instanceof Error ? error.message : String(error) };
  }
  if (outcome.ok) await report("/v1/result", { result: outcome.result });
  else await report("/v1/failure", { code: outcome.code, message: outcome.message });
  return 0;
}
