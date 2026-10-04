<script setup lang="ts">
/**
 * 项目详情（`GET/PATCH /api/v1/projects/:id`、`GET /:id/items`、`POST /:id/sync`、`POST /:id/items/:item_id/dispatch`）。
 * - 执行开关与写入模式：PATCH 带 If-Match；调到「真实写入」先确认，服务端可能要求所有者重新认证。
 * - 自动处理开关（审查、受理、修复、返工）：值来自服务端；打开先确认，只有所有者能打开并可能要重新认证，操作员只能关闭。
 * - 机器分配：不选任何机器表示使用全局机器池里任何合格的机器；选了就只在这些机器上执行。
 * - 条目：从平台同步来的 issue 与变更（PR / MR），标题与正文按纯文本显示；每行可以把这个条目派发成任务。
 *   界面上的可选项与禁用原因只是提示，能不能派发由服务端按角色、项目开关和条目状态最终判断，拒绝原因原样留在表单里。
 */
import { computed, nextTick, ref, watch } from "vue";
import { useRoute } from "vue-router";
import type { ApiList, Capability, Executor, ItemRecord, MachineRecord, ModelPoolsResponse, ProjectRecord, ProjectSyncResponse, TaskKind, TaskRecord, WriteMode } from "@geek-bot/protocol";
import { TxAlert } from "@talex-touch/tuffex/alert";
import { TxButton } from "@talex-touch/tuffex/button";
import { TxCheckbox } from "@talex-touch/tuffex/checkbox";
import { TxDataTable } from "@talex-touch/tuffex/data-table";
import { TxInput } from "@talex-touch/tuffex/input";
import { TxNumberInput } from "@talex-touch/tuffex/number-input";
import { TxSelect, type TxSelectModelValue } from "@talex-touch/tuffex/select";
import { TxStatusBadge } from "@talex-touch/tuffex/status-badge";
import { TxSwitch } from "@talex-touch/tuffex/switch";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import CursorPager from "../components/CursorPager.vue";
import StateView from "../components/StateView.vue";
import { useConsoleContext } from "../components/context.js";
import { useAction } from "../components/use-action.js";
import { useConnectionDirectory } from "../components/use-connections.js";
import { queryText, useCursorList, useQueryFilters, useRecord } from "../components/use-data.js";
import { describeError, newIdempotencyKey, withQuery } from "../lib/api.js";
import { formatTime } from "../lib/format.js";
import {
  CAPABILITY_LABELS,
  EXECUTOR_LABELS,
  MACHINE_STATUS_LABELS,
  PROJECT_STATUS_LABELS,
  TASK_KIND_LABELS,
  TASK_STATUS_LABELS,
  VM_ONLY_KINDS,
  WRITE_MODE_LABELS,
} from "../lib/labels.js";

const props = defineProps<{ id: string }>();

const { api, session } = useConsoleContext();
const route = useRoute();
const directory = useConnectionDirectory();
const setItemFilters = useQueryFilters(["items_cursor"]);
const projectPath = computed(() => `/api/v1/projects/${encodeURIComponent(props.id)}`);
const record = useRecord<ProjectRecord>(() => projectPath.value);
const project = record.data;

const canOperate = computed(() => session.allows("operator"));
const writable = computed(() => project.value !== null && !project.value.archived && project.value.status === "active");
/** 平台给的地址只在是 http(s) 时做成链接，其余原样按文本显示。 */
function safeUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}
const externalUrl = computed(() => (project.value ? safeUrl(project.value.url) : null));

type SwitchKey = "review_enabled" | "triage_enabled" | "fix_enabled" | "rework_enabled";
type ProjectPatch = Partial<Pick<ProjectRecord, "enabled" | "write_mode" | "machine_ids" | "tags" | SwitchKey>>;

const update = useAction(
  async (patch: ProjectPatch) => {
    const next = await api.send<ProjectRecord>("PATCH", projectPath.value, { body: patch, ifMatch: record.etag.value });
    record.replace(next);
    return next;
  },
  { name: "保存项目设置", success: () => "项目设置已保存" },
);

async function saveOrReload(patch: ProjectPatch) {
  const result = await update.run(patch);
  // 失败（包括 412 版本冲突）时重新读一次，界面回到服务端的真实值。
  if (result === undefined) await record.reload();
}

