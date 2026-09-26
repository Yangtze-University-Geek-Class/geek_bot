/**
 * 样板数据：全部虚构，只用于界面开发与回归（DESIGN「硬性规则」：样板数据要在界面上标明）。
 * 账号、组织、仓库一律是占位写法，不对应任何真实的 GitHub 账号或仓库。
 */
import type { ApiList, MeResponse, ReleaseInfo } from "@geek-bot/protocol";

export const SAMPLE_RELEASE: ReleaseInfo = {
  display: "本地开发 · 未发布",
  version: "0.1.0",
  commit: "0000000000000000000000000000000000000000",
};

export const SAMPLE_ME: MeResponse = {
  github_id: 1000001,
  login: "example-owner",
  role: "owner",
  is_bot_account: true,
  reauth_valid_until: null,
  session_expires_at: "2026-01-01T12:00:00Z",
};

const list = <T>(items: T[]): ApiList<T> => ({ items, next_cursor: null });

/** 各页面数据端点的样板响应。列表端点在 empty 场景下返回空列表，其它端点照常返回。 */
export const SAMPLE_RESOURCES: Readonly<Record<string, unknown>> = {
  "/api/v1/overview": {
    nodes: { total: 1, active: 1 },
    slots: { sandbox: { used: 0, total: 2 }, vm: { used: 0, total: 1 } },
    tasks: { queued: 2, running: 1, failed: 0 },
  },
  "/api/v1/tasks": list([
    { task_id: "task-sample-1", kind: "review", channel: "pr", state: "queued", repo: "example-org/sample-repo", number: 12 },
    { task_id: "task-sample-2", kind: "triage", channel: "issue", state: "running", repo: "example-org/sample-repo", number: 7 },
  ]),
  "/api/v1/items": list([
    { repo: "example-org/sample-repo", number: 3, type: "issue", title: "样板条目：已分给人", reason: "assigned_to_human" },
  ]),
  "/api/v1/repos": list([
    { repo_id: "repo-sample-1", full_name: "example-org/sample-repo", private: false, permission: "write", state: "active" },
    { repo_id: "repo-sample-2", full_name: "example-owner/sample-notes", private: true, permission: "read", state: "active" },
  ]),
  "/api/v1/nodes": list([
    { node_id: "node-sample-1", name: "sample-node", state: "active", slots: { sandbox: 2, vm: 1 } },
  ]),
  "/api/v1/model-pools": {
    review: [{ model_id: "example-model", effort: "medium", in_catalog: true }],
  },
  "/api/v1/bot-account": { bound: true, login: "example-owner", token_status: "valid", writes_paused: false },
  "/api/v1/settings": { items: [{ name: "poll.interval_s", value: 60, source: "default", read_only: false }], next_cursor: null },
  "/api/v1/alerts": list([]),
  "/api/v1/audit": list([
    { id: "audit-sample-1", actor: "system", action: "instance.started", target: "control", note: "样板记录" },
  ]),
};
