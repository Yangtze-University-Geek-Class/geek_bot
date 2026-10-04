<script setup lang="ts">
/**
 * 任务列表（`GET /api/v1/tasks`）与平台计数（`GET /api/v1/overview`）。
 * 计数按钮直接切换状态筛选；筛选与游标写在地址栏里。取消、重新排队、发布在任务详情里操作。
 */
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import type { Executor, OverviewResponse, TaskKind, TaskRecord, TaskStatus } from "@geek-bot/protocol";
import { TxButton } from "@talex-touch/tuffex/button";
import { TxDataTable } from "@talex-touch/tuffex/data-table";
import { TxSelect } from "@talex-touch/tuffex/select";
import { TxStatusBadge } from "@talex-touch/tuffex/status-badge";
import CursorPager from "../components/CursorPager.vue";
import ProjectPicker from "../components/ProjectPicker.vue";
import StateView from "../components/StateView.vue";
import { useConsoleContext } from "../components/context.js";
import { queryText, useCursorList, useQueryFilters } from "../components/use-data.js";
import { useProjectNames } from "../components/use-project-names.js";
import { formatTime } from "../lib/format.js";
import { EXECUTOR_LABELS, TASK_KIND_LABELS, TASK_STATUS_LABELS } from "../lib/labels.js";

const { api } = useConsoleContext();
const route = useRoute();
const setFilters = useQueryFilters();

const status = computed(() => queryText(route.query.status));
const projectId = computed(() => queryText(route.query.project_id));
const list = useCursorList<TaskRecord>({
  path: () => "/api/v1/tasks",
  filters: () => ({ status: status.value, project_id: projectId.value }),
});
const projectName = useProjectNames(() => list.items.value.map(task => task.project_id));

const overview = ref<OverviewResponse | null>(null);
const overviewFailed = ref(false);
async function loadOverview() {
  try {
    overview.value = await api.get<OverviewResponse>("/api/v1/overview");
    overviewFailed.value = false;
  } catch {
    overviewFailed.value = true;
  }
}
onMounted(loadOverview);

function refresh() {
  void loadOverview();
  void list.reload();
}

const COUNTERS: readonly { key: "queued" | "running" | "awaiting_publish" | "failed"; label: string }[] = [
  { key: "queued", label: "排队中" },
  { key: "running", label: "运行中" },
  { key: "awaiting_publish", label: "待发布" },
  { key: "failed", label: "失败" },
];

const STATUS_OPTIONS = [
  { value: "", label: "全部状态" },
  ...(Object.keys(TASK_STATUS_LABELS) as TaskStatus[]).map(key => ({ value: key, label: TASK_STATUS_LABELS[key].label })),
];

const columns = [
  { key: "id", title: "任务" },
  { key: "project", title: "项目" },
  { key: "kind", title: "类型" },
  { key: "executor", title: "执行器" },
  { key: "status", title: "状态" },
  { key: "machine_id", title: "机器" },
  { key: "created_at", title: "创建时间" },
];
</script>

<template>
  <section class="page" aria-labelledby="page-title-tasks">
    <div class="page-header">
      <div class="page-header__text">
        <h1 id="page-title-tasks" class="page-title">任务</h1>
        <p class="page-lede">中央队列里的全部任务。控制面按资源与租约把任务派给机器；结果先进入「待发布」，再按项目的写入模式发布。</p>
      </div>
      <div class="actions">
        <TxButton variant="secondary" icon="i-carbon-renew" @click="refresh">刷新</TxButton>
      </div>
    </div>

    <div class="counters" role="group" aria-label="按状态筛选（括号里是当前数量）">
      <TxButton
        v-for="counter in COUNTERS"
        :key="counter.key"
        :variant="status === counter.key ? 'primary' : 'secondary'"
        size="sm"
        :aria-pressed="status === counter.key"
        @click="setFilters({ status: status === counter.key ? '' : counter.key })"
      >
        {{ counter.label }}（{{ overview ? overview[counter.key] : overviewFailed ? "读取失败" : "…" }}）
      </TxButton>
    </div>

    <div class="toolbar" role="search" aria-label="筛选任务">
      <label class="field">
        <span class="field__label">状态</span>
        <TxSelect :model-value="status" :options="STATUS_OPTIONS" @update:model-value="value => setFilters({ status: typeof value === 'string' ? value : '' })" />
      </label>
      <label class="field">
        <span class="field__label">项目</span>
        <ProjectPicker :model-value="projectId" none-label="全部项目" @update:model-value="value => setFilters({ project_id: value })" />
      </label>
    </div>

    <StateView
      :state="list.state.value"
      subject="任务列表"
      :empty-title="status || projectId ? '没有符合筛选的任务' : '还没有任务'"
      :empty-description="status || projectId ? '换个状态或项目再试。' : '在需求详情里关联项目并派发后，任务会出现在这里。'"
      @retry="list.reload"
    >
      <TxDataTable :columns="columns" :data="[...list.items.value]" row-key="id" scroll-x empty-text="这一页没有任务">
        <template #cell-id="{ row }">
          <RouterLink class="link mono" :to="`/tasks/${encodeURIComponent(row.id)}`">{{ row.id }}</RouterLink>
        </template>
        <template #cell-project="{ row }">
          <RouterLink class="link" :to="`/projects/${encodeURIComponent(row.project_id)}`">{{ projectName(row.project_id) }}</RouterLink>
        </template>
        <template #cell-kind="{ row }">{{ TASK_KIND_LABELS[row.kind as TaskKind] }}</template>
        <template #cell-executor="{ row }">{{ EXECUTOR_LABELS[row.executor as Executor] }}</template>
        <template #cell-status="{ row }">
          <TxStatusBadge :text="TASK_STATUS_LABELS[row.status as TaskStatus].label" :status="TASK_STATUS_LABELS[row.status as TaskStatus].tone" size="sm" />
        </template>
        <template #cell-machine_id="{ row }">
          <RouterLink v-if="row.machine_id" class="link mono" :to="`/machines/${encodeURIComponent(row.machine_id)}`">{{ row.machine_id }}</RouterLink>
          <span v-else>未分配</span>
        </template>
        <template #cell-created_at="{ row }">{{ formatTime(row.created_at) }}</template>
      </TxDataTable>
      <CursorPager :list="list" label="任务列表分页" />
    </StateView>
  </section>
</template>

<style scoped>
.counters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
