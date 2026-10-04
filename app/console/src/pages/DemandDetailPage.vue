<script setup lang="ts">
/**
 * 需求详情（`GET/PATCH /api/v1/demands/:id`、`POST /:id/dispatch`、`GET /api/v1/tasks?demand_id=`）。
 * - 正文可能来自飞书、Webhook 或代码平台，一律按纯文本显示。
 * - 编辑标题、描述与关联项目：PATCH 带 If-Match。
 * - 派发任务：选任务类型与执行器（修复、返工只能在一次性 VM 里执行），可选资源预算；没有关联项目时不能派发。
 */
import { computed, ref, watch } from "vue";
import type { DemandRecord, Executor, TaskKind, TaskRecord } from "@geek-bot/protocol";
import { TxAlert } from "@talex-touch/tuffex/alert";
import { TxButton } from "@talex-touch/tuffex/button";
import { TxDataTable } from "@talex-touch/tuffex/data-table";
import { TxInput } from "@talex-touch/tuffex/input";
import { TxNumberInput } from "@talex-touch/tuffex/number-input";
import { TxSelect, type TxSelectModelValue } from "@talex-touch/tuffex/select";
import { TxStatusBadge } from "@talex-touch/tuffex/status-badge";
import { TxSwitch } from "@talex-touch/tuffex/switch";
import { TxTextarea } from "@talex-touch/tuffex/textarea";
import CursorPager from "../components/CursorPager.vue";
import ProjectPicker from "../components/ProjectPicker.vue";
import StateView from "../components/StateView.vue";
import { useConsoleContext } from "../components/context.js";
import { useAction } from "../components/use-action.js";
import { useConnectionDirectory } from "../components/use-connections.js";
import { useCursorList, useRecord } from "../components/use-data.js";
import { useProjectNames } from "../components/use-project-names.js";
import { newIdempotencyKey } from "../lib/api.js";
import { formatTime } from "../lib/format.js";
import {
  DEMAND_SOURCE_LABELS,
  DEMAND_STATUS_LABELS,
  EXECUTOR_LABELS,
  TASK_KIND_LABELS,
  TASK_KIND_VALUES,
  TASK_STATUS_LABELS,
  VM_ONLY_KINDS,
  isTaskKind,
} from "../lib/labels.js";

const props = defineProps<{ id: string }>();

const { api, session } = useConsoleContext();
const directory = useConnectionDirectory();
const demandPath = computed(() => `/api/v1/demands/${encodeURIComponent(props.id)}`);
const record = useRecord<DemandRecord>(() => demandPath.value);
const demand = record.data;
const canOperate = computed(() => session.allows("operator"));
const projectName = useProjectNames(() => [demand.value?.project_id ?? null]);

// 编辑。
const editing = ref(false);
const draftTitle = ref("");
const draftBody = ref("");
const draftProject = ref("");
function startEdit() {
  if (!demand.value) return;
  draftTitle.value = demand.value.title;
  draftBody.value = demand.value.body;
  draftProject.value = demand.value.project_id ?? "";
  editing.value = true;
}

const save = useAction(
  async () => {
    const body = { title: draftTitle.value.trim(), body: draftBody.value, project_id: draftProject.value || null };
    const next = await api.send<DemandRecord>("PATCH", demandPath.value, { body, ifMatch: record.etag.value });
    record.replace(next);
    editing.value = false;
    return next;
  },
  { name: "保存需求", success: () => "需求已保存" },
);

// 派发。
const kind = ref<TaskKind>("triage");
const executor = ref<Executor>("sandbox");
const customResources = ref(false);
const cpu = ref<number | null>(2);
const memory = ref<number | null>(4096);
let dispatchKey = newIdempotencyKey();