// 写入模式：调到「真实写入」先确认。
const WRITE_MODE_OPTIONS = (Object.keys(WRITE_MODE_LABELS) as WriteMode[]).map(mode => ({ value: mode, label: WRITE_MODE_LABELS[mode].label }));
const confirmOn = ref(false);
function onWriteMode(value: TxSelectModelValue) {
  if (value !== "off" && value !== "dry_run" && value !== "on") return;
  if (value === project.value?.write_mode) return;
  if (value === "on") confirmOn.value = true;
  else void saveOrReload({ write_mode: value });
}
async function confirmWriteOn() {
  const result = await update.run({ write_mode: "on" });
  if (result !== undefined) confirmOn.value = false;
}

// 自动处理开关：打开只归所有者（服务端可能要求重新认证），先确认；操作员只能关闭。
type ItemTaskKind = Extract<TaskKind, "review" | "triage" | "followup" | "fix" | "rework">;
interface SwitchSpec {
  readonly key: SwitchKey;
  readonly label: string;
  /** 打开时服务端要求项目具备的能力。 */
  readonly capability: Capability;
  readonly hint: string;
}
const SWITCH_SPECS: Readonly<Record<SwitchKey, SwitchSpec>> = {
  review_enabled: { key: "review_enabled", capability: "review", label: "审查别人的变更", hint: "别人的 PR / MR 出现新 head 时审查；机器人自己的变更不审查。" },
  triage_enabled: { key: "triage_enabled", capability: "triage", label: "受理 issue", hint: "issue 静默一段时间后受理；已指派给人或标了手动处理的不接。手动派发的跟进也归这个开关。" },
  fix_enabled: { key: "fix_enabled", capability: "fix", label: "修复 issue", hint: "在一次性 VM 里写修复，按写入模式开到受保护的修复分支上。" },
  rework_enabled: { key: "rework_enabled", capability: "rework", label: "返工机器人自己的变更", hint: "只按成员在机器人变更上的反馈返工。" },
};
const SWITCHES = Object.values(SWITCH_SPECS);
/** 每类条目任务归哪个开关管（与服务端一致：跟进归受理）。 */
const SWITCH_FOR: Readonly<Record<ItemTaskKind, SwitchSpec>> = {
  review: SWITCH_SPECS.review_enabled,
  triage: SWITCH_SPECS.triage_enabled,
  followup: SWITCH_SPECS.triage_enabled,
  fix: SWITCH_SPECS.fix_enabled,
  rework: SWITCH_SPECS.rework_enabled,
};
const isOwner = computed(() => session.allows("owner"));
const enableTarget = ref<SwitchSpec | null>(null);
const enableOpen = computed({
  get: () => enableTarget.value !== null,
  set: open => {
    if (!open) enableTarget.value = null;
  },
});
function switchPatch(key: SwitchKey, value: boolean): ProjectPatch {
  return { [key]: value };
}
function onSwitch(spec: SwitchSpec, value: boolean) {
  if (!project.value || value === project.value[spec.key]) return;
  if (value) enableTarget.value = spec;
  else void saveOrReload(switchPatch(spec.key, false));
}
async function confirmEnable() {
  const spec = enableTarget.value;
  if (!spec) return;
  const result = await update.run(switchPatch(spec.key, true));
  if (result !== undefined) enableTarget.value = null;
  // 失败（例如放弃重新认证、版本冲突、权限不足）时弹层保持打开显示错误，同时重新读项目，开关与 If-Match 回到服务端的当前值。
  else await record.reload();
}

// 机器分配与标签：表单草稿，保存时一起提交。
const machines = ref<readonly MachineRecord[]>([]);
const machinesError = ref("");
const machineDraft = ref<string[]>([]);
const tagsDraft = ref("");
watch(
  project,
  value => {
    if (!value) return;
    machineDraft.value = [...value.machine_ids];
    tagsDraft.value = value.tags.join(", ");
  },
  { immediate: true },
);

async function loadMachines() {
  const all: MachineRecord[] = [];
  let cursor = "";
  try {
    for (let page = 0; page < 10; page += 1) {
      const result = await api.get<ApiList<MachineRecord>>(withQuery("/api/v1/machines", { limit: 200, cursor }));
      all.push(...result.items);
      if (!result.next_cursor) break;
      cursor = result.next_cursor;
    }
    machines.value = all;
    machinesError.value = "";
  } catch {
    machinesError.value = "读取机器清单失败；已分配的机器仍按 id 显示。";
  }
}
void loadMachines();

