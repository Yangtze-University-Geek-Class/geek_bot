import type { BundleFile, Capability, ItemRecord, ProjectRecord, TaskBundle, TaskKind } from "@geek-bot/protocol";
import { ApiTransport, boundedBody, identifier, integer, object, string, timestamp } from "./http.js";
import { isRulePath, makeTaskBundle, MAX_FILE_BYTES, permittedSnapshotPath } from "./bundle.js";
import { ConnectorError, type CodeConnector, type ConnectorIdentity, type ConnectorOptions, type DiscoveredItem, type DiscoveredProject } from "./types.js";

export class GitHubConnector implements CodeConnector {
  readonly provider = "github" as const;
  readonly api: ApiTransport;
  private identityPromise: Promise<ConnectorIdentity> | null = null;
  private scopes: readonly string[] = [];
  private accountExternalId: string | null = null;
  constructor(options: ConnectorOptions) {
    options.redactor?.addKnownSecret(options.token);
    this.api = new ApiTransport(options.baseUrl, { Authorization: `Bearer ${options.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }, options.fetchImpl);
  }
  identity(): Promise<ConnectorIdentity> {
    if (!this.identityPromise) this.identityPromise = this.loadIdentity();
    return this.identityPromise;
  }
  private async loadIdentity(): Promise<ConnectorIdentity> {
    const { data, response } = await this.api.json("user");
    const user = object(data);
    this.scopes = (response.headers.get("x-oauth-scopes") ?? "").split(/[\s,]+/).filter(Boolean);
    this.accountExternalId = identifier(user.id);
    return { account_external_id: this.accountExternalId, account_name: string(user.login), scopes: this.scopes };
  }
  capabilities(): readonly Capability[] { return this.scopes.includes("repo") ? ["monitor", "review", "triage", "followup", "fix", "rework"] : ["monitor"]; }
  private normalizeProject(raw: Record<string, unknown>): DiscoveredProject {
    const permissions = raw.permissions && typeof raw.permissions === "object" ? object(raw.permissions) : {};
    const permission = permissions.admin ? "admin" : permissions.maintain ? "maintain" : permissions.push ? "write" : permissions.triage ? "triage" : permissions.pull || raw.private === false ? "read" : "none";
    const capabilities: Capability[] = permission === "none" ? [] : ["monitor"];
    if (!raw.archived && this.scopes.includes("repo") && permission !== "none") {
      capabilities.push("review", "triage", "followup");
      if (["write", "maintain", "admin"].includes(permission)) capabilities.push("fix", "rework");
    }
    return { external_id: identifier(raw.id), name: string(raw.name), path: string(raw.full_name), url: string(raw.html_url), default_branch: string(raw.default_branch), private: raw.private !== false, archived: raw.archived === true, permission, capabilities };
  }
  async discoverProjects(): Promise<readonly DiscoveredProject[]> {
    await this.identity();
    const rows = await this.api.pages("user/repos?affiliation=owner,collaborator,organization_member&per_page=100&sort=full_name");
    return rows.map(row => this.normalizeProject(row));
  }
  private repoPath(project: ProjectRecord): string {
    const parts = project.path.split("/");
    if (parts.length !== 2 || parts.some(part => !part || !/^[A-Za-z0-9_.-]+$/.test(part))) throw new ConnectorError("project_invalid", "GitHub 项目路径不合法", 422);
    return `repos/${parts.map(encodeURIComponent).join("/")}`;
  }
  async project(project: ProjectRecord): Promise<DiscoveredProject> {
    await this.identity();
    return this.normalizeProject(object(await this.api.get(this.repoPath(project))));
  }
  private normalizeItem(raw: Record<string, unknown>, kind: "issue" | "change"): DiscoveredItem {
    const author = raw.user && typeof raw.user === "object" ? object(raw.user) : {};
    const head = raw.head && typeof raw.head === "object" ? object(raw.head) : {};
    const base = raw.base && typeof raw.base === "object" ? object(raw.base) : {};
    const number = integer(raw.number);
    if (number < 1) throw new ConnectorError("upstream_invalid", "GitHub 条目编号不正确");
    return {
      external_id: identifier(raw.id), origin: kind === "change" ? "pull_request" : "issue", kind, number,
      title: string(raw.title), body: string(raw.body), url: string(raw.html_url), state: raw.merged_at ? "merged" : string(raw.state), author: string(author.login),
      head_sha: kind === "change" ? string(head.sha) || null : null, base_sha: kind === "change" ? string(base.sha) || null : null,
      head_ref: string(head.ref), base_ref: string(base.ref), updated_at: timestamp(raw.updated_at ?? raw.created_at),
      bot_authored: kind === "change" && author.id !== undefined && identifier(author.id) === this.accountExternalId,
      labels: Array.isArray(raw.labels) ? raw.labels.map(label => typeof label === "string" ? label : string(object(label).name)) : [],
      assignees: Array.isArray(raw.assignees) ? raw.assignees.map(person => string(object(person).login)) : [],
    };
  }
  async listItems(project: ProjectRecord): Promise<readonly DiscoveredItem[]> {
    await this.identity();
    const repo = this.repoPath(project);
    const [issues, changes] = await Promise.all([this.api.pages(`${repo}/issues?state=all&sort=updated&per_page=100`), this.api.pages(`${repo}/pulls?state=all&sort=updated&per_page=100`)]);
    return [...issues.filter(row => !row.pull_request).map(row => this.normalizeItem(row, "issue")), ...changes.map(row => this.normalizeItem(row, "change"))];
  }
  async item(project: ProjectRecord, item: ItemRecord): Promise<DiscoveredItem> {
    await this.identity();
    return this.normalizeItem(object(await this.api.get(`${this.repoPath(project)}/${item.kind === "change" ? "pulls" : "issues"}/${item.number}`)), item.kind);
  }
  private async commit(repo: string, ref: string): Promise<string> {
    const row = object(await this.api.get(`${repo}/commits/${encodeURIComponent(ref)}`));
    const sha = string(row.sha);
    if (!/^[0-9a-f]{40,64}$/i.test(sha)) throw new ConnectorError("upstream_invalid", "GitHub 返回的提交标识不正确");
    return sha;
  }
  private async snapshot(repo: string, sha: string, rulesOnly: boolean): Promise<readonly BundleFile[]> {
    const tree = object(await this.api.get(`${repo}/git/trees/${sha}?recursive=1`));
    if (tree.truncated === true || !Array.isArray(tree.tree)) throw new ConnectorError("bundle_incomplete", "GitHub 无法提供完整的仓库树，未生成任务包", 422);
    const files: BundleFile[] = [];
    for (const value of tree.tree) {
      const entry = object(value);
      const path = string(entry.path);
      if (!permittedSnapshotPath(path) || (rulesOnly && !isRulePath(path)) || entry.type === "tree") continue;
      if (entry.type !== "blob" || !["100644", "100755"].includes(string(entry.mode))) throw new ConnectorError("bundle_entry_rejected", "任务快照不支持符号链接或子模块", 422);
      if (integer(entry.size) > MAX_FILE_BYTES) throw new ConnectorError("bundle_too_large", "仓库文件超过任务允许大小", 422);
      const blob = object(await this.api.get(`${repo}/git/blobs/${identifier(entry.sha)}`));
      const content = string(blob.content).replace(/\s/g, "");
      if (blob.encoding !== "base64" || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) throw new ConnectorError("upstream_invalid", "GitHub 文件编码不正确");
      files.push({ path, content, encoding: "base64" });
    }
    return files;
  }
  async getBundle(project: ProjectRecord, item: ItemRecord | null, kind: TaskKind): Promise<TaskBundle> {
    const targetRepo = this.repoPath(project);
    let headRepo = targetRepo;
    let headSha: string;
    let baseSha: string;
    let diff = "";
    if (item?.kind === "change") {
      const change = object(await this.api.get(`${targetRepo}/pulls/${item.number}`));
      const head = object(change.head);
      const base = object(change.base);
      const headRepository = object(head.repo);
      const path = string(headRepository.full_name);
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(path)) throw new ConnectorError("change_unavailable", "变更来源仓库不可用", 409);
      headRepo = `repos/${path.split("/").map(encodeURIComponent).join("/")}`;
      headSha = string(head.sha);
      baseSha = string(base.sha);
      if (!/^[0-9a-f]{40,64}$/i.test(headSha) || !/^[0-9a-f]{40,64}$/i.test(baseSha)) throw new ConnectorError("change_unavailable", "变更提交尚未就绪", 409);
      const response = await this.api.response(`${targetRepo}/pulls/${item.number}`, { headers: { Accept: "application/vnd.github.v3.diff" } });
      diff = (await boundedBody(response, 8 * 1024 * 1024)).toString("utf8");
    } else {
      if (!project.default_branch) throw new ConnectorError("project_empty", "项目还没有可执行的默认分支", 409);
      headSha = baseSha = await this.commit(targetRepo, project.default_branch);
    }
    const headFiles = await this.snapshot(headRepo, headSha, false);
    const baseFiles = headRepo === targetRepo && headSha === baseSha ? headFiles : await this.snapshot(targetRepo, baseSha, true);
    return makeTaskBundle(headFiles, baseFiles, diff, { project_id: project.id, provider: "github", kind, head_sha: headSha, base_sha: baseSha, default_branch: project.default_branch });
  }
}
