/**
 * 回环地址上的模型转发器：omp 只连 127.0.0.1，转发器把请求转给节点的本地模型端点
 * （sandbox：共享卷里的 unix socket；VM：QEMU guestfwd 的来宾内部地址），路径加 /model 前缀。
 * 只放行 POST /v1/chat/completions 与 GET /v1/models；omp 带来的本地口令换成本任务的模型令牌，
 * 其它请求头一律不转发。响应原样流回（含流式 SSE）。
 */
import { timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

/** 节点的本地模型端点；headers 是每个请求都要带上的固定头（sandbox 的 X-Runner-Session）。 */
export type Upstream = ({ readonly socketPath: string } | { readonly host: string; readonly port: number }) & { readonly headers?: Readonly<Record<string, string>> };

export interface ModelForwarder {
  readonly port: number;
  close(): Promise<void>;
}

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const ROUTES: Readonly<Record<string, string>> = Object.freeze({
  "POST /v1/chat/completions": "/model/v1/chat/completions",
  "GET /v1/models": "/model/v1/models",
});

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function reject(res: ServerResponse, status: number, code: string, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({ error: { code, message } });
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function handle(req: IncomingMessage, res: ServerResponse, upstream: Upstream, localKey: string, modelToken: string): void {
  const path = (req.url ?? "").split("?")[0];
  const target = ROUTES[`${req.method} ${path}`];
  if (!target) return reject(res, 404, "not_found", "转发器只放行 chat/completions 与 models");
  if (!sameSecret(req.headers.authorization ?? "", `Bearer ${localKey}`)) return reject(res, 401, "unauthenticated", "本地口令不符");
  const chunks: Buffer[] = [];
  let size = 0;
  req.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      reject(res, 413, "payload_too_large", "模型请求体超过上限");
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (size > MAX_REQUEST_BYTES) return;
    const body = Buffer.concat(chunks);
    const headers: Record<string, string | number> = {
      ...upstream.headers,
      authorization: `Bearer ${modelToken}`,
      accept: req.headers.accept ?? "application/json",
      "content-length": body.length,
    };
    if (body.length > 0) headers["content-type"] = "application/json";
    const options = "socketPath" in upstream
      ? { socketPath: upstream.socketPath, path: target, method: req.method, headers }
      : { host: upstream.host, port: upstream.port, path: target, method: req.method, headers };
    const outgoing = httpRequest(options, incoming => {
      const responseHeaders: Record<string, string> = {};
      for (const name of ["content-type", "retry-after", "cache-control"]) {
        const value = incoming.headers[name];
        if (typeof value === "string") responseHeaders[name] = value;
      }
      res.writeHead(incoming.statusCode ?? 502, responseHeaders);
      incoming.pipe(res);
      incoming.on("error", () => res.destroy());
    });
    outgoing.on("error", () => reject(res, 502, "upstream_error", "连不上节点的模型端点"));
    res.on("close", () => outgoing.destroy());
    outgoing.end(body);
  });
}

/** 在 127.0.0.1 的随机端口起转发器。 */
export function startModelForwarder(upstream: Upstream, localKey: string, modelToken: string): Promise<ModelForwarder> {
  const server: Server = createServer((req, res) => handle(req, res, upstream, localKey, modelToken));
  server.keepAliveTimeout = 5_000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("转发器没有拿到端口"));
        return;
      }
      resolve({
        port: address.port,
        close: () => new Promise(done => {
          server.closeAllConnections();
          server.close(() => done());
        }),
      });
    });
  });
}
