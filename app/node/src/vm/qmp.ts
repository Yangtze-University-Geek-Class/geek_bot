/**
 * QEMU Machine Protocol 的最小客户端：连接 qemu 的 -qmp unix socket，完成能力协商，按顺序发命令，并记下异步事件名。
 * 用到 query-status、system_powerdown（取消时让来宾正常关机）、quit（宽限期后结束 qemu），以及 SHUTDOWN 事件（确认来宾自行关机）。
 */
import { connect } from "node:net";
import type { Socket } from "node:net";
import { createInterface } from "node:readline";

export class QmpClient {
  readonly #socket: Socket;
  readonly #pending: { resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
  #closed = false;
  /** 收到的异步事件名（按到达顺序），例如 SHUTDOWN 的 guest-shutdown 原因见 shutdownReason。 */
  readonly events: string[] = [];
  shutdownReason: string | null = null;

  private constructor(socket: Socket) {
    this.#socket = socket;
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    lines.on("line", line => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof message !== "object" || message === null) return;
      // 异步事件（SHUTDOWN、POWERDOWN 等）与问候不对应请求。
      if ("event" in message) {
        if (typeof message.event === "string") this.events.push(message.event);
        if (message.event === "SHUTDOWN" && "data" in message && typeof message.data === "object" && message.data !== null && "reason" in message.data && typeof message.data.reason === "string") {
          this.shutdownReason = message.data.reason;
        }
        return;
      }
      if ("QMP" in message) return;
      const waiter = this.#pending.shift();
      if (!waiter) return;
      if ("error" in message) waiter.reject(new Error(`QMP 错误：${JSON.stringify(message.error)}`));
      else waiter.resolve("return" in message ? message.return : undefined);
    });
    socket.on("close", () => {
      this.#closed = true;
      for (const waiter of this.#pending.splice(0)) waiter.reject(new Error("QMP 连接已关闭"));
    });
    socket.on("error", () => undefined);
  }

  /** 连接并协商能力；socket 还没出现时按 200 毫秒间隔重试，直到 timeoutMs。 */
  static async open(path: string, timeoutMs: number): Promise<QmpClient> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const socket = await new Promise<Socket>((resolve, reject) => {
          const candidate = connect(path);
          candidate.once("connect", () => resolve(candidate));
          candidate.once("error", reject);
        });
        const client = new QmpClient(socket);
        await client.execute("qmp_capabilities");
        return client;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
  }

  execute(command: string): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("QMP 连接已关闭"));
    return new Promise((resolve, reject) => {
      this.#pending.push({ resolve, reject });
      this.#socket.write(`${JSON.stringify({ execute: command })}\n`);
    });
  }

  close(): void {
    this.#socket.destroy();
  }
}
