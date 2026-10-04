/**
 * 代码平台条目 → 任务的策略（#34）：开关映射、条目类型与任务类型的对应、自动入队的资格与去重版本。
 *
 * - 开关：review_enabled、triage_enabled（受理与跟进共用）、fix_enabled、rework_enabled，新项目全部关闭；
 *   条目派发与自动入队都要求对应开关打开、平台权限（capabilities）包含该任务类型。
 * - 条目类型：change 只能 review（不是机器人发起的）或 rework（机器人发起的）；issue 只能 triage、followup、fix。
 *   「机器人发起」只认同步时适配器按账号数字 id 判定的 bot_authored，不比较用户名。
 * - 自动入队只在项目启用、未归档、未消失、连接可用、实际写入模式（项目设置与实例上限取更严）不是 off 时进行，
 *   由系统身份（审计 actor_type=system）创建，不冒充任何管理员：
 *   - 别人发起、开着的 change：review，版本是 head sha；新 head 由同步作废旧任务后重新审查；
 *     已合并的 change 在补审时限（72 小时）内照样补审，超过时限的不补；
 *   - 开着的 issue：triage，版本是标题与正文的哈希；带 bot:manual 标签或分配给机器人以外的人不接；
 *     只分配给机器人账号的 issue 优先入队。机器人账号取连接上由实时身份（GET user，数字 id 已核对）写入的
 *     account_name，与平台官方的 assignee login 字段比较；连接没有核对过的账号时，有 assignee 的 issue 一律不接；
 *   - 条目最后一次变动后过了静默窗口才入队；开着的条目不论多久没更新都会处理（每轮有上限）；
 *   - 同一条目、同一类型、同一版本只入队一次（不论那个任务后来成功、失败还是被取消），条目有活跃任务时不入队；
 *   - fix、rework、followup 不自动入队：现有同步数据里没有「成员反馈」「人已回复」这类依据，只能由管理员按条目派发。
 */
import type { ProjectRecord, TaskKind, WriteMode } from "@geek-bot/protocol";
import type { PlatformContext } from "./context.js";
import { parseJsonColumn, PlatformError, sha256Hex } from "./http.js";
import { CONNECTION_SELECT, projectRecord, type ConnectionRow, type ItemRow, type ProjectRow } from "./records.js";

export type SwitchField = "review_enabled" | "triage_enabled" | "fix_enabled" | "rework_enabled";
export const KIND_SWITCH: Readonly<Record<TaskKind, SwitchField>> = {
  review: "review_enabled",
  triage: "triage_enabled",
  followup: "triage_enabled",
  fix: "fix_enabled",
  rework: "rework_enabled",
};
export const SWITCH_FIELDS: readonly SwitchField[] = ["review_enabled", "triage_enabled", "fix_enabled", "rework_enabled"];
export const ITEM_KINDS: Readonly<Record<ItemRow["kind"], readonly TaskKind[]>> = { change: ["review", "rework"], issue: ["triage", "followup", "fix"] };

/** 静默窗口（ARCHITECTURE「轮询与入队」的默认值）。 */
export const QUIET_WINDOW_MS = 5 * 60_000;
/** 补审时限：只对已合并的 change 生效，最后变动超过这段时间的不再补审；开着的条目不受它限制。 */
export const MERGED_BACKFILL_MS = 72 * 3600_000;
/** 每个项目每轮最多自动入队的条目数：任务包要下载整个仓库快照，一轮不打满平台额度。 */
export const AUTO_PER_PROJECT_ROUND = 10;
export const MANUAL_LABEL = "bot:manual";
const OPEN_STATES: Readonly<Record<string, true>> = { open: true, opened: true };
const isOpen = (state: string): boolean => Object.hasOwn(OPEN_STATES, state);
export const WRITE_RANK: Readonly<Record<WriteMode, number>> = { off: 0, dry_run: 1, on: 2 };

/** 项目设置与实例上限中更严的写入模式；已归档或已消失的项目一律 off。 */
export function effectiveWriteMode(project: Pick<ProjectRow, "write_mode" | "archived" | "status">, ceiling: WriteMode): WriteMode {
  if (project.archived === 1 || project.status !== "active") return "off";
  return WRITE_RANK[project.write_mode] > WRITE_RANK[ceiling] ? ceiling : project.write_mode;
}

/** 条目的触发版本：change 是 head sha；issue 是标题与正文的哈希（机器人自己的评论不改变它）。 */
export function itemVersion(item: Pick<ItemRow, "kind" | "head_sha" | "title" | "body">): string | null {
  if (item.kind === "change") return item.head_sha;
  return `content:${sha256Hex(`${item.title}\0${item.body}`)}`;
}

