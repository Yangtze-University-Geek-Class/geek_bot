/**
 * 运维本地通道：容器里的 CLI 把会写库的命令（backup、verify-backup）交给运行中的 control 执行，
 * CLI 自己不开写连接，守住「只有 control 进程写库」（ADR-0003，data-model「存储与通用约定」）。
 *
 * 形式：`<dataDir>/run/control.sock` 上的 HTTP/1.1（unix socket，不占 TCP 端口，不对外发布）；
 * run 目录权限 0700，只有运行 control 的账号能连。请求和响应都是 JSON，错误形状同后台 API。
 */
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { Logger } from "../log/logger.js";

export const SOCKET_NAME = "control.sock";
const MAX_BODY_BYTES = 4096;

export function socketPath(runDir: string): string {
  return join(runDir, SOCKET_NAME);
}

/** 通道上的一条命令：输入是解析好的 JSON 对象，返回可以序列化的结果；业务错误用 ChannelError。 */
export type ChannelHandler = (body: Record<string, unknown>) => Promise<unknown>;

export class ChannelError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "ChannelError";
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  response.end(text);
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ChannelError(413, "payload_too_large", "请求体太大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (text === "") return resolve({});
      try {
        const value: unknown = JSON.parse(text);
        if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
        resolve(value as Record<string, unknown>);
      } catch {
        reject(new ChannelError(400, "invalid_json", "请求体不是 JSON 对象"));
      }
    });
    req.on("error", reject);
  });
}

export interface OpsChannel {
  readonly path: string;
  listen(): Promise<void>;
  close(): Promise<void>;
}

/** 建通道：routes 的键是路径（例如 /v1/backup），只接受 POST。 */
export function createOpsChannel(runDir: string, routes: Readonly<Record<string, ChannelHandler>>, logger: Logger): OpsChannel {
  const path = socketPath(runDir);
  let server: Server | null = null;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const handler = Object.hasOwn(routes, req.url ?? "") ? routes[req.url ?? ""] : undefined;
    if (!handler) return send(res, 404, { error: { code: "not_found", message: "没有这个命令" } });
    if (req.method !== "POST") return send(res, 405, { error: { code: "method_not_allowed", message: "只接受 POST" } });
    try {
      const body = await readBody(req);
      send(res, 200, await handler(body));
    } catch (error) {
      if (error instanceof ChannelError) return send(res, error.status, { error: { code: error.code, message: error.message } });
      logger.error({ err: error, command: req.url }, "本地通道的命令执行失败");
      send(res, 500, { error: { code: "internal_error", message: `执行失败：${(error as Error).message}` } });
    }
  }

  return {
    path,
    listen() {
      mkdirSync(runDir, { recursive: true, mode: 0o700 });
      chmodSync(runDir, 0o700);
      // control 独占着库，这时不可能有另一个活着的 control；上次异常退出留下的 socket 文件直接删掉。
      rmSync(path, { force: true });
      const created = createServer((req, res) => void handle(req, res));
      server = created;
      return new Promise((resolve, reject) => {
        created.once("error", reject);
        created.listen(path, () => {
          created.off("error", reject);
          chmodSync(path, 0o600);
          resolve();
        });
      });
    },
    close() {
      const current = server;
      server = null;
      if (!current) return Promise.resolve();
      return new Promise(resolve => {
        current.close(() => {
          rmSync(path, { force: true });
          resolve();
        });
        current.closeAllConnections();
      });
    },
  };
}

/** 通道那头没有 control 在运行（socket 不存在或没人监听）。 */
export class ChannelUnavailableError extends Error {
  constructor(readonly path: string) {
    super(`control 没有在运行（本地通道 ${path} 连不上）`);
    this.name = "ChannelUnavailableError";
  }
}

export interface ChannelReply {
  readonly status: number;
  readonly body: unknown;
}

/** CLI 一侧：把命令发给运行中的 control。连不上时抛 ChannelUnavailableError。 */
export function callOpsChannel(runDir: string, route: string, body: Record<string, unknown>, timeoutMs = 30 * 60_000): Promise<ChannelReply> {
  const path = socketPath(runDir);
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath: path, path: route, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }, timeout: timeoutMs },
      res => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) as unknown });
          } catch {
            reject(new Error(`control 的回复不是 JSON（HTTP ${res.statusCode ?? 0}）`));
          }
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("等 control 回复超时")));
    req.on("error", error => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ECONNREFUSED") reject(new ChannelUnavailableError(path));
      else reject(error);
    });
    req.end(payload);
  });
}
