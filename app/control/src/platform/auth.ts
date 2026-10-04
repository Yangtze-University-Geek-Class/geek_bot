/**
 * 认领、登录、会话、重新认证与 GitHub 连接绑定（S-09、S-10、S-11；API.md A-01…A-11）。
 *
 * - 认领码只能由 CLI 生成（bootstrapCode），熵 100 位，15 分钟，一次性，库里只存哈希；连续输错 5 次作废。
 * - device flow：认领、登录、重新认证只申请空 scope，拿到 GitHub 数字 id 后立即经 publisher 吊销这一枚令牌；
 *   绑定 GitHub 连接申请 `repo read:org`，X-OAuth-Scopes 必须是 {repo, read:org} 的子集，否则吊销并拒绝。
 * - 会话：256 位随机 sid + HMAC 签名 cookie，库里只存 SHA-256；空闲 2 小时、最长 12 小时；重新认证 10 分钟有效。
 * - 登录模块对 GitHub 只发三类请求：申请设备码、换令牌、GET /user（读取身份与 scope）。吊销只经 publisher（S-06）。
 */
import { randomBytes } from "node:crypto";
import type { AdminRole, AuthStateResponse, DeviceFlowPollResponse, DeviceFlowPurpose, DeviceFlowStartResponse, MeResponse } from "@geek-bot/protocol";
import { mergeSealedCredentials } from "../connectors/index.js";
import { revokeOAuthToken } from "../publisher/index.js";
import type { PlatformContext } from "./context.js";
import { iso, newId, PlatformError, sha256Hex } from "./http.js";
import type { AdminRow } from "./records.js";

export const SESSION_IDLE_MS = 2 * 3_600_000;
export const SESSION_MAX_MS = 12 * 3_600_000;
export const REAUTH_VALID_MS = 10 * 60_000;
export const CLAIM_CODE_TTL_MS = 15 * 60_000;
export const CLAIM_GRANT_TTL_MS = 15 * 60_000;
export const CLAIM_MAX_FAILURES = 5;
/** 绑定代码平台连接时允许的 GitHub OAuth scope（允许名单，CODE-REVIEW 第 12 项）。 */
export const CONNECTION_SCOPE_ALLOWLIST = Object.freeze(["repo", "read:org"] as const);

export const COOKIE_SESSION = "gb_session";
export const COOKIE_CLAIM = "gb_claim";
export const COOKIE_FLOW = "gb_flow";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const GITHUB_TIMEOUT_MS = 15_000;

export interface SessionInfo {
  readonly idHash: string;
  readonly githubId: number;
  readonly login: string;
  readonly role: AdminRole;
  readonly reauthAt: number | null;
  readonly expiresAt: number;
}

interface SessionRow {
  id_hash: string;
  github_id: number;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  reauth_at: number | null;
  login: string;
  role: AdminRole;
}

interface FlowRow {
  id: string;
  purpose: DeviceFlowPurpose;
  browser_hash: string;
  session_hash: string | null;
  claim_hash: string | null;
  connection_id: string | null;
  device_code_ct: string;
  user_code: string;
  verification_uri: string;
  interval_s: number;
  next_poll_at: number;
  expires_at: number;
  status: "pending" | "expired" | "denied" | "done" | "failed";
}

/** 认领码规范化：去掉分隔符与空白，转大写。 */
function normalizeCode(code: string): string {
  return code.replace(/[\s-]/g, "").toUpperCase();
}

