import type { BundleFile, Capability, ItemRecord, ProjectRecord, TaskBundle, TaskKind } from "@geek-bot/protocol";
import { ApiTransport, boundedBody, identifier, integer, object, publicBaseUrl, string, timestamp } from "./http.js";
import { isRulePath, makeTaskBundle, MAX_FILE_BYTES, permittedSnapshotPath } from "./bundle.js";
import { ConnectorError, type CodeConnector, type ConnectorIdentity, type ConnectorOptions, type DiscoveredItem, type DiscoveredProject } from "./types.js";

export class GitLabConnector implements CodeConnector {
  readonly provider = "gitlab" as const;
  readonly api: ApiTransport;
  private readonly web: ApiTransport;
  private readonly token: string;
  private identityPromise: Promise<ConnectorIdentity> | null = null;
  private scopes: readonly string[] = [];
  private accountExternalId: string | null = null;
  constructor(options: ConnectorOptions) {
    this.token = options.token;
    options.redactor?.addKnownSecret(options.token);
    const base = publicBaseUrl(options.baseUrl);
    if (!/\/api\/v4\/$/.test(base.pathname)) base.pathname += "api/v4/";
    const web = new URL(base);
    web.pathname = web.pathname.replace(/api\/v4\/$/, "");
    const headers = { Authorization: `Bearer ${options.token}`, Accept: "application/json" };
    this.api = new ApiTransport(base.href, headers, options.fetchImpl);
    this.web = new ApiTransport(web.href, headers, options.fetchImpl);
  }
  identity(): Promise<ConnectorIdentity> {
    if (!this.identityPromise) this.identityPromise = this.loadIdentity();
    return this.identityPromise;
  }
  private async loadIdentity(): Promise<ConnectorIdentity> {
    const user = object(await this.api.get("user"));
    // 项目角色不等于令牌权限：read_api 不能因为项目是 Developer 就获得发布能力。
    try {
      const info = object(await (this.token.startsWith("glpat-") ? this.api.get("personal_access_tokens/self") : this.web.get("oauth/token/info")));
      this.scopes = Array.isArray(info.scopes) ? info.scopes.filter((scope): scope is string => typeof scope === "string") : [];
      if (info.revoked === true || info.active === false) throw new ConnectorError("connection_revoked", "GitLab 令牌已失效", 401);
    } catch (error) {
      if (error instanceof ConnectorError && error.code === "connection_revoked") throw error;
      if (!(error instanceof ConnectorError) || ![401, 403, 404].includes(error.statusCode)) throw error;
      // 老版本无法自省令牌时只允许监控，不能猜测写权限。
      this.scopes = [];
    }
    this.accountExternalId = identifier(user.id);
    return { account_external_id: this.accountExternalId, account_name: string(user.username), scopes: this.scopes };
  }
  capabilities(): readonly Capability[] { return this.scopes.includes("api") ? ["monitor", "review", "triage", "followup", "fix", "rework"] : ["monitor"]; }
  private normalizeProject(raw: Record<string, unknown>): DiscoveredProject {
    const permissions = raw.permissions && typeof raw.permissions === "object" ? object(raw.permissions) : {};
    const projectAccess = permissions.project_access && typeof permissions.project_access === "object" ? object(permissions.project_access) : {};
    const groupAccess = permissions.group_access && typeof permissions.group_access === "object" ? object(permissions.group_access) : {};
    const level = Math.max(integer(projectAccess.access_level), integer(groupAccess.access_level));
    const permission = level >= 50 ? "owner" : level >= 40 ? "maintainer" : level >= 30 ? "developer" : level >= 20 ? "reporter" : level >= 10 ? "guest" : "minimal";
    const capabilities: Capability[] = ["monitor"];
    const repositoryReadable = raw.repository_access_level !== "disabled" && (level >= 20 || raw.visibility === "public");
    const issuesEnabled = raw.issues_access_level !== "disabled" && raw.issues_enabled !== false;
    const changesEnabled = raw.merge_requests_access_level !== "disabled" && raw.merge_requests_enabled !== false;
    if (!raw.archived && this.scopes.includes("api")) {
      if (issuesEnabled && level >= 10) capabilities.push("triage", "followup");
      if (repositoryReadable && changesEnabled) capabilities.push("review");
      if (repositoryReadable && changesEnabled && level >= 30 && raw.can_create_merge_request_in !== false) capabilities.push("fix", "rework");
    }
    return { external_id: identifier(raw.id), name: string(raw.name), path: string(raw.path_with_namespace), url: string(raw.web_url), default_branch: string(raw.default_branch), private: raw.visibility !== "public", archived: raw.archived === true, permission, capabilities };
  }
  async discoverProjects(): Promise<readonly DiscoveredProject[]> {
    await this.identity();
    const rows = await this.api.pages("projects?membership=true&per_page=100&order_by=id&sort=asc");
    return rows.map(row => this.normalizeProject(row));
  }
  private projectPath(project: ProjectRecord): string { return `projects/${encodeURIComponent(project.external_id)}`; }
  async project(project: ProjectRecord): Promise<DiscoveredProject> {
    await this.identity();
    return this.normalizeProject(object(await this.api.get(this.projectPath(project))));
  }
  private normalizeItem(raw: Record<string, unknown>, kind: "issue" | "change"): DiscoveredItem {
    const author = raw.author && typeof raw.author === "object" ? object(raw.author) : {};
    const refs = raw.diff_refs && typeof raw.diff_refs === "object" ? object(raw.diff_refs) : {};
    const number = integer(raw.iid);
    if (number < 1) throw new ConnectorError("upstream_invalid", "GitLab 条目编号不正确");
    return {
      external_id: identifier(raw.id), origin: kind === "change" ? "merge_request" : "issue", kind, number,
      title: string(raw.title), body: string(raw.description), url: string(raw.web_url), state: string(raw.state), author: string(author.username),
      head_sha: kind === "change" ? string(refs.head_sha, string(raw.sha)) || null : null, base_sha: kind === "change" ? string(refs.base_sha) || null : null,
      head_ref: string(raw.source_branch), base_ref: string(raw.target_branch), updated_at: timestamp(raw.updated_at ?? raw.created_at),
      bot_authored: kind === "change" && author.id !== undefined && identifier(author.id) === this.accountExternalId,
      labels: Array.isArray(raw.labels) ? raw.labels.filter((label): label is string => typeof label === "string") : [],
      assignees: Array.isArray(raw.assignees) ? raw.assignees.map(person => string(object(person).username)) : [],
    };
  }
  async listItems(project: ProjectRecord): Promise<readonly DiscoveredItem[]> {
    await this.identity();
    const prefix = this.projectPath(project);
    const [issues, changes] = await Promise.all([this.api.pages(`${prefix}/issues?state=all&per_page=100&order_by=updated_at`), this.api.pages(`${prefix}/merge_requests?state=all&per_page=100&order_by=updated_at`)]);
    const items: DiscoveredItem[] = issues.map(row => this.normalizeItem(row, "issue"));
    // 列表上的diff_refs可能缺失；详情提供冻结任务所需的准确base/head。
    for (const change of changes) items.push(this.normalizeItem(object(await this.api.get(`${prefix}/merge_requests/${integer(change.iid)}`)), "change"));
    return items;
  }
  async item(project: ProjectRecord, item: ItemRecord): Promise<DiscoveredItem> {
    await this.identity();
    return this.normalizeItem(object(await this.api.get(`${this.projectPath(project)}/${item.kind === "change" ? "merge_requests" : "issues"}/${item.number}`)), item.kind);
  }
  private async commit(projectId: string, ref: string): Promise<string> {
    const row = object(await this.api.get(`projects/${encodeURIComponent(projectId)}/repository/commits/${encodeURIComponent(ref)}`));
    const sha = string(row.id);
    if (!/^[0-9a-f]{40,64}$/i.test(sha)) throw new ConnectorError("upstream_invalid", "GitLab 返回的提交标识不正确");
    return sha;
  }
  private async snapshot(projectId: string, sha: string, rulesOnly: boolean): Promise<readonly BundleFile[]> {
    const prefix = `projects/${encodeURIComponent(projectId)}/repository`;
    const entries = await this.api.pages(`${prefix}/tree?recursive=true&ref=${encodeURIComponent(sha)}&per_page=100`);
    const files: BundleFile[] = [];
    for (const entry of entries) {
      const path = string(entry.path);
      if (!permittedSnapshotPath(path) || (rulesOnly && !isRulePath(path)) || entry.type === "tree") continue;
      if (entry.type !== "blob" || !["100644", "100755"].includes(string(entry.mode))) throw new ConnectorError("bundle_entry_rejected", "任务快照不支持符号链接或子模块", 422);
      const response = await this.api.response(`${prefix}/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(sha)}`);
      const bytes = await boundedBody(response, MAX_FILE_BYTES);
      files.push({ path, content: bytes.toString("base64"), encoding: "base64" });
    }
    return files;
  }
  async getBundle(project: ProjectRecord, item: ItemRecord | null, kind: TaskKind): Promise<TaskBundle> {
    let headProject = project.external_id;
    let headSha: string;
    let baseSha: string;
    let diff = "";
    if (item?.kind === "change") {
      const raw = object(await this.api.get(`${this.projectPath(project)}/merge_requests/${item.number}`));
      const refs = object(raw.diff_refs);
      headProject = identifier(raw.source_project_id);
      headSha = string(refs.head_sha);
      baseSha = await this.commit(project.external_id, string(raw.target_branch, project.default_branch));
      if (!/^[0-9a-f]{40,64}$/i.test(headSha) || !/^[0-9a-f]{40,64}$/i.test(baseSha)) throw new ConnectorError("change_unavailable", "合并请求的 diff 尚未就绪", 409);
      const response = await this.api.response(`${this.projectPath(project)}/merge_requests/${item.number}/raw_diffs`);
      diff = (await boundedBody(response, 8 * 1024 * 1024)).toString("utf8");
    } else {
      if (!project.default_branch) throw new ConnectorError("project_empty", "项目还没有可执行的默认分支", 409);
      headSha = baseSha = await this.commit(project.external_id, project.default_branch);
    }
    const headFiles = await this.snapshot(headProject, headSha, false);
    const baseFiles = headProject === project.external_id && headSha === baseSha ? headFiles : await this.snapshot(project.external_id, baseSha, true);
    return makeTaskBundle(headFiles, baseFiles, diff, { project_id: project.id, provider: "gitlab", kind, head_sha: headSha, base_sha: baseSha, default_branch: project.default_branch });
  }
}