const kindOptions = TASK_KIND_VALUES.map(value => ({ value, label: TASK_KIND_LABELS[value] }));
const executorOptions = computed(() =>
  (Object.keys(EXECUTOR_LABELS) as Executor[]).map(value => ({ value, label: EXECUTOR_LABELS[value], disabled: VM_ONLY_KINDS[kind.value] && value === "sandbox" })),
);
watch(kind, value => {
  if (VM_ONLY_KINDS[value]) executor.value = "vm";
  dispatchKey = newIdempotencyKey();
});

const resourcesValid = computed(
  () => !customResources.value || (cpu.value !== null && cpu.value >= 1 && cpu.value <= 256 && memory.value !== null && memory.value >= 128 && memory.value <= 1048576),
);

const dispatch = useAction(
  async () => {
    const body = {
      kind: kind.value,
      executor: executor.value,
      ...(customResources.value && cpu.value !== null && memory.value !== null ? { resources: { cpu: cpu.value, memory_mib: memory.value } } : {}),
    };
    const task = await api.send<TaskRecord>("POST", `${demandPath.value}/dispatch`, { body, idempotencyKey: dispatchKey });
    dispatchKey = newIdempotencyKey();
    await Promise.all([record.reload(), tasks.reload()]);
    return task;
  },
  { name: "派发任务", success: task => `已派发任务（${TASK_KIND_LABELS[task.kind]}），当前状态：${TASK_STATUS_LABELS[task.status].label}` },
);

function onKind(value: TxSelectModelValue) {
  if (isTaskKind(value)) kind.value = value;
}
function onExecutor(value: TxSelectModelValue) {
  if (value === "sandbox" || value === "vm") executor.value = value;
}

// 这个需求的任务。
const tasks = useCursorList<TaskRecord>({
  path: () => "/api/v1/tasks",
  filters: () => ({ demand_id: props.id }),
  cursorKey: "tasks_cursor",
});
const taskColumns = [
  { key: "id", title: "任务" },
  { key: "kind", title: "类型" },
  { key: "executor", title: "执行器" },
  { key: "status", title: "状态" },
  { key: "created_at", title: "创建时间" },
];
</script>

