/**
 * 节点的本地模型代理（sandbox 的槽位 socket 与 VM 的 model.sock 共用）：
 * 先核对请求带的模型令牌等于本任务的令牌（只认本任务、租约仍有效），再把它移到 X-Geek-Bot-Task-Token，
 * 加上节点令牌、lease、epoch 转成 control 的模型中继请求；响应（含流式 SSE）原样流回。
 * 节点从不持有网关密钥；control 401（节点令牌失效）时通知全局停机。
 */
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { ExecutionTask } from "@geek-bot/protocol";
import { ControlHttpError } from "./control-client.js";
import type { ControlClient } from "./control-client.js";

const MAX_BODY_BYTES = 16 * 1024 * 1024;

export interface RelayContext {
  readonly client: ControlClient;
  readonly task: ExecutionTask;
  /** 任务结束或被撤销时中断在途请求。 */
  readonly signal: AbortSignal;
  /** 撤销后（取消、销毁）一律拒绝。 */
  readonly revoked: () => boolean;
  readonly onUnauthorized: () => void;
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({ error: { code, message } });
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** 处理路径以 /model/v1/ 开头的请求；返回 false 表示不是模型请求。 */
export async function handleModelRequest(req: IncomingMessage, res: ServerResponse, context: RelayContext): Promise<boolean> {
  const path = (req.url ?? "").split("?")[0];
  let subpath: "chat/completions" | "models";
  if (req.method === "POST" && path === "/model/v1/chat/completions") subpath = "chat/completions";
  else if (req.method === "GET" && path === "/model/v1/models") subpath = "models";
  else if (path.startsWith("/model/")) {
    sendError(res, 404, "not_found", "本地模型代理只有 chat/completions 与 models");
    return true;
  } else return false;

  const expected = Buffer.from(`Bearer ${context.task.model_token}`);
  const presented = Buffer.from(req.headers.authorization ?? "");
  if (context.revoked() || presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    sendError(res, 401, "task_token_invalid", "模型令牌无效或任务已结束");
    return true;
  }
  const body = subpath === "chat/completions" ? await readBody(req) : Buffer.alloc(0);
  if (body === null) {
    sendError(res, 413, "payload_too_large", "模型请求体超过上限");
    return true;
  }
  let upstream: Response;
  try {
    upstream = await context.client.relay(req.method === "POST" ? "POST" : "GET", subpath, context.task, body.length > 0 ? body.toString("utf8") : null, req.headers.accept ?? "application/json", context.signal);
  } catch (error) {
    sendError(res, 502, "upstream_error", error instanceof ControlHttpError ? error.message : "转发模型请求失败");
    return true;
  }
  if (upstream.status === 401) {
    const text = await upstream.text().catch(() => "");
    if (!text.includes("task_token_invalid")) context.onUnauthorized();
    res.writeHead(401, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
    res.end(text);
    return true;
  }
  const headers: Record<string, string> = {};
  for (const name of ["content-type", "retry-after", "cache-control"]) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  res.writeHead(upstream.status, headers);
  if (!upstream.body) {
    res.end();
    return true;
  }
  // fetch 的 ReadableStream 与 node:stream/web 的是同一个实现，只是类型声明分属 DOM 与 Node 两套。
  const webBody = upstream.body as NodeReadableStream<Uint8Array>;
  const stream = Readable.fromWeb(webBody);
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
  return true;
}