/** 生成并登记一枚认领码（只给 CLI 用，经运维本地通道或离线独占库调用）。已认领时拒绝。 */
export function issueBootstrapCode(ctx: Pick<PlatformContext, "db" | "clock" | "auditor">): { code: string; expiresAt: string } {
  return ctx.db.transaction(() => {
    if (ctx.db.prepare("SELECT 1 FROM admins WHERE role = 'owner'").get()) throw new PlatformError(409, "already_claimed", "实例已经被认领，不再生成认领码");
    const now = ctx.clock();
    const bytes = randomBytes(20);
    // 20 个 base32 字符 = 100 位熵（S-10）。
    let raw = "";
    for (let index = 0; index < 20; index += 1) raw += BASE32[(bytes[index] as number) % 32];
    ctx.db.prepare("UPDATE bootstrap_codes SET revoked_at = ? WHERE revoked_at IS NULL AND used_at IS NULL").run(now);
    ctx.db.prepare("INSERT INTO bootstrap_codes (code_hash, created_at, expires_at) VALUES (?, ?, ?)").run(sha256Hex(raw), now, now + CLAIM_CODE_TTL_MS);
    ctx.auditor.write({ actorType: "cli", action: "auth.bootstrap_code.issue", target: "instance" });
    return { code: raw.match(/.{5}/g)?.join("-") ?? raw, expiresAt: iso(now + CLAIM_CODE_TTL_MS) };
  })();
}

export interface AuthService {
  state(): AuthStateResponse;
  claimed(): boolean;
  claim(code: string, sourceIp: string): { claimToken: string };
  authenticate(sessionCookie: string | undefined): SessionInfo | null;
  me(session: SessionInfo): MeResponse;
  logout(session: SessionInfo): void;
  startFlow(input: {
    purpose: DeviceFlowPurpose;
    connectionId: string | undefined;
    session: SessionInfo | null;
    claimCookie: string | undefined;
    sourceIp: string;
  }): Promise<{ response: DeviceFlowStartResponse; flowCookie: string }>;
  pollFlow(flowId: string, flowCookie: string | undefined, sourceIp: string): Promise<{ response: DeviceFlowPollResponse; sessionCookie: string | null }>;
  reauthValid(session: SessionInfo): boolean;
  /** 删除某个管理员的全部会话（移除管理员时）。 */
  dropSessions(githubId: number): void;
}

