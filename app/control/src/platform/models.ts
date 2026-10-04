/**
 * 模型目录与模型池（ADR-0006，S-02）。
 *
 * - 目录只来自部署者挂载的只读 catalog 文件（GEEK_BOT_MODEL_CATALOG_FILE），不建模型表；按文件修改时间缓存。
 * - catalog 的 provider.baseUrl 必须等于 GEEK_BOT_MODEL_GATEWAY_URL，否则拒绝加载并告警：网关地址只取部署配置。
 * - 模型池按任务类型存在 settings（键 model_pool.<kind>），版本号在 revisions（ETag / If-Match）；1 到 8 项，
 *   模型必须在目录里，档位必须是该模型的 efforts 之一（没有 efforts 的模型只接受 off）。
 */
import { readFileSync, statSync } from "node:fs";
import { TASK_KINDS, type CatalogModel, type ModelPool, type ModelPoolEntry, type ModelPoolsResponse, type TaskKind } from "@geek-bot/protocol";
import type { SessionInfo } from "./auth.js";
import type { PlatformContext } from "./context.js";
import { PlatformError } from "./http.js";

export const MAX_POOL_ENTRIES = 8;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;

export interface Catalog {
  readonly models: readonly CatalogModel[];
  readonly error: string | null;
}

export interface ModelsService {
  catalog(): Catalog;
  pools(): ModelPoolsResponse;
  pool(kind: TaskKind): ModelPool;
  /** 派发时用的池：只保留仍在目录里的项；没有可用项时抛 409。 */
  effectivePool(kind: TaskKind, override?: readonly ModelPoolEntry[]): ModelPoolEntry[];
  updatePool(actor: SessionInfo, kind: TaskKind, entries: readonly ModelPoolEntry[], ifMatch: (revision: number) => void): ModelPool;
}