<template>
  <section class="page" aria-labelledby="page-title-demand">
    <StateView :state="record.state.value" subject="需求" @retry="record.reload">
      <template v-if="demand">
        <div class="page-header">
          <div class="page-header__text">
            <RouterLink class="page-header__back" to="/demands">返回需求列表</RouterLink>
            <h1 id="page-title-demand" class="page-title">{{ demand.title }}</h1>
          </div>
          <div class="actions">
            <TxStatusBadge :text="DEMAND_STATUS_LABELS[demand.status].label" :status="DEMAND_STATUS_LABELS[demand.status].tone" />
            <TxButton v-if="!editing" variant="secondary" icon="i-carbon-edit" :disabled="!canOperate" @click="startEdit">编辑需求</TxButton>
          </div>
        </div>

        <dl class="meta-list section">
          <div>
            <dt>关联项目</dt>
            <dd>
              <RouterLink v-if="demand.project_id" class="link" :to="`/projects/${encodeURIComponent(demand.project_id)}`">{{ projectName(demand.project_id) }}</RouterLink>
              <TxStatusBadge v-else text="未关联项目" status="warning" size="sm" />
            </dd>
          </div>
          <div><dt>来源</dt><dd>{{ DEMAND_SOURCE_LABELS[demand.source] }}</dd></div>
          <div v-if="demand.source_connection_id"><dt>来源连接</dt><dd>{{ directory.nameOf(demand.source_connection_id) }}</dd></div>
          <div v-if="demand.source_ref"><dt>来源引用</dt><dd class="mono">{{ demand.source_ref }}</dd></div>
          <div><dt>录入时间</dt><dd>{{ formatTime(demand.created_at) }}</dd></div>
          <div><dt>更新时间</dt><dd>{{ formatTime(demand.updated_at) }}</dd></div>
        </dl>

        <section v-if="editing" class="section" aria-labelledby="edit-title">
          <h2 id="edit-title" class="section__title">编辑需求</h2>
          <form class="form-grid" @submit.prevent="save.run()">
            <label class="field form-grid__wide">
              <span class="field__label">标题</span>
              <TxInput v-model="draftTitle" />
            </label>
            <label class="field form-grid__wide">
              <span class="field__label">描述</span>
              <TxTextarea v-model="draftBody" :rows="8" :max-length="20000" show-count />
            </label>
            <label class="field">
              <span class="field__label">关联项目</span>
              <ProjectPicker v-model="draftProject" none-label="不关联项目" />
            </label>
            <div class="actions form-grid__wide">
              <TxButton variant="primary" native-type="submit" :loading="save.pending.value" :disabled="draftTitle.trim() === ''">保存需求</TxButton>
              <TxButton variant="ghost" @click="editing = false">取消编辑</TxButton>
            </div>
            <p v-if="save.error.value" class="field__error form-grid__wide" role="alert">{{ save.error.value.message }}</p>
          </form>
        </section>

        <section v-else class="section" aria-labelledby="body-title">
          <h2 id="body-title" class="section__title">描述</h2>
          <p v-if="demand.body" class="plain-text">{{ demand.body }}</p>
          <p v-else class="section__hint">没有描述。</p>
        </section>

        <section class="section" aria-labelledby="dispatch-title">
          <h2 id="dispatch-title" class="section__title">派发任务</h2>
          <TxAlert
            v-if="!demand.project_id"
            type="warning"
            title="先关联项目"
            message="没有关联项目的需求不能执行。点「编辑需求」选择项目后再派发。"
            :closable="false"
          />
          <p class="section__hint">任务进入全局队列，由控制面按项目的机器分配、执行器与资源挑选机器。审查与受理可以在只读 sandbox 里执行；修复与返工只在一次性 VM 里执行。</p>
          <form class="form-grid" @submit.prevent="dispatch.run()">
            <label class="field">
              <span class="field__label">任务类型</span>
              <TxSelect :model-value="kind" :options="kindOptions" :disabled="!canOperate" @update:model-value="onKind" />
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
            <div class="actions form-grid__wide">
              <TxButton variant="primary" native-type="submit" icon="i-carbon-play-outline" :loading="dispatch.pending.value" :disabled="!canOperate || !demand.project_id || !resourcesValid">派发任务</TxButton>
            </div>
            <p v-if="dispatch.error.value" class="field__error form-grid__wide" role="alert">{{ dispatch.error.value.message }}</p>
          </form>
        </section>

        <section class="section" aria-labelledby="demand-tasks-title">
          <h2 id="demand-tasks-title" class="section__title">这个需求的任务</h2>
          <StateView :state="tasks.state.value" subject="任务" empty-title="还没有派发任务" empty-description="关联项目后用上面的表单派发。" @retry="tasks.reload">
            <TxDataTable :columns="taskColumns" :data="[...tasks.items.value]" row-key="id" scroll-x empty-text="这一页没有任务">
              <template #cell-id="{ row }">
                <RouterLink class="link mono" :to="`/tasks/${encodeURIComponent(row.id)}`">{{ row.id }}</RouterLink>
              </template>
              <template #cell-kind="{ row }">{{ TASK_KIND_LABELS[row.kind as TaskKind] }}</template>
              <template #cell-executor="{ row }">{{ EXECUTOR_LABELS[row.executor as Executor] }}</template>
              <template #cell-status="{ row }">
                <TxStatusBadge :text="TASK_STATUS_LABELS[row.status as TaskRecord['status']].label" :status="TASK_STATUS_LABELS[row.status as TaskRecord['status']].tone" size="sm" />
              </template>
              <template #cell-created_at="{ row }">{{ formatTime(row.created_at) }}</template>
            </TxDataTable>
            <CursorPager :list="tasks" label="需求任务分页" />
          </StateView>
        </section>
      </template>
    </StateView>
  </section>
</template>