export function createAuthService(ctx: PlatformContext): AuthService {
  const { db, clock, config, signer, limiter, auditor, logger } = ctx;

  const ownerExists = () => db.prepare("SELECT 1 FROM admins WHERE role = 'owner'").get() !== undefined;

  async function github(url: string, init: RequestInit): Promise<{ status: number; headers: Headers; body: Record<string, unknown> }> {
    let response: Response;
    try {
      response = await ctx.fetchImpl(url, { ...init, signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS) });
    } catch {
      throw new PlatformError(502, "upstream_error", "连不上 GitHub，稍后再试");
    }
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = await response.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {
      body = {};
    }
    return { status: response.status, headers: response.headers, body };
  }

  function oauthClient(): { clientId: string; clientSecret: string } {
    const clientId = config.github.clientId;
    const clientSecret = ctx.secrets.githubClientSecret;
    // 没有 client secret 就无法按 S-11 立即吊销登录令牌，因此不发起任何 device flow。
    if (!clientId || !clientSecret) {
      throw new PlatformError(409, "oauth_not_configured", "实例还没有配置 GitHub OAuth App（GEEK_BOT_GITHUB_CLIENT_ID 与 GEEK_BOT_OAUTH_CLIENT_SECRET_FILE）");
    }
    return { clientId, clientSecret };
  }

  /** W-14：取到身份后立即吊销登录与重新认证令牌；失败重试一次并告警。 */
  async function revoke(token: string, reason: string): Promise<void> {
    const { clientId, clientSecret } = oauthClient();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await revokeOAuthToken({ token, clientId, clientSecret, apiBaseUrl: config.github.apiUrl, fetchImpl: ctx.fetchImpl });
        return;
      } catch (error) {
        if (attempt === 1) {
          logger.error({ err: error, reason }, "吊销 GitHub 登录令牌失败");
          ctx.alerts.raise({ kind: "oauth_revoke_failed", severity: "critical", subject: "github/login_token", message: `吊销 ${reason} 用的 GitHub 令牌失败：需要账号本人在 GitHub 设置里撤销该 OAuth App 的授权` });
        }
      }
    }
  }

  function createSession(githubId: number): string {
    const now = clock();
    const { value, hash } = signer.issue(COOKIE_SESSION);
    db.prepare("INSERT INTO sessions (id_hash, github_id, created_at, last_seen_at, expires_at, reauth_at) VALUES (?, ?, ?, ?, ?, NULL)").run(hash, githubId, now, now, now + SESSION_MAX_MS);
    db.prepare("UPDATE admins SET last_login_at = ? WHERE github_id = ?").run(now, githubId);
    db.prepare("DELETE FROM sessions WHERE expires_at < ? OR last_seen_at < ?").run(now, now - SESSION_IDLE_MS);
    return value;
  }

  function finish(flow: FlowRow, status: FlowRow["status"], githubId: number | null): void {
    db.prepare("UPDATE oauth_flows SET status = ?, result_github_id = ?, completed_at = ? WHERE id = ?").run(status, githubId, clock(), flow.id);
  }

  return {
    claimed: ownerExists,

    state() {
      const botBound = db
        .prepare("SELECT 1 FROM connections c JOIN connection_credentials cc ON cc.connection_id = c.id WHERE c.provider = 'github' AND c.account_external_id IS NOT NULL LIMIT 1")
        .get();
      return { claimed: ownerExists(), login_methods: ["device"], insecure_context: config.insecureContext, bot_bound: botBound !== undefined };
    },

    claim(code, sourceIp) {
      limiter.hit(`claim:${sourceIp}`, 10, 60_000);
      const outcome = db.transaction(() => {
        if (ownerExists()) throw new PlatformError(409, "already_claimed", "实例已经被认领");
        const now = clock();
        const active = db
          .prepare("SELECT id, code_hash, failed_attempts FROM bootstrap_codes WHERE revoked_at IS NULL AND used_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 1")
          .get(now) as { id: number; code_hash: string; failed_attempts: number } | undefined;
        const normalized = normalizeCode(code);
        if (!active || !/^[A-Z2-7]{20}$/.test(normalized) || sha256Hex(normalized) !== active.code_hash) {
          if (active) {
            const failures = active.failed_attempts + 1;
            db.prepare("UPDATE bootstrap_codes SET failed_attempts = ?, revoked_at = CASE WHEN ? >= ? THEN ? ELSE revoked_at END WHERE id = ?").run(failures, failures, CLAIM_MAX_FAILURES, now, active.id);
          }
          auditor.write({ actorType: "user", action: "auth.claim.rejected", target: "instance" });
          // 失败计数必须提交，所以这里返回错误标记而不是在事务里抛出。
          return { error: true as const };
        }
        db.prepare("UPDATE bootstrap_codes SET used_at = ? WHERE id = ?").run(now, active.id);
        const { value, hash } = signer.issue(COOKIE_CLAIM);
        db.prepare("INSERT INTO claim_grants (token_hash, code_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(hash, active.id, now, now + CLAIM_GRANT_TTL_MS);
        auditor.write({ actorType: "user", action: "auth.claim.accepted", target: "instance" });
        return { error: false as const, claimToken: value };
      })();
      if (outcome.error) throw new PlatformError(403, "claim_code_invalid", "认领码不对、已过期或已作废：在目标机重新运行 geek-bot bootstrap-code");
      return { claimToken: outcome.claimToken };
    },

    authenticate(sessionCookie) {
      const hash = signer.verify(COOKIE_SESSION, sessionCookie);
      if (hash === null) return null;
      const now = clock();
      const row = db
        .prepare("SELECT s.id_hash, s.github_id, s.created_at, s.last_seen_at, s.expires_at, s.reauth_at, a.login, a.role FROM sessions s JOIN admins a ON a.github_id = s.github_id WHERE s.id_hash = ?")
        .get(hash) as SessionRow | undefined;
      if (!row) return null;
      if (row.expires_at <= now || now - row.last_seen_at > SESSION_IDLE_MS) {
        db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(hash);
        return null;
      }
      if (now - row.last_seen_at > 30_000) db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?").run(now, hash);
      return Object.freeze({
        idHash: row.id_hash,
        githubId: row.github_id,
        login: row.login,
        role: row.role,
        reauthAt: row.reauth_at,
        expiresAt: Math.min(row.expires_at, now + SESSION_IDLE_MS),
      });
    },

    me(session) {
      const owner = session.role === "owner";
      const reauthUntil = session.reauthAt === null ? null : session.reauthAt + REAUTH_VALID_MS;
      return {
        github_id: session.githubId,
        login: session.login,
        role: session.role,
        is_bot_account: owner && db.prepare("SELECT 1 FROM connections WHERE provider = 'github' AND account_external_id = ?").get(String(session.githubId)) !== undefined,
        reauth_valid_until: reauthUntil !== null && reauthUntil > clock() ? iso(reauthUntil) : null,
        session_expires_at: iso(session.expiresAt),
      };
    },

    logout(session) {
      db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(session.idHash);
      auditor.write({ actorType: "user", actorId: String(session.githubId), action: "auth.logout", target: `admin/${session.githubId}` });
    },

    reauthValid(session) {
      return session.reauthAt !== null && clock() - session.reauthAt <= REAUTH_VALID_MS;
    },

    dropSessions(githubId) {
      db.prepare("DELETE FROM sessions WHERE github_id = ?").run(githubId);
    },

    async startFlow({ purpose, connectionId, session, claimCookie, sourceIp }) {
      limiter.hit(`device:${sourceIp}`, 20, 60_000);
      const { clientId } = oauthClient();
      const now = clock();
      let claimHash: string | null = null;
      let scope = "";
      switch (purpose) {
        case "claim": {
          if (ownerExists()) throw new PlatformError(409, "already_claimed", "实例已经被认领");
          claimHash = signer.verify(COOKIE_CLAIM, claimCookie);
          const grant = claimHash === null ? undefined : db.prepare("SELECT 1 FROM claim_grants WHERE token_hash = ? AND expires_at > ?").get(claimHash, now);
          if (!grant) throw new PlatformError(403, "claim_required", "先在本页输入目标机 CLI 生成的认领码");
          if (connectionId !== undefined) throw new PlatformError(400, "validation_failed", "purpose=claim 不接受 connection_id");
          break;
        }
        case "login":
          if (!ownerExists()) throw new PlatformError(409, "not_claimed", "实例还没有被认领");
          if (connectionId !== undefined) throw new PlatformError(400, "validation_failed", "purpose=login 不接受 connection_id");
          break;
        case "reauth":
          if (!session) throw new PlatformError(401, "unauthenticated", "需要先登录");
          if (connectionId !== undefined) throw new PlatformError(400, "validation_failed", "purpose=reauth 不接受 connection_id");
          break;
        case "connection": {
          if (!session) throw new PlatformError(401, "unauthenticated", "需要先登录");
          if (session.role !== "owner") throw new PlatformError(403, "forbidden", "只有 owner 能绑定代码平台账号");
          if (session.reauthAt === null || now - session.reauthAt > REAUTH_VALID_MS) throw new PlatformError(403, "reauth_required", "绑定代码平台账号前需要在 10 分钟内重新认证");
          if (connectionId === undefined) throw new PlatformError(400, "validation_failed", "purpose=connection 需要 connection_id");
          const connection = db.prepare("SELECT provider, base_url FROM connections WHERE id = ?").get(connectionId) as { provider: string; base_url: string } | undefined;
          if (!connection) throw new PlatformError(404, "not_found", "连接不存在");
          if (connection.provider !== "github") throw new PlatformError(409, "invalid_state", "只有 GitHub 连接经 OAuth 绑定账号");
          if (new URL(config.github.apiUrl).origin !== new URL(connection.base_url).origin) {
            throw new PlatformError(409, "invalid_state", "这个连接的 base_url 与实例配置的 GitHub OAuth App 不属于同一个 GitHub，不能经本实例的 OAuth App 绑定");
          }
          scope = CONNECTION_SCOPE_ALLOWLIST.join(" ");
          break;
        }
      }
      const reply = await github(`${config.github.webUrl}/login/device/code`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId, scope }),
      });
      const body = reply.body;
      if (reply.status !== 200 || typeof body.device_code !== "string" || typeof body.user_code !== "string" || typeof body.verification_uri !== "string") {
        throw new PlatformError(502, "upstream_error", "GitHub 没有返回设备码，核对 OAuth App 是否开启了 device flow");
      }
      const interval = typeof body.interval === "number" && body.interval >= 1 && body.interval <= 60 ? Math.ceil(body.interval) : 5;
      const expiresIn = typeof body.expires_in === "number" && body.expires_in >= 60 && body.expires_in <= 3600 ? Math.floor(body.expires_in) : 900;
      const userCode = body.user_code.slice(0, 32);
      const verificationUri = body.verification_uri.slice(0, 256);
      const flowId = newId("flow");
      const browser = signer.issue(COOKIE_FLOW);
      db.prepare(
        `INSERT INTO oauth_flows (id, purpose, browser_hash, session_hash, claim_hash, connection_id, device_code_ct, user_code, verification_uri, interval_s, next_poll_at, expires_at, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      ).run(flowId, purpose, browser.hash, session?.idHash ?? null, claimHash, purpose === "connection" ? (connectionId ?? null) : null, ctx.vault.seal(body.device_code), userCode, verificationUri, interval, now, now + expiresIn * 1000, now);
      db.prepare("DELETE FROM oauth_flows WHERE expires_at < ?").run(now - 3_600_000);
      return {
        response: { flow_id: flowId, user_code: userCode, verification_uri: verificationUri, expires_in_s: expiresIn, interval_s: interval },
        flowCookie: browser.value,
      };
    },

    async pollFlow(flowId, flowCookie, sourceIp) {
      limiter.hit(`poll:${sourceIp}`, 120, 60_000);
      const browserHash = signer.verify(COOKIE_FLOW, flowCookie);
      const flow = (browserHash === null ? undefined : db.prepare("SELECT * FROM oauth_flows WHERE id = ? AND browser_hash = ?").get(flowId, browserHash)) as FlowRow | undefined;
      if (!flow) throw new PlatformError(404, "not_found", "没有这个授权流程，或它不是本浏览器发起的");
      const now = clock();
      if (flow.status === "done") return { response: { status: "done" }, sessionCookie: null };
      if (flow.status === "denied") return { response: { status: "denied" }, sessionCookie: null };
      if (flow.status === "expired" || flow.status === "failed" || now >= flow.expires_at) {
        if (flow.status === "pending") finish(flow, "expired", null);
        return { response: { status: "expired" }, sessionCookie: null };
      }
      // 每次最多替浏览器向 GitHub 轮询一次，遵守 interval。
      if (now < flow.next_poll_at) return { response: { status: "pending" }, sessionCookie: null };
      const { clientId } = oauthClient();
      db.prepare("UPDATE oauth_flows SET next_poll_at = ? WHERE id = ?").run(now + flow.interval_s * 1000, flow.id);
      const reply = await github(`${config.github.webUrl}/login/oauth/access_token`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId, device_code: ctx.vault.open(flow.device_code_ct), grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
      });
      const error = typeof reply.body.error === "string" ? reply.body.error : null;
      if (error === "authorization_pending") return { response: { status: "pending" }, sessionCookie: null };
      if (error === "slow_down") {
        const next = typeof reply.body.interval === "number" && reply.body.interval <= 120 ? Math.ceil(reply.body.interval) : flow.interval_s + 5;
        db.prepare("UPDATE oauth_flows SET interval_s = ?, next_poll_at = ? WHERE id = ?").run(next, now + next * 1000, flow.id);
        return { response: { status: "slow_down" }, sessionCookie: null };
      }
      if (error === "expired_token") {
        finish(flow, "expired", null);
        return { response: { status: "expired" }, sessionCookie: null };
      }
      if (error === "access_denied") {
        finish(flow, "denied", null);
        return { response: { status: "denied" }, sessionCookie: null };
      }
      const token = typeof reply.body.access_token === "string" ? reply.body.access_token : null;
      if (error !== null || token === null || reply.status !== 200) {
        finish(flow, "failed", null);
        throw new PlatformError(502, "upstream_error", "GitHub 换取令牌失败，重新发起授权");
      }
      ctx.redactor.addKnownSecret(token);

      const user = await github(`${config.github.apiUrl}/user`, { method: "GET", headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" } });
      const githubId = typeof user.body.id === "number" && Number.isSafeInteger(user.body.id) ? user.body.id : null;
      const login = typeof user.body.login === "string" ? user.body.login.slice(0, 100) : null;
      if (user.status !== 200 || githubId === null || login === null) {
        if (flow.purpose !== "connection") await revoke(token, flow.purpose);
        finish(flow, "failed", null);
        throw new PlatformError(502, "upstream_error", "GitHub 没有返回账号身份");
      }
      const scopes = (user.headers.get("x-oauth-scopes") ?? "").split(",").map(part => part.trim()).filter(Boolean);

      switch (flow.purpose) {
        case "claim": {
          await revoke(token, "认领");
          const cookie = db.transaction(() => {
            if (ownerExists()) throw new PlatformError(409, "already_claimed", "实例已经被认领");
            const grant = flow.claim_hash === null ? undefined : db.prepare("SELECT 1 FROM claim_grants WHERE token_hash = ? AND expires_at > ?").get(flow.claim_hash, clock());
            if (!grant) throw new PlatformError(403, "claim_required", "认领码的有效期已过，重新输入认领码");
            db.prepare("INSERT INTO admins (github_id, login, role, invited_by, invited_at) VALUES (?, ?, 'owner', NULL, ?) ON CONFLICT (github_id) DO UPDATE SET role = 'owner', login = excluded.login").run(githubId, login, clock());
            db.prepare("DELETE FROM claim_grants").run();
            db.prepare("UPDATE bootstrap_codes SET revoked_at = ? WHERE revoked_at IS NULL").run(clock());
            finish(flow, "done", githubId);
            auditor.write({ actorType: "user", actorId: String(githubId), action: "auth.claim.completed", target: `admin/${githubId}`, detail: { login } });
            return createSession(githubId);
          })();
          return { response: { status: "done" }, sessionCookie: cookie };
        }
        case "login": {
          await revoke(token, "登录");
          const admin = db.prepare("SELECT * FROM admins WHERE github_id = ?").get(githubId) as AdminRow | undefined;
          if (!admin) {
            finish(flow, "failed", githubId);
            auditor.write({ actorType: "user", actorId: String(githubId), action: "auth.login.rejected", code: "not_an_admin", target: `github/${githubId}` });
            throw new PlatformError(403, "not_an_admin", "这个 GitHub 账号不在本实例的管理员名单里");
          }
          const cookie = db.transaction(() => {
            db.prepare("UPDATE admins SET login = ? WHERE github_id = ?").run(login, githubId);
            finish(flow, "done", githubId);
            auditor.write({ actorType: "user", actorId: String(githubId), action: "auth.login", target: `admin/${githubId}` });
            return createSession(githubId);
          })();
          ctx.bus.publish("session.created", ["alerts"], { github_id: githubId, login });
          return { response: { status: "done" }, sessionCookie: cookie };
        }
        case "reauth": {
          await revoke(token, "重新认证");
          const session = flow.session_hash === null ? undefined : (db.prepare("SELECT github_id FROM sessions WHERE id_hash = ?").get(flow.session_hash) as { github_id: number } | undefined);
          if (!session) {
            finish(flow, "failed", githubId);
            throw new PlatformError(401, "unauthenticated", "发起重新认证的会话已失效，重新登录");
          }
          if (session.github_id !== githubId) {
            finish(flow, "failed", githubId);
            auditor.write({ actorType: "user", actorId: String(session.github_id), action: "auth.reauth.rejected", code: "reauth_mismatch", target: `github/${githubId}` });
            throw new PlatformError(403, "reauth_mismatch", "重新认证用的 GitHub 账号与当前会话不是同一个");
          }
          db.transaction(() => {
            db.prepare("UPDATE sessions SET reauth_at = ? WHERE id_hash = ?").run(clock(), flow.session_hash);
            finish(flow, "done", githubId);
            auditor.write({ actorType: "user", actorId: String(githubId), action: "auth.reauth", target: `admin/${githubId}`, reauth: true });
          })();
          return { response: { status: "done" }, sessionCookie: null };
        }
        case "connection": {
          const allowed = new Set<string>(CONNECTION_SCOPE_ALLOWLIST);
          const extra = scopes.filter(scope => !allowed.has(scope));
          const binder = flow.session_hash === null ? undefined : (db.prepare("SELECT github_id FROM sessions WHERE id_hash = ?").get(flow.session_hash) as { github_id: number } | undefined);
          if (extra.length > 0) {
            await revoke(token, "绑定（scope 超出允许名单）");
            finish(flow, "failed", githubId);
            auditor.write({ actorType: "user", actorId: binder ? String(binder.github_id) : null, action: "connection.bind.rejected", code: "scope_rejected", target: `connection/${flow.connection_id}`, detail: { scopes: extra } });
            throw new PlatformError(403, "scope_rejected", `令牌带有允许名单（repo、read:org）以外的 scope：${extra.join("、")}；在 GitHub 设置里撤销该 OAuth App 的授权后重新绑定`);
          }
          if (!binder) {
            await revoke(token, "绑定（会话失效）");
            finish(flow, "failed", githubId);
            throw new PlatformError(401, "unauthenticated", "发起绑定的会话已失效，重新登录");
          }
          const connection = db.prepare("SELECT id, account_external_id FROM connections WHERE id = ? AND provider = 'github'").get(flow.connection_id) as { id: string; account_external_id: string | null } | undefined;
          if (!connection) {
            await revoke(token, "绑定（连接已删除）");
            finish(flow, "failed", githubId);
            throw new PlatformError(404, "not_found", "连接不存在");
          }
          if (connection.account_external_id !== null && connection.account_external_id !== String(githubId)) {
            await revoke(token, "绑定（换了账号）");
            finish(flow, "failed", githubId);
            throw new PlatformError(409, "bot_account_mismatch", "重新授权必须使用这个连接原来绑定的 GitHub 账号");
          }
          db.transaction(() => {
            const existing = db.prepare("SELECT credentials_ct FROM connection_credentials WHERE connection_id = ?").get(connection.id) as { credentials_ct: string } | undefined;
            const sealed = mergeSealedCredentials(ctx.masterKey, existing?.credentials_ct ?? null, { token });
            db.prepare("INSERT INTO connection_credentials (connection_id, credentials_ct, key_version) VALUES (?, ?, 1) ON CONFLICT (connection_id) DO UPDATE SET credentials_ct = excluded.credentials_ct, key_version = excluded.key_version").run(connection.id, sealed);
            db.prepare("UPDATE connections SET account_name = ?, account_external_id = ?, scopes = ?, status = 'ready', last_error = NULL, revision = revision + 1, updated_at = ? WHERE id = ?").run(login, String(githubId), scopes.join(","), clock(), connection.id);
            finish(flow, "done", githubId);
            auditor.write({ actorType: "user", actorId: String(binder.github_id), action: "connection.bind", target: `connection/${connection.id}`, detail: { account: login, scopes }, reauth: true });
          })();
          ctx.bus.publish("connection.updated", ["connections"], { id: connection.id });
          return { response: { status: "done" }, sessionCookie: null };
        }
      }
    },
  };
}