/** 已分配但不在清单里的机器（例如已删除），仍列出来，允许取消分配。 */
const machineChoices = computed(() => {
  const known = new Map(machines.value.map(machine => [machine.id, machine]));
  const extra = (project.value?.machine_ids ?? []).filter(id => !known.has(id));
  return [...machines.value.map(machine => ({ id: machine.id, label: `${machine.name} · ${MACHINE_STATUS_LABELS[machine.status].label}` })), ...extra.map(id => ({ id, label: `${id}（不在机器清单里）` }))];
});

function toggleMachine(id: string, checked: boolean) {
  machineDraft.value = checked ? [...new Set([...machineDraft.value, id])] : machineDraft.value.filter(candidate => candidate !== id);
}

const parsedTags = computed(() => [...new Set(tagsDraft.value.split(/[,，\s]+/).map(tag => tag.trim()).filter(Boolean))]);
const assignmentDirty = computed(() => {
  if (!project.value) return false;
  const sameMachines = [...machineDraft.value].sort().join("\n") === [...project.value.machine_ids].sort().join("\n");
  return !sameMachines || parsedTags.value.join("\n") !== project.value.tags.join("\n");
});

// 同步与条目。
const sync = useAction(
  async () => {
    const result = await api.send<ProjectSyncResponse>("POST", `${projectPath.value}/sync`);
    await items.reload();
    return result;
  },
  { name: "同步条目", success: result => `同步完成：${result.items} 个条目` },
);

const itemKind = computed(() => queryText(route.query.kind));
const items = useCursorList<ItemRecord>({
  path: () => `${projectPath.value}/items`,
  filters: () => ({ kind: itemKind.value }),
  cursorKey: "items_cursor",
});
const ITEM_KIND_OPTIONS = [
  { value: "", label: "全部条目" },
  { value: "issue", label: "issue" },
  { value: "change", label: "变更（PR / MR）" },
];
const itemColumns = [
  { key: "number", title: "编号" },
  { key: "title", title: "标题" },
  { key: "kind", title: "类型" },
  { key: "state", title: "状态" },
  { key: "author", title: "作者" },
  { key: "head_sha", title: "head" },
  { key: "updated_at", title: "更新时间" },
  { key: "actions", title: "派发" },
];

// 条目派发：issue 可以受理、跟进或修复；别人的变更可以审查，机器人自己的变更（服务端按账号 UID 判断）可以返工。
function kindsFor(item: ItemRecord): readonly ItemTaskKind[] {
  if (item.kind === "issue") return ["triage", "followup", "fix"];
  return item.bot_authored ? ["rework"] : ["review"];
}

const target = ref<{ item: ItemRecord; kind: ItemTaskKind } | null>(null);
const dispatchTitle = ref<HTMLElement | null>(null);
const executor = ref<Executor>("sandbox");
const customResources = ref(false);
const cpu = ref<number | null>(2);
const memory = ref<number | null>(4096);
const customPool = ref(false);
const poolModel = ref("");
const poolEffort = ref("");
const createdTask = ref<TaskRecord | null>(null);
let dispatchKey = newIdempotencyKey();

async function openDispatch(item: ItemRecord, kind: ItemTaskKind) {
  target.value = { item, kind };
  createdTask.value = null;
  dispatch.error.value = null;
  void loadPools();
  await nextTick();
  dispatchTitle.value?.focus();
}
function closeDispatch() {
  target.value = null;
  createdTask.value = null;
  dispatch.error.value = null;
}

watch(
  () => target.value && `${target.value.item.id}:${target.value.kind}`,
  () => {
    if (target.value) executor.value = VM_ONLY_KINDS[target.value.kind] ? "vm" : "sandbox";
  },
);

const targetKindOptions = computed(() => (target.value ? kindsFor(target.value.item).map(value => ({ value, label: TASK_KIND_LABELS[value] })) : []));
function onTargetKind(value: TxSelectModelValue) {
  if (target.value && typeof value === "string" && (kindsFor(target.value.item) as readonly string[]).includes(value)) target.value.kind = value as ItemTaskKind;
}
const executorOptions = computed(() =>
  (Object.keys(EXECUTOR_LABELS) as Executor[]).map(value => ({ value, label: EXECUTOR_LABELS[value], disabled: target.value !== null && VM_ONLY_KINDS[target.value.kind] && value === "sandbox" })),
);
function onExecutor(value: TxSelectModelValue) {
  if (value === "sandbox" || value === "vm") executor.value = value;
}
const resourcesValid = computed(
  () => !customResources.value || (cpu.value !== null && cpu.value >= 1 && cpu.value <= 256 && memory.value !== null && memory.value >= 128 && memory.value <= 1048576),
);