/** 条目能否派发这个类型的任务（管理员按条目派发与自动入队共用）；不行时抛 409/422，code 原样给 console。 */
export function assertItemDispatchable(project: ProjectRecord, item: ItemRow, kind: TaskKind): void {
  if (!ITEM_KINDS[item.kind].includes(kind)) throw new PlatformError(422, "kind_mismatch", item.kind === "change" ? "变更只能派发 review 或 rework" : "issue 只能派发 triage、followup 或 fix");
  if (!project.capabilities.includes(kind)) throw new PlatformError(409, "capability_unavailable", "机器人在这个项目上的平台权限不支持这个任务类型");
  if (!project[KIND_SWITCH[kind]]) throw new PlatformError(409, "switch_disabled", `项目的 ${KIND_SWITCH[kind]} 开关没有打开`);
  if (item.kind === "issue") {
    if (!isOpen(item.state)) throw new PlatformError(409, "item_inactive", "issue 已经关闭");
    return;
  }
  if (kind === "review") {
    if (item.bot_authored === 1) throw new PlatformError(409, "own_change", "机器人不审查自己发起的变更");
    if (!isOpen(item.state) && item.state !== "merged") throw new PlatformError(409, "item_inactive", "变更已经关闭");
    return;
  }
  if (item.bot_authored !== 1) throw new PlatformError(409, "rework_target_rejected", "只能返工机器人自己发起的变更");
  if (!isOpen(item.state)) throw new PlatformError(409, "item_inactive", "变更已经关闭或合并，不能返工");
}

/** 自动入队的一个候选：条目、任务类型与触发版本。 */
export interface AutoCandidate {
  readonly itemId: string;
  readonly kind: "review" | "triage";
  readonly version: string;
}

export interface AutoEnqueuer {
  /** 由系统身份为一个候选建任务；已有同版本任务、条目忙或条件不再成立时返回 null。 */
  autoEnqueue(candidate: AutoCandidate): Promise<unknown>;
}

export interface RepositoryIntake {
  /** 一个项目的条目同步落库之后调用：挑出符合条件的条目，逐个交给任务服务入队。返回入队的个数。 */
  afterSync(projectId: string): Promise<number>;
}

export function createRepositoryIntake(ctx: PlatformContext, tasks: AutoEnqueuer): RepositoryIntake {
  const { db, clock, config, logger } = ctx;

  /** 同一条目同一类型同一版本已经有过任务，或条目上有活跃任务。 */
  function alreadyHandled(candidate: AutoCandidate): boolean {
    return (
      db.prepare("SELECT 1 FROM tasks WHERE item_id = ? AND ((kind = ? AND item_version = ?) OR status IN ('queued', 'running', 'awaiting_publish')) LIMIT 1").get(candidate.itemId, candidate.kind, candidate.version) !==
      undefined
    );
  }

  function candidates(projectRow: ProjectRow, connection: ConnectionRow): AutoCandidate[] {
    const project = projectRecord(projectRow);
    const reviewOn = project.review_enabled && project.capabilities.includes("review");
    const triageOn = project.triage_enabled && project.capabilities.includes("triage");
    if (!reviewOn && !triageOn) return [];
    // 机器人账号：只认实时身份核对过（account_external_id 已写入）的连接账号。
    const botLogin = connection.account_external_id !== null ? connection.account_name : null;
    const now = clock();
    const rows = db
      .prepare(
        `SELECT * FROM items WHERE project_id = ? AND updated_at <= ?
           AND (state IN ('open', 'opened') OR (kind = 'change' AND state = 'merged' AND updated_at >= ?)) ORDER BY updated_at, id`,
      )
      .all(projectRow.id, now - QUIET_WINDOW_MS, now - MERGED_BACKFILL_MS) as ItemRow[];
    const assignedToBot: AutoCandidate[] = [];
    const rest: AutoCandidate[] = [];
    for (const item of rows) {
      let kind: AutoCandidate["kind"];
      let priority = false;
      if (item.kind === "change") {
        if (!reviewOn || item.bot_authored === 1 || item.head_sha === null) continue;
        kind = "review";
      } else {
        if (!triageOn) continue;
        if (parseJsonColumn<string[]>(item.labels_json, []).includes(MANUAL_LABEL)) continue;
        const assignees = parseJsonColumn<string[]>(item.assignees_json, []);
        if (assignees.length > 0) {
          // 分配给了人（或无法确认是机器人）就不接；只分配给机器人的是明确交给机器人的任务，优先。
          if (botLogin === null || assignees.some(login => login !== botLogin)) continue;
          priority = true;
        }
        kind = "triage";
      }
      const version = itemVersion(item);
      if (version === null) continue;
      const candidate = { itemId: item.id, kind, version };
      if (!alreadyHandled(candidate)) (priority ? assignedToBot : rest).push(candidate);
    }
    return [...assignedToBot, ...rest].slice(0, AUTO_PER_PROJECT_ROUND);
  }

  return {
    async afterSync(projectId) {
      const projectRow = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRow | undefined;
      if (!projectRow || projectRow.enabled !== 1 || effectiveWriteMode(projectRow, config.writeModeCeiling) === "off") return 0;
      const connection = db.prepare(`${CONNECTION_SELECT} WHERE c.id = ?`).get(projectRow.connection_id) as ConnectionRow | undefined;
      if (!connection || connection.enabled !== 1 || connection.status !== "ready") return 0;
      let queued = 0;
      for (const candidate of candidates(projectRow, connection)) {
        try {
          if ((await tasks.autoEnqueue(candidate)) !== null) queued += 1;
        } catch (error) {
          // 这一轮跳过这个条目；版本没有记下，下一轮同步会重试。
          logger.warn({ project_id: projectId, item_id: candidate.itemId, kind: candidate.kind, err: error }, "自动入队失败");
        }
      }
      return queued;
    },
  };
}
