/** 认领、device flow 登录、重新认证、绑定 GitHub 连接、登出与当前账号（A-01…A-04、A-07、A-08）。 */
import type { FastifyInstance } from "fastify";
import { COOKIE_CLAIM, COOKIE_FLOW, COOKIE_SESSION, CLAIM_GRANT_TTL_MS, SESSION_MAX_MS } from "../../../platform/auth.js";
import { clearCookie, parseCookies, setCookie } from "../../../platform/http.js";
import type { PlatformServices } from "../../../platform/registry.js";
import { sessionOf, type RouteAccess } from "../../../platform/security.js";
import { AUTH_STATE_SCHEMA, CLAIM_SCHEMA, DEVICE_SCHEMA, LOGOUT_SCHEMA, ME_SCHEMA, POLL_SCHEMA, type ClaimBody, type DeviceBody, type PollParams } from "./contracts.js";

const PUBLIC_BEFORE_CLAIM: RouteAccess = { access: "public", beforeClaim: true };

export function registerAuthRoutes(app: FastifyInstance, services: PlatformServices): void {
  const { auth, ctx } = services;
  const secure = ctx.config.secureCookies;

  app.get("/api/v1/auth/state", { schema: AUTH_STATE_SCHEMA, config: PUBLIC_BEFORE_CLAIM }, async () => auth.state());

  app.post("/api/v1/auth/claim", { schema: CLAIM_SCHEMA, config: PUBLIC_BEFORE_CLAIM }, async (request, reply) => {
    const body = request.body as ClaimBody;
    const { claimToken } = auth.claim(body.code, request.ip);
    setCookie(reply, COOKIE_CLAIM, claimToken, { maxAgeS: CLAIM_GRANT_TTL_MS / 1000, sameSite: "Strict", secure });
    return reply.code(204).send();
  });

  app.post("/api/v1/auth/device", { schema: DEVICE_SCHEMA, config: PUBLIC_BEFORE_CLAIM }, async (request, reply) => {
    const body = request.body as DeviceBody;
    const { response, flowCookie } = await auth.startFlow({
      purpose: body.purpose,
      connectionId: body.connection_id,
      session: request.platformSession,
      claimCookie: parseCookies(request.headers.cookie).get(COOKIE_CLAIM),
      sourceIp: request.ip,
    });
    // gb_flow 把这次授权绑定到发起它的浏览器（API.md「会话与 CSRF」）。
    setCookie(reply, COOKIE_FLOW, flowCookie, { maxAgeS: response.expires_in_s, sameSite: "Lax", secure });
    return response;
  });

  app.post("/api/v1/auth/device/:flow_id/poll", { schema: POLL_SCHEMA, config: PUBLIC_BEFORE_CLAIM }, async (request, reply) => {
    const params = request.params as PollParams;
    const { response, sessionCookie } = await auth.pollFlow(params.flow_id, parseCookies(request.headers.cookie).get(COOKIE_FLOW), request.ip);
    if (sessionCookie !== null) {
      setCookie(reply, COOKIE_SESSION, sessionCookie, { maxAgeS: SESSION_MAX_MS / 1000, sameSite: "Strict", secure });
      clearCookie(reply, COOKIE_CLAIM, secure);
    }
    if (response.status !== "pending" && response.status !== "slow_down") clearCookie(reply, COOKIE_FLOW, secure);
    return response;
  });

  app.post("/api/v1/auth/logout", { schema: LOGOUT_SCHEMA, config: { access: "viewer" } satisfies RouteAccess }, async (request, reply) => {
    auth.logout(sessionOf(request));
    clearCookie(reply, COOKIE_SESSION, secure);
    return reply.code(204).send();
  });

  app.get("/api/v1/me", { schema: ME_SCHEMA, config: { access: "viewer" } satisfies RouteAccess }, async request => auth.me(sessionOf(request)));
}