// 模型池：默认用这一类任务的全局模型池；也可以只为这次派发指定一个模型与思考档位（只能从 catalog 里选）。
const pools = ref<ModelPoolsResponse | null>(null);
const poolsError = ref("");
let poolsLoading: Promise<void> | null = null;
function loadPools(): Promise<void> {
  if (pools.value) return Promise.resolve();
  poolsLoading ??= api
    .get<ModelPoolsResponse>("/api/v1/model-pools")
    .then(result => {
      pools.value = result;
      poolsError.value = "";
    })
    .catch(() => {
      poolsError.value = "读取模型池失败；不指定模型时仍按服务端的全局模型池执行。";
    })
    .finally(() => {
      poolsLoading = null;
    });
  return poolsLoading;
}
const catalogModels = computed(() => pools.value?.catalog.models ?? []);
const globalPool = computed(() => (target.value ? (pools.value?.pools.find(pool => pool.kind === target.value?.kind)?.entries ?? null) : null));
const modelOptions = computed(() => catalogModels.value.map(model => ({ value: model.id, label: model.name, description: model.id })));
function effortsOf(modelId: string): readonly string[] {
  const efforts = catalogModels.value.find(model => model.id === modelId)?.efforts ?? [];
  return efforts.length ? efforts : ["off"];
}
function onPoolModel(value: TxSelectModelValue) {
  if (typeof value !== "string") return;
  poolModel.value = value;
  const efforts = effortsOf(value);
  if (!efforts.includes(poolEffort.value)) poolEffort.value = efforts[0];
}
function onPoolEffort(value: TxSelectModelValue) {
  if (typeof value === "string") poolEffort.value = value;
}
const poolValid = computed(() => !customPool.value || (catalogModels.value.some(model => model.id === poolModel.value) && effortsOf(poolModel.value).includes(poolEffort.value)));
watch(customPool, on => {
  const first = catalogModels.value[0];
  if (on && poolModel.value === "" && first) onPoolModel(first.id);
});

/** 从项目记录就能看出来的拒绝原因；服务端还会检查角色、条目状态、作者与并发上限。 */
const dispatchBlockers = computed(() => {
  const value = project.value;
  const current = target.value;
  if (!value || !current) return [];
  const reasons: string[] = [];
  if (!canOperate.value) reasons.push("当前角色只能查看；派发任务需要操作员或所有者。");
  if (value.status !== "active") reasons.push("连接已失去对这个项目的访问，不能派发。");
  if (!value.enabled) reasons.push("项目的「执行任务」没有打开。");
  if (!value.capabilities.includes(current.kind)) reasons.push(`连接账号在这个项目上没有「${CAPABILITY_LABELS[current.kind]}」能力（平台权限不够）。`);
  if (!value[SWITCH_FOR[current.kind].key]) reasons.push(`项目的「${SWITCH_FOR[current.kind].label}」开关没有打开；所有者打开后才能派发这类任务。`);
  if (current.item.active_task) reasons.push("这个条目已经有一个没结束的任务；等它结束或取消后再派发。");
  return reasons;
});

/** 这次派发要发的请求体；内容一变就换幂等键，同一份请求重试时复用。 */
const dispatchBody = computed(() => {
  const current = target.value;
  if (!current) return null;
  return {
    kind: current.kind,
    executor: executor.value,
    ...(customResources.value && cpu.value !== null && memory.value !== null ? { resources: { cpu: cpu.value, memory_mib: memory.value } } : {}),
    ...(customPool.value ? { model_pool: [{ model: poolModel.value, effort: poolEffort.value }] } : {}),
  };
});
watch(
  () => target.value && `${target.value.item.id}:${JSON.stringify(dispatchBody.value)}`,
  () => {
    dispatchKey = newIdempotencyKey();
  },
);

const dispatch = useAction(
  async () => {
    const current = target.value;
    const body = dispatchBody.value;
    if (!current || !body) throw new Error("没有选中条目");
    const task = await api.send<TaskRecord>("POST", `${projectPath.value}/items/${encodeURIComponent(current.item.id)}/dispatch`, { body, idempotencyKey: dispatchKey });
    dispatchKey = newIdempotencyKey();
    createdTask.value = task;
    // 重新读条目：行内的「进行中的任务」与表单里的禁用原因都以服务端为准。
    await items.reload(true);
    const fresh = items.items.value.find(item => item.id === current.item.id);
    if (fresh && target.value?.item.id === fresh.id) target.value.item = fresh;
    return task;
  },
  { name: "派发条目任务", success: task => `已派发任务（${TASK_KIND_LABELS[task.kind]}），当前状态：${TASK_STATUS_LABELS[task.status].label}` },
);

