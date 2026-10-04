import type { Capability, CodeProvider, ConnectionCredentials, ConnectionRecord, ItemRecord, JsonValue, ProjectRecord, TaskBundle, TaskKind } from "@geek-bot/protocol";
import type { Db } from "../db/database.js";
import type { Redactor } from "../log/redact.js";

export type FetchLike = typeof globalThis.fetch;
export class ConnectorError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 502) { super(message); this.name = "ConnectorError"; }
}
export interface ConnectorIdentity { readonly account_external_id: string; readonly account_name: string; readonly scopes: readonly string[] }
export type DiscoveredProject = Pick<ProjectRecord, "external_id" | "name" | "path" | "url" | "default_branch" | "private" | "archived" | "permission" | "capabilities">;
export type DiscoveredItem = Omit<ItemRecord, "id" | "project_id" | "active_task"> & { readonly origin: string; readonly head_ref?: string; readonly base_ref?: string; readonly labels?: readonly string[]; readonly assignees?: readonly string[] };
export interface CodeConnector {
  readonly provider: CodeProvider;
  identity(): Promise<ConnectorIdentity>;
  discoverProjects(): Promise<readonly DiscoveredProject[]>;
  project(project: ProjectRecord): Promise<DiscoveredProject>;
  listItems(project: ProjectRecord): Promise<readonly DiscoveredItem[]>;
  item(project: ProjectRecord, item: ItemRecord): Promise<DiscoveredItem>;
  getBundle(project: ProjectRecord, item: ItemRecord | null, kind: TaskKind): Promise<TaskBundle>;
  capabilities(): readonly Capability[];
}
export interface ConnectorOptions { readonly baseUrl: string; readonly token: string; readonly fetchImpl?: FetchLike; readonly redactor?: Redactor }
export interface StoredConnectorOptions { readonly db: Db; readonly masterKey: Buffer; readonly connection: ConnectionRecord; readonly fetchImpl?: FetchLike; readonly redactor?: Redactor }
export interface VerifiedIntake {
  readonly event_id: string;
  readonly source_ref: string;
  readonly title: string;
  readonly body: string;
  readonly project_hint?: string;
}
export type IntakeVerification = { readonly type: "challenge"; readonly response: JsonValue } | ({ readonly type: "event" } & VerifiedIntake) | { readonly type: "ignored" };
export interface ImConnector {
  verifyEvent(headers: Readonly<Record<string, string | string[] | undefined>>, body: unknown, rawBody: Buffer, now?: number): IntakeVerification;
  /** 仅由 publisher 调用；入站 HTTP handler 不得直接写外部渠道。 */
  sendMessage(target: string, text: string, idempotencyKey: string): Promise<string>;
}
export interface ImConnectorOptions { readonly baseUrl: string; readonly credentials: ConnectionCredentials; readonly fetchImpl?: FetchLike; readonly redactor?: Redactor }