/** 按 ADR-0006 的形状校验 catalog：{version, generatedAt, provider:{baseUrl, apiStyle:"openai"}, models:[{id, name, efforts?}]}。 */
function parseCatalog(text: string, gatewayUrl: string | null): CatalogModel[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("catalog 文件不是合法的 JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("catalog 顶层必须是对象");
  const provider = "provider" in value ? value.provider : undefined;
  if (provider === null || typeof provider !== "object" || Array.isArray(provider)) throw new Error("catalog 缺少 provider");
  const baseUrl = "baseUrl" in provider ? provider.baseUrl : undefined;
  const apiStyle = "apiStyle" in provider ? provider.apiStyle : undefined;
  if (typeof baseUrl !== "string") throw new Error("catalog 的 provider.baseUrl 不是字符串");
  if (apiStyle !== "openai") throw new Error("catalog 的 provider.apiStyle 只支持 openai");
  if (gatewayUrl === null) throw new Error("没有配置 GEEK_BOT_MODEL_GATEWAY_URL，拒绝加载 catalog");
  // gatewayUrl 已在配置里去掉结尾的 /；catalog 侧同样去掉再比较。
  if (baseUrl.trim().replace(/\/+$/, "") !== gatewayUrl) throw new Error("catalog 的 provider.baseUrl 与 GEEK_BOT_MODEL_GATEWAY_URL 不一致，拒绝加载");
  const models = "models" in value ? value.models : undefined;
  if (!Array.isArray(models) || models.length > 500) throw new Error("catalog 的 models 必须是最多 500 项的数组");
  const seen = new Set<string>();
  const result: CatalogModel[] = [];
  for (const model of models as unknown[]) {
    if (model === null || typeof model !== "object" || Array.isArray(model)) throw new Error("catalog 的模型项必须是对象");
    const id = "id" in model ? model.id : undefined;
    const name = "name" in model ? model.name : undefined;
    const efforts = "efforts" in model ? model.efforts : undefined;
    if (typeof id !== "string" || !/^[A-Za-z0-9._:/@-]{1,200}$/.test(id)) throw new Error("catalog 里有不合法的模型 id");
    if (seen.has(id)) throw new Error(`catalog 里模型 id 重复：${id}`);
    seen.add(id);
    if (efforts !== undefined && (!Array.isArray(efforts) || efforts.length > 16 || !efforts.every(item => typeof item === "string" && /^[a-z0-9_-]{1,32}$/.test(item)))) {
      throw new Error(`catalog 里模型 ${id} 的 efforts 不合法`);
    }
    result.push({ id, name: typeof name === "string" ? name.slice(0, 200) : id, efforts: efforts === undefined || efforts.length === 0 ? ["off"] : [...(efforts as string[])] });
  }
  return result;
}

export function createModelsService(ctx: PlatformContext): ModelsService {
  const { db, clock, config, alerts, auditor } = ctx;
  let cached: { mtimeMs: number; size: number; catalog: Catalog } | null = null;

  function catalog(): Catalog {
    const file = config.model.catalogFile;
    if (file === null) return { models: [], error: "没有配置 GEEK_BOT_MODEL_CATALOG_FILE" };
    let stat;
    try {
      stat = statSync(file);
    } catch {
      return { models: [], error: "catalog 文件读不到：核对 GEEK_BOT_MODEL_CATALOG_FILE 的挂载" };
    }
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.catalog;
    let result: Catalog;
    try {
      if (stat.size > MAX_CATALOG_BYTES) throw new Error("catalog 文件超过 4 MiB");
      result = { models: parseCatalog(readFileSync(file, "utf8"), config.model.gatewayUrl), error: null };
      alerts.resolve("model_catalog_invalid");
    } catch (error) {
      const message = (error as Error).message;
      result = { models: [], error: message };
      alerts.raise({ kind: "model_catalog_invalid", severity: "warning", subject: "catalog", message });
    }
    cached = { mtimeMs: stat.mtimeMs, size: stat.size, catalog: result };
    return result;
  }

  function pool(kind: TaskKind): ModelPool {
    const row = db.prepare("SELECT value_json FROM settings WHERE key = ?").get(`model_pool.${kind}`) as { value_json: string } | undefined;
    const revision = db.prepare("SELECT revision FROM revisions WHERE scope = ?").get(`model_pool.${kind}`) as { revision: number } | undefined;
    const entries = row ? (JSON.parse(row.value_json) as ModelPoolEntry[]) : [];
    return { kind, entries: entries.map(entry => ({ model: entry.model, effort: entry.effort })), revision: revision?.revision ?? 0 };
  }

  function validate(entries: readonly ModelPoolEntry[], models: readonly CatalogModel[]): void {
    const byId = new Map(models.map(model => [model.id, model]));
    for (const entry of entries) {
      const model = byId.get(entry.model);
      if (!model) throw new PlatformError(422, "model_not_in_catalog", `模型不在 catalog 里：${entry.model}`);
      if (!model.efforts.includes(entry.effort)) throw new PlatformError(422, "effort_not_supported", `模型 ${entry.model} 不支持档位 ${entry.effort}`);
    }
  }

  return {
    catalog,
    pool,
    pools() {
      const current = catalog();
      return { catalog: { models: current.models, error: current.error }, pools: TASK_KINDS.map(kind => pool(kind)) };
    },
    effectivePool(kind, override) {
      const current = catalog();
      if (current.error !== null) throw new PlatformError(409, "catalog_unavailable", `模型目录不可用：${current.error}`);
      if (override !== undefined) {
        validate(override, current.models);
        return override.map(entry => ({ model: entry.model, effort: entry.effort }));
      }
      const byId = new Map(current.models.map(model => [model.id, model]));
      const entries = pool(kind).entries.filter(entry => byId.get(entry.model)?.efforts.includes(entry.effort) === true);
      if (entries.length === 0) throw new PlatformError(409, "model_pool_empty", `任务类型 ${kind} 的模型池没有可用的模型：先在「模型池」里配置`);
      return entries;
    },
    updatePool(actor, kind, entries, ifMatch) {
      const current = catalog();
      if (current.error !== null) throw new PlatformError(409, "catalog_unavailable", `模型目录不可用：${current.error}`);
      if (entries.length < 1 || entries.length > MAX_POOL_ENTRIES) throw new PlatformError(400, "validation_failed", "模型池必须有 1 到 8 项");
      validate(entries, current.models);
      return db.transaction(() => {
        ifMatch(pool(kind).revision);
        const now = clock();
        const value = JSON.stringify(entries.map(entry => ({ model: entry.model, effort: entry.effort })));
        db.prepare("INSERT INTO settings (key, value_json, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at").run(`model_pool.${kind}`, value, actor.githubId, now);
        db.prepare("INSERT INTO revisions (scope, revision, updated_at) VALUES (?, 1, ?) ON CONFLICT (scope) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at").run(`model_pool.${kind}`, now);
        auditor.write({ actorType: "user", actorId: String(actor.githubId), action: "model_pool.update", target: `model_pool/${kind}`, detail: { entries } });
        return pool(kind);
      })();
    },
  };
}