// 真实写入的项目：任务结果会由控制面写回平台，派发前先确认。
const confirmDispatch = ref(false);
function submitDispatch() {
  if (project.value?.write_mode === "on") confirmDispatch.value = true;
  else void dispatch.run();
}
async function confirmDispatchRun() {
  const result = await dispatch.run();
  if (result !== undefined) confirmDispatch.value = false;
}
</script>

<template>
  <section class="page" aria-labelledby="page-title-project">
    <StateView :state="record.state.value" subject="项目" @retry="record.reload">
      <template v-if="project">
        <div class="page-header">
          <div class="page-header__text">
            <RouterLink class="page-header__back" to="/projects">返回项目列表</RouterLink>
            <h1 id="page-title-project" class="page-title">{{ project.name }}</h1>
            <p class="page-lede mono">{{ project.path }}</p>
          </div>
          <div class="actions">
            <TxButton variant="secondary" icon="i-carbon-renew" :loading="sync.pending.value" :disabled="!canOperate" @click="sync.run()">同步条目</TxButton>
            <RouterLink class="link" :to="{ path: '/tasks', query: { project_id: project.id } }">这个项目的任务</RouterLink>
            <RouterLink class="link" :to="{ path: '/demands', query: { project_id: project.id } }">这个项目的需求</RouterLink>
          </div>
        </div>

        <TxAlert v-if="project.archived" type="warning" title="项目已归档" message="归档的项目不能写入，也不会派发需要写入的任务。" :closable="false" />
        <TxAlert v-if="project.status === 'lost'" type="error" title="连接已失去对这个项目的访问" message="最近一次发现没有再看到这个项目；恢复访问并重新发现后会变回可访问。" :closable="false" />
        <TxAlert v-if="!canOperate" type="info" title="只读" message="当前角色只能查看；修改项目设置需要操作员或所有者。" :closable="false" />

        <dl class="meta-list section">
          <div><dt>连接</dt><dd>{{ directory.nameOf(project.connection_id) }}</dd></div>
          <div>
            <dt>状态</dt>
            <dd><TxStatusBadge :text="PROJECT_STATUS_LABELS[project.status].label" :status="PROJECT_STATUS_LABELS[project.status].tone" size="sm" /></dd>
          </div>
          <div><dt>账号在平台上的权限</dt><dd class="mono">{{ project.permission }}</dd></div>
          <div><dt>可用能力</dt><dd>{{ project.capabilities.length ? project.capabilities.map(capability => CAPABILITY_LABELS[capability]).join("、") : "没有" }}</dd></div>
          <div><dt>默认分支</dt><dd class="mono">{{ project.default_branch }}</dd></div>
          <div><dt>可见性</dt><dd>{{ project.private ? "私有" : "公开" }}</dd></div>
          <div><dt>更新时间</dt><dd>{{ formatTime(project.updated_at) }}</dd></div>
          <div>
            <dt>平台地址</dt>
            <dd>
              <a v-if="externalUrl" class="link mono" :href="externalUrl" target="_blank" rel="noopener noreferrer">{{ project.url }}</a>
              <span v-else class="mono">{{ project.url }}</span>
            </dd>
          </div>
        </dl>

        <section class="section" aria-labelledby="exec-title">
          <h2 id="exec-title" class="section__title">执行与写入</h2>
          <p class="section__hint">
            「执行」决定是否为这个项目派发任务。写入模式决定任务结果怎么回到平台：关闭写入不回写；演练只在后台记录将要发布的内容；真实写入由控制面以连接账号的身份发评论或开受保护的修复分支，批准与合并始终由人来做。
          </p>
          <div class="form-grid">
            <div class="field">
              <span id="enabled-label" class="field__label">执行任务</span>
              <TxSwitch
                :model-value="project.enabled"
                aria-labelledby="enabled-label"
                :loading="update.pending.value"
                :disabled="!canOperate || update.pending.value"
                @update:model-value="value => saveOrReload({ enabled: value })"
              />
            </div>
            <label class="field">
              <span class="field__label">写入模式</span>
              <TxSelect :model-value="project.write_mode" :options="WRITE_MODE_OPTIONS" :disabled="!canOperate || !writable || update.pending.value" @update:model-value="onWriteMode" />
              <span v-if="!writable" class="field__hint">归档或失去访问的项目不能写入。</span>
            </label>
          </div>
        </section>

        <section class="section" aria-labelledby="auto-title">
          <h2 id="auto-title" class="section__title">按类别处理</h2>
          <p class="section__hint">
            每类处理单独打开，默认全部关闭。打开后，从这个项目的条目派发这类任务才会被接受；项目「执行任务」打开且写入模式不是「关闭写入」时，同步到的符合条件的条目会自动排队。只有所有者能打开（可能要先重新认证），操作员可以关闭。
          </p>
          <div class="form-grid">
            <div v-for="spec in SWITCHES" :key="spec.key" class="field">
              <span :id="`switch-${spec.key}`" class="field__label">{{ spec.label }}</span>
              <TxSwitch
                :model-value="project[spec.key]"
                :aria-labelledby="`switch-${spec.key}`"
                :aria-describedby="`switch-${spec.key}-hint`"
                :loading="update.pending.value"
                :disabled="!canOperate || update.pending.value || (!project[spec.key] && (!isOwner || !writable))"
                @update:model-value="value => onSwitch(spec, value)"
              />
              <span :id="`switch-${spec.key}-hint`" class="field__hint">{{ spec.hint }}</span>
              <span v-if="!project[spec.key] && canOperate && !isOwner" class="field__hint">只有所有者能打开。</span>
              <span v-else-if="!project[spec.key] && !writable" class="field__hint">归档或失去访问的项目不能打开。</span>
              <span v-else-if="!project[spec.key] && !project.capabilities.includes(spec.capability)" class="field__hint">连接账号在这个项目上没有「{{ CAPABILITY_LABELS[spec.capability] }}」能力，打开会被拒绝。</span>
            </div>
          </div>
        </section>

        <section class="section" aria-labelledby="assign-title">
          <h2 id="assign-title" class="section__title">机器分配与标签</h2>
          <p class="section__hint">不选任何机器时，任务可以在全局机器池里任何合格的机器上执行；选了机器后只派发到这些机器。私有项目只会派到高信任的机器。</p>
          <form class="form-grid" @submit.prevent="saveOrReload({ machine_ids: machineDraft, tags: parsedTags })">
            <fieldset class="fieldset form-grid__wide">
              <legend class="field__label">限定机器</legend>
              <p v-if="machinesError" class="field__error" role="alert">{{ machinesError }}</p>
              <p v-else-if="machineChoices.length === 0" class="field__hint">还没有登记机器；到「机器」页登记后可以在这里限定。</p>
              <div class="check-list">
                <TxCheckbox
                  v-for="choice in machineChoices"
                  :key="choice.id"
                  :model-value="machineDraft.includes(choice.id)"
                  :label="choice.label"
                  :disabled="!canOperate"
                  @update:model-value="checked => toggleMachine(choice.id, checked)"
                />
              </div>
              <span class="field__hint">{{ machineDraft.length === 0 ? "当前：全局机器池" : `当前：限定 ${machineDraft.length} 台机器` }}</span>
            </fieldset>
            <label class="field">
              <span class="field__label">标签</span>
              <TxInput v-model="tagsDraft" placeholder="用逗号分隔，例如 backend, nightly" :disabled="!canOperate" />
            </label>
            <div class="actions form-grid__wide">
              <TxButton variant="primary" native-type="submit" :loading="update.pending.value" :disabled="!canOperate || !assignmentDirty">保存分配与标签</TxButton>
            </div>
          </form>
        </section>

        <section class="section" aria-labelledby="items-title">
          <div class="section__head">
            <h2 id="items-title" class="section__title">条目</h2>
            <label class="field items-filter">
              <span class="field__label">类型</span>
              <TxSelect :model-value="itemKind" :options="ITEM_KIND_OPTIONS" @update:model-value="value => setItemFilters({ kind: typeof value === 'string' ? value : '' })" />
            </label>
          </div>
          <StateView
            :state="items.state.value"
            subject="条目"
            empty-title="还没有同步到条目"
            empty-description="点「同步条目」从平台读取这个项目开着的 issue 与变更。"
            @retry="items.reload"
          >
            <TxDataTable :columns="itemColumns" :data="[...items.items.value]" row-key="id" scroll-x empty-text="这一页没有条目">
              <template #cell-number="{ row }"><span class="mono">#{{ row.number }}</span></template>
              <template #cell-title="{ row }">
                <span class="item-title" :title="row.title">{{ row.title }}</span>
              </template>
              <template #cell-kind="{ row }">{{ row.kind === "issue" ? "issue" : row.bot_authored ? "变更（机器人）" : "变更" }}</template>
              <template #cell-author="{ row }"><span class="mono">{{ row.author }}</span></template>
              <template #cell-head_sha="{ row }"><span class="mono">{{ row.head_sha ? row.head_sha.slice(0, 12) : "—" }}</span></template>
              <template #cell-updated_at="{ row }">{{ formatTime(row.updated_at) }}</template>
              <template #cell-actions="{ row }">
                <div class="item-actions">
                  <RouterLink v-if="row.active_task" class="link" :to="`/tasks/${encodeURIComponent(row.active_task.id)}`">
                    {{ CAPABILITY_LABELS[row.active_task.kind as TaskKind] }} · {{ TASK_STATUS_LABELS[row.active_task.status as TaskRecord["status"]].label }}
                  </RouterLink>
                  <TxButton
                    v-for="kind in kindsFor(row as ItemRecord)"
                    :key="kind"
                    size="sm"
                    variant="secondary"
                    :aria-label="`${TASK_KIND_LABELS[kind]}：#${row.number}`"
                    :disabled="!canOperate"
                    @click="openDispatch(row as ItemRecord, kind)"
                  >
                    {{ CAPABILITY_LABELS[kind] }}
                  </TxButton>
                </div>
              </template>
            </TxDataTable>
            <CursorPager :list="items" label="条目分页" />
          </StateView>
        </section>

        <section v-if="target" class="section" aria-labelledby="item-dispatch-title">
          <div class="section__head">
            <h2 id="item-dispatch-title" ref="dispatchTitle" class="section__title" tabindex="-1">
              从条目派发：{{ target.item.kind === "issue" ? "issue" : "变更" }} <span class="mono">#{{ target.item.number }}</span>
            </h2>
            <TxButton variant="ghost" size="sm" icon="i-carbon-close" @click="closeDispatch">收起</TxButton>
          </div>
          <dl class="meta-list">
            <div><dt>标题</dt><dd class="plain-text">{{ target.item.title }}</dd></div>
            <div><dt>作者</dt><dd class="mono">{{ target.item.author }}{{ target.item.bot_authored ? "（机器人账号）" : "" }}</dd></div>
            <div><dt>平台上的状态</dt><dd class="mono">{{ target.item.state }}</dd></div>
            <div v-if="target.item.head_sha"><dt>当前 head</dt><dd class="mono">{{ target.item.head_sha.slice(0, 12) }}</dd></div>
            <div>
              <dt>平台地址</dt>
              <dd>
                <a v-if="safeUrl(target.item.url)" class="link mono" :href="safeUrl(target.item.url) ?? undefined" target="_blank" rel="noopener noreferrer">{{ target.item.url }}</a>
                <span v-else class="mono">{{ target.item.url }}</span>
              </dd>
            </div>
          </dl>
          <TxAlert v-if="dispatchBlockers.length" type="warning" title="现在不能派发" :message="dispatchBlockers.join(' ')" :closable="false" />
          <p class="section__hint">
            任务与这个条目关联，控制面在创建任务时固定条目当时的 head 与 base；结果按项目的写入模式（当前：{{ WRITE_MODE_LABELS[project.write_mode].label }}）发布到这个条目。审查、受理、跟进可以在只读 sandbox 里执行；修复与返工只在一次性 VM 里执行。
          </p>
          <form class="form-grid" @submit.prevent="submitDispatch">
            <label class="field">
              <span class="field__label">任务类型</span>
              <TxSelect :model-value="target.kind" :options="targetKindOptions" :disabled="!canOperate" @update:model-value="onTargetKind" />
            </label>
            <label class="field">
              <span class="field__label">执行器</span>
              <TxSelect :model-value="executor" :options="executorOptions" :disabled="!canOperate" @update:model-value="onExecutor" />
            </label>
            <div class="field form-grid__wide">
              <TxSwitch v-model="customResources" label="指定资源预算" :disabled="!canOperate" />
              <span class="field__hint">不指定时使用控制面的默认预算。</span>
            </div>
            <template v-if="customResources">
              <label class="field">
                <span class="field__label">CPU（核）</span>
                <TxNumberInput v-model="cpu" :min="1" :max="256" :step="1" :precision="0" decrease-label="减少 CPU" increase-label="增加 CPU" />
              </label>
              <label class="field">
                <span class="field__label">内存（MiB）</span>
                <TxNumberInput v-model="memory" :min="128" :max="1048576" :step="512" :precision="0" decrease-label="减少内存" increase-label="增加内存" />
              </label>
            </template>
            <div class="field form-grid__wide">
              <TxSwitch v-model="customPool" label="这次派发指定模型" :disabled="!canOperate || catalogModels.length === 0" />
              <span v-if="poolsError" class="field__error" role="alert">{{ poolsError }}</span>
              <span v-else-if="!customPool" class="field__hint">
                {{ globalPool && globalPool.length ? `不指定时按「${TASK_KIND_LABELS[target.kind]}」的全局模型池依次尝试：${globalPool.map(entry => `${entry.model}（${entry.effort}）`).join(" → ")}` : "不指定时按这一类任务的全局模型池执行。" }}
              </span>
            </div>
            <template v-if="customPool">
              <label class="field">
                <span class="field__label">模型</span>
                <TxSelect :model-value="poolModel" :options="modelOptions" placeholder="选择模型" :disabled="!canOperate" @update:model-value="onPoolModel" />
              </label>
              <label class="field">
                <span class="field__label">思考档位</span>
                <TxSelect
                  :model-value="poolEffort"
                  :options="effortsOf(poolModel).map(effort => ({ value: effort, label: effort }))"
                  placeholder="选择档位"
                  :disabled="!canOperate || poolModel === ''"
                  @update:model-value="onPoolEffort"
                />
              </label>
              <span class="field__hint form-grid__wide">只用这一个模型，不再回退到全局模型池；模型与档位只能从 catalog 里选。</span>
            </template>
            <div class="actions form-grid__wide">
              <TxButton
                variant="primary"
                native-type="submit"
                icon="i-carbon-play-outline"
                :loading="dispatch.pending.value"
                :disabled="!canOperate || dispatchBlockers.length > 0 || !resourcesValid || !poolValid"
              >
                派发任务
              </TxButton>
            </div>
            <p v-if="dispatch.error.value" class="field__error form-grid__wide" role="alert">
              派发没有成功：{{ dispatch.error.value.message }}（{{ describeError(dispatch.error.value) }}）
            </p>
            <p v-if="createdTask" class="form-grid__wide" role="status">
              已创建任务
              <RouterLink class="link mono" :to="`/tasks/${encodeURIComponent(createdTask.id)}`">{{ createdTask.id }}</RouterLink>
              （{{ TASK_KIND_LABELS[createdTask.kind] }} · {{ TASK_STATUS_LABELS[createdTask.status].label }}）。打开任务查看进度与结果。
            </p>
          </form>
        </section>

        <ConfirmDialog v-model="confirmOn" title="切换到真实写入" confirm-label="切换到真实写入" :pending="update.pending.value" :error="update.error.value" @confirm="confirmWriteOn">
          <p>切换后，这个项目的任务结果会由控制面以连接账号的身份真实写回平台（审查评论、受保护分支上的修复变更）。批准、合并始终由人来做。</p>
          <p>这一步只允许所有者执行，可能需要先重新认证。</p>
        </ConfirmDialog>

        <ConfirmDialog
          v-model="enableOpen"
          :title="`打开「${enableTarget?.label ?? ''}」`"
          confirm-label="打开"
          tone="primary"
          :pending="update.pending.value"
          :error="update.error.value"
          @confirm="confirmEnable"
        >
          <p>{{ enableTarget?.hint }}</p>
          <p>
            打开后，项目「执行任务」打开且写入模式不是「关闭写入」时，同步到的符合条件的条目会自动排队；结果按写入模式（当前：{{ WRITE_MODE_LABELS[project.write_mode].label }}）回到平台。批准、合并始终由人来做。
          </p>
          <p>这一步只允许所有者执行，可能需要先重新认证。</p>
        </ConfirmDialog>

        <ConfirmDialog
          v-model="confirmDispatch"
          title="派发到真实写入的项目"
          confirm-label="派发任务"
          tone="primary"
          :pending="dispatch.pending.value"
          :error="dispatch.error.value"
          @confirm="confirmDispatchRun"
        >
          <p v-if="target">
            这个项目是「真实写入」：任务完成后，结果会由控制面以连接账号的身份写回 #{{ target.item.number }}（{{ TASK_KIND_LABELS[target.kind] }}）。批准、合并始终由人来做。
          </p>
        </ConfirmDialog>
      </template>
    </StateView>
  </section>
</template>

<style scoped>
.items-filter {
  width: min(100%, 240px);
}

.item-title {
  display: inline-block;
  max-width: 48ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
}

.item-actions {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}
</style>
