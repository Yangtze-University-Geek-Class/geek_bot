/**
 * 后台请求的安全门（S-09、S-20；API.md「会话与 CSRF」「角色与鉴权」）：
 *
 * - 每个请求校验 Host 与实例 origin 一致（防 DNS 重绑定）；没配 GEEK_BOT_PUBLIC_ORIGIN 时只接受回环主机名。
 * - 非 GET/HEAD 一律校验 Origin 等于实例 origin、Sec-Fetch-Site 为 same-origin（带了时）、Content-Type 为 JSON。
 *   签名 webhook 入站（/api/v1/intake/*）由平台签名认证，不走浏览器的 Origin 规则。
 * - 未认领时，除认领与登录相关端点外一律 409 not_claimed。
 * - 每个路由在 config.access 声明需要的角色；owner 高危操作另声明 reauth（10 分钟内重新认证过）。
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { isLoopbackHost } from "../config.js";
import { COOKIE_SESSION, type AuthService, type SessionInfo } from "./auth.js";
import type { PlatformContext } from "./context.js";
import { parseCookies, PlatformError } from "./http.js";

export type Access = "public" | "viewer" | "operator" | "owner";

export interface RouteAccess {
  readonly access: Access;
  /** 只归 owner 并要求 10 分钟内重新认证过（S-09 清单）。 */
  readonly reauth?: boolean;
  /** 实例未认领时也能调用（A-01…A-04）。 */
  readonly beforeClaim?: boolean;
  /** 由平台签名认证的服务端回调，不做浏览器 Origin 校验。 */
  readonly signedCallback?: boolean;
}

const RANK: Readonly<Record<Exclude<Access, "public">, number>> = { viewer: 1, operator: 2, owner: 3 };

declare module "fastify" {
  interface FastifyRequest {
    platformSession: SessionInfo | null;
  }
}

/** 本次请求的实例 origin：配置了就用配置；否则用请求的回环 Host 推出 http://<host>。 */
export function expectedOrigin(ctx: PlatformContext, request: FastifyRequest): string {
  if (ctx.config.publicOrigin !== null) return ctx.config.publicOrigin;
  return `http://${request.headers.host ?? ""}`;
}

export function checkHost(ctx: PlatformContext, request: FastifyRequest): void {
  const host = request.headers.host;
  if (!host || host.length > 260) throw new PlatformError(400, "bad_host", "请求缺少合法的 Host 头");
  if (ctx.config.publicOrigin !== null) {
    if (host.toLowerCase() !== new URL(ctx.config.publicOrigin).host.toLowerCase()) throw new PlatformError(421, "bad_host", "Host 与实例的 origin 不一致");
    return;
  }
  const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.replace(/:\d+$/, "");
  if (!isLoopbackHost(hostname)) throw new PlatformError(421, "bad_host", "没有配置 GEEK_BOT_PUBLIC_ORIGIN 时只接受回环地址的 Host");
}

export function checkCsrf(ctx: PlatformContext, request: FastifyRequest): void {
  const origin = request.headers.origin;
  if (!origin || origin !== expectedOrigin(ctx, request)) throw new PlatformError(403, "csrf_rejected", "写请求的 Origin 缺失或与实例不一致");
  const site = request.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin") throw new PlatformError(403, "csrf_rejected", "写请求必须来自同源页面");
  const type = request.headers["content-type"] ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(type)) throw new PlatformError(415, "unsupported_media_type", "请求体必须是 application/json");
}

/** 在共享平台的后台路由作用域里安装安全门。 */
export function installConsoleGuards(scope: FastifyInstance, ctx: PlatformContext, auth: AuthService): void {
  scope.decorateRequest("platformSession", null);
  // 全部在 onRequest 里做：请求体解析与 schema 校验之前就拒绝越权与跨站请求。
  scope.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    checkHost(ctx, request);
    if (request.is404) return;
    // 路由的 config 由本模块的 RouteAccess 约定；没声明 access 的路由按配置错误拒绝。
    const rule = request.routeOptions.config as Partial<RouteAccess> | undefined;
    const access = rule?.access;
    if (access === undefined) throw new PlatformError(500, "internal_error", "路由没有声明访问规则");
    if (request.method !== "GET" && request.method !== "HEAD" && rule?.signedCallback !== true) checkCsrf(ctx, request);
    if (rule?.beforeClaim !== true && !auth.claimed()) throw new PlatformError(409, "not_claimed", "实例还没有被认领");
    const session = auth.authenticate(parseCookies(request.headers.cookie).get(COOKIE_SESSION));
    request.platformSession = session;
    if (access === "public") return;
    if (!session) throw new PlatformError(401, "unauthenticated", "需要登录");
    ctx.limiter.hit(`session:${session.idHash}`, 600, 60_000);
    if (RANK[session.role] < RANK[access]) throw new PlatformError(403, "forbidden", "当前角色不能做这个操作");
    if (rule?.reauth === true) requireReauth(auth, session);
  });
}

export function requireReauth(auth: AuthService, session: SessionInfo): void {
  if (session.role !== "owner") throw new PlatformError(403, "forbidden", "只有 owner 能做这个操作");
  if (!auth.reauthValid(session)) throw new PlatformError(403, "reauth_required", "这个操作要求 10 分钟内重新认证过");
}

/** 路由处理里取当前会话（access 不是 public 时由 preHandler 保证存在）。 */
export function sessionOf(request: FastifyRequest): SessionInfo {
  const session = request.platformSession;
  if (!session) throw new PlatformError(401, "unauthenticated", "需要登录");
  return session;
}

export function roleAtLeast(session: SessionInfo, need: Exclude<Access, "public">): boolean {
  return RANK[session.role] >= RANK[need];
}
