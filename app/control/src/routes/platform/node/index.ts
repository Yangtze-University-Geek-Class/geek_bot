/**
 * 节点 API（/api/node/v1，节点协议）：Bearer 节点令牌认证，X-Geek-Bot-Protocol 必须在 control 支持的范围内
 * （心跳例外：版本不符仍记录心跳，机器不会被派任务）。不用会话 cookie，不做浏览器 Origin 校验。
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { LeaseRequest, MachineHeartbeat, TaskEvent, TaskResult } from "@geek-bot/protocol";
import { idempotencyKeyOf, PlatformError } from "../../../platform/http.js";
import { PROTOCOL_RANGE, type NodeIdentity } from "../../../platform/machines.js";
import type { PlatformServices } from "../../../platform/registry.js";
import type { RelayHeaders } from "../../../platform/relay.js";
import type { FailureCode } from "../../../platform/tasks.js";
import { BUNDLE_SCHEMA, EVENTS_BODY_LIMIT, EVENTS_SCHEMA, FAILURE_SCHEMA, HEARTBEAT_SCHEMA, LEASE_SCHEMA, RENEW_SCHEMA, RESULT_BODY_LIMIT, RESULT_SCHEMA, SELF_CHECK_MODEL_SCHEMA } from "./contracts.js";

const RELAY_BODY_LIMIT = 8 * 1024 * 1024;

interface Fence { readonly lease_id: string; readonly epoch: number }
interface TaskParams { readonly id: string }

declare module "fastify" {
  interface FastifyRequest {
    platformNode: NodeIdentity | null;
  }
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

export function registerNodeRoutes(app: FastifyInstance, { machines, tasks, relay, ctx }: PlatformServices): void {
  void app.register(async scope => {
    scope.decorateRequest("platformNode", null);
    scope.addHook("onRequest", async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const node = machines.authenticate(request.headers.authorization);
      ctx.limiter.hit(`node:${node.id}`, 1200, 60_000);
      const nameHeader = header(request, "x-geek-bot-node");
      if (nameHeader !== node.name) throw new PlatformError(401, "unauthenticated", "X-Geek-Bot-Node 与令牌对应的机器不一致");
      const protocol = Number(header(request, "x-geek-bot-protocol"));
      if (!Number.isSafeInteger(protocol)) throw new PlatformError(400, "validation_failed", "缺少 X-Geek-Bot-Protocol");
      const heartbeat = request.url.split("?", 1)[0] === "/api/node/v1/heartbeat";
      if (!heartbeat && (protocol < PROTOCOL_RANGE.min || protocol > PROTOCOL_RANGE.max)) {
        throw new PlatformError(426, "protocol_unsupported", `节点协议版本 ${protocol} 不在支持范围 ${PROTOCOL_RANGE.min}–${PROTOCOL_RANGE.max} 内`);
      }
      request.platformNode = node;
    });
    scope.addHook("preHandler", async request => {
      if (!request.url.split("?", 1)[0].startsWith("/api/node/v1/tasks/")) return;
      const lease = header(request, "x-geek-bot-lease");
      const epoch = header(request, "x-geek-bot-epoch");
      const value = request.method === "GET" ? request.query : request.body;
      if (!lease || !epoch || !/^[1-9][0-9]*$/.test(epoch) || !value || typeof value !== "object" || !("lease_id" in value) || !("epoch" in value)) {
        throw new PlatformError(400, "validation_failed", "任务请求缺少租约头或epoch");
      }
      if (lease !== value.lease_id || Number(epoch) !== Number(value.epoch)) throw new PlatformError(400, "validation_failed", "租约头与请求体不一致");
    });
    const nodeOf = (request: FastifyRequest): NodeIdentity => {
      if (!request.platformNode) throw new PlatformError(401, "unauthenticated", "节点令牌无效");
      return request.platformNode;
    };

    scope.post("/api/node/v1/heartbeat", { schema: HEARTBEAT_SCHEMA }, async request =>
      machines.heartbeat(nodeOf(request), Number(header(request, "x-geek-bot-protocol")), request.body as MachineHeartbeat),
    );

    scope.post("/api/node/v1/lease", { schema: LEASE_SCHEMA }, async request => ({
      task: await tasks.lease(nodeOf(request).id, request.body as LeaseRequest, idempotencyKeyOf(request)),
    }));

    scope.post("/api/node/v1/tasks/:id/renew", { schema: RENEW_SCHEMA }, async request =>
      tasks.renew(nodeOf(request).id, (request.params as TaskParams).id, request.body as Fence),
    );

    scope.get("/api/node/v1/tasks/:id/bundle", { schema: BUNDLE_SCHEMA }, async (request, reply) => {
      const query = request.query as { lease_id: string; epoch: string };
      const bundle = tasks.bundle(nodeOf(request).id, (request.params as TaskParams).id, { lease_id: query.lease_id, epoch: Number(query.epoch) });
      // 原样返回落库时计算 sha256 的那份字节，节点按 bundle_sha256 校验。
      return reply.header("Content-Type", "application/json; charset=utf-8").header("X-Geek-Bot-Bundle-Sha256", bundle.sha256).send(Buffer.from(bundle.body, "utf8"));
    });

    scope.post("/api/node/v1/tasks/:id/events", { schema: EVENTS_SCHEMA, bodyLimit: EVENTS_BODY_LIMIT }, async request => {
      const body = request.body as Fence & { events: { seq: number; at: string; kind: TaskEvent["kind"]; text: string }[] };
      return tasks.appendEvents(nodeOf(request).id, (request.params as TaskParams).id, { lease_id: body.lease_id, epoch: body.epoch }, body.events);
    });

    scope.post("/api/node/v1/tasks/:id/result", { schema: RESULT_SCHEMA, bodyLimit: RESULT_BODY_LIMIT }, async request => {
      const body = request.body as Fence & { result: TaskResult };
      return tasks.submitResult(nodeOf(request).id, (request.params as TaskParams).id, { lease_id: body.lease_id, epoch: body.epoch }, body.result);
    });

    scope.post("/api/node/v1/tasks/:id/failure", { schema: FAILURE_SCHEMA }, async request => {
      const body = request.body as Fence & { code: FailureCode; message: string };
      return tasks.submitFailure(nodeOf(request).id, (request.params as TaskParams).id, { lease_id: body.lease_id, epoch: body.epoch }, body.code, body.message);
    });

    const relayHeaders = (request: FastifyRequest): RelayHeaders => ({
      taskToken: header(request, "x-geek-bot-task-token"),
      leaseId: header(request, "x-geek-bot-lease"),
      epoch: header(request, "x-geek-bot-epoch"),
      taskId: header(request, "x-geek-bot-task"),
    });

    scope.get("/api/node/v1/model/v1/models", async request => relay.models(nodeOf(request), relayHeaders(request)));

    // 节点自检的模型连通探针：只用节点令牌，pending 的机器也能调用；control 用自己的网关密钥只读探测，每节点每分钟一次。
    scope.post("/api/node/v1/self-check/model", { schema: SELF_CHECK_MODEL_SCHEMA }, async request => relay.probe(nodeOf(request)));

    scope.post("/api/node/v1/model/v1/chat/completions", { bodyLimit: RELAY_BODY_LIMIT }, async (request, reply) => {
      await relay.chat(nodeOf(request), relayHeaders(request), request.body, reply);
      return reply;
    });

    scope.addHook("preClose", async () => relay.abortAll());
  });
}
