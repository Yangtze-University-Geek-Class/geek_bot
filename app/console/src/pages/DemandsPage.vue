<script setup lang="ts">
/**
 * 需求列表与录入（`GET/POST /api/v1/demands`）。需求可以在后台录入，也可以从飞书、签名 Webhook、代码平台进来；
 * 没有关联项目的需求不能执行，先在详情里关联项目，再派发任务。
 */
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { DemandRecord, DemandStatus } from "@geek-bot/protocol";
import { TxButton } from "@talex-touch/tuffex/button";
import { TxDataTable } from "@talex-touch/tuffex/data-table";
import { TxInput } from "@talex-touch/tuffex/input";
import { TxSelect } from "@talex-touch/tuffex/select";
import { TxStatusBadge } from "@talex-touch/tuffex/status-badge";
import { TxTextarea } from "@talex-touch/tuffex/textarea";
import CursorPager from "../components/CursorPager.vue";
import ProjectPicker from "../components/ProjectPicker.vue";
import StateView from "../components/StateView.vue";
import { useConsoleContext } from "../components/context.js";
import { useAction } from "../components/use-action.js";
import { queryText, useCursorList, useQueryFilters } from "../components/use-data.js";
import { useProjectNames } from "../components/use-project-names.js";
import { newIdempotencyKey } from "../lib/api.js";
import { formatTime } from "../lib/format.js";
import { DEMAND_SOURCE_LABELS, DEMAND_STATUS_LABELS } from "../lib/labels.js";

const { api, session } = useConsoleContext();
const route = useRoute();
const router = useRouter();
const setFilters = useQueryFilters();
const canOperate = computed(() => session.allows("operator"));

const status = computed(() => queryText(route.query.status));
const projectId = computed(() => queryText(route.query.project_id));
const list = useCursorList<DemandRecord>({
  path: () => "/api/v1/demands",
  filters: () => ({ status: status.value, project_id: projectId.value }),
});
const projectName = useProjectNames(() => list.items.value.map(demand => demand.project_id));

const STATUS_OPTIONS = [
  { value: "", label: "全部状态" },
  ...(Object.keys(DEMAND_STATUS_LABELS) as DemandStatus[]).map(key => ({ value: key, label: DEMAND_STATUS_LABELS[key].label })),
];
const columns = [
  { key: "title", title: "需求" },
  { key: "project", title: "项目" },
  { key: "source", title: "来源" },
  { key: "status", title: "状态" },
  { key: "created_at", title: "录入时间" },
];

// 录入表单。
const formOpen = ref(false);
const draftTitle = ref("");
const draftBody = ref("");
const draftProject = ref(projectId.value);
let idempotencyKey = newIdempotencyKey();
const titleValid = computed(() => draftTitle.value.trim().length > 0 && draftTitle.value.trim().length <= 200);

const create = useAction(
  async () => {
    const body = { title: draftTitle.value.trim(), body: draftBody.value, ...(draftProject.value ? { project_id: draftProject.value } : {}) };
    const created = await api.send<DemandRecord>("POST", "/api/v1/demands", { body, idempotencyKey });
    idempotencyKey = newIdempotencyKey();
    draftTitle.value = "";
    draftBody.value = "";
    formOpen.value = false;
    await router.push(`/demands/${encodeURIComponent(created.id)}`);
    return created;
  },
  { name: "录入需求", success: created => `已录入需求「${created.title}」` },
);
</script>

<template>
  <section class="page" aria-labelledby="page-title-demands">
    <div class="page-header">
      <div class="page-header__text">
        <h1 id="page-title-demands" class="page-title">需求</h1>
        <p class="page-lede">后台录入或从飞书、签名 Webhook、代码平台进来的需求。关联项目后才能派发任务；任务结果会回传到需求来源。</p>
      </div>
      <div class="actions">
        <TxButton variant="primary" icon="i-carbon-add" :disabled="!canOperate" :aria-expanded="formOpen" aria-controls="demand-form" @click="formOpen = !formOpen">
          {{ formOpen ? "收起录入" : "录入需求" }}
        </TxButton>
      </div>
    </div>

    <section v-if="formOpen" id="demand-form" class="section" aria-labelledby="demand-form-title">
      <h2 id="demand-form-title" class="section__title">录入需求</h2>
      <form class="form-grid" @submit.prevent="create.run()">
        <label class="field form-grid__wide">
          <span class="field__label">标题</span>
          <TxInput v-model="draftTitle" placeholder="一句话说明要做什么" />
          <span v-if="draftTitle.length > 200" class="field__error">标题最多 200 个字符。</span>
        </label>
        <label class="field form-grid__wide">
          <span class="field__label">描述</span>
          <TxTextarea v-model="draftBody" :rows="6" :max-length="20000" show-count placeholder="背景、期望结果、验收方式" />
        </label>
        <label class="field">
          <span class="field__label">关联项目</span>
          <ProjectPicker v-model="draftProject" none-label="暂不关联（之后在详情里关联）" />
        </label>
        <div class="actions form-grid__wide">
          <TxButton variant="primary" native-type="submit" :loading="create.pending.value" :disabled="!titleValid">录入</TxButton>
          <TxButton variant="ghost" @click="formOpen = false">取消</TxButton>
        </div>
        <p v-if="create.error.value" class="field__error form-grid__wide" role="alert">{{ create.error.value.message }}</p>
      </form>
    </section>

    <div class="toolbar" role="search" aria-label="筛选需求">
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
      subject="需求列表"
      :empty-title="status || projectId ? '没有符合筛选的需求' : '还没有需求'"
      :empty-description="status || projectId ? '换个状态或项目再试。' : '点「录入需求」在后台录入，或在「渠道连接」里配置飞书、签名 Webhook 入站。'"
      @retry="list.reload"
    >
      <TxDataTable :columns="columns" :data="[...list.items.value]" row-key="id" scroll-x empty-text="这一页没有需求">
        <template #cell-title="{ row }">
          <RouterLink class="link" :to="`/demands/${encodeURIComponent(row.id)}`">{{ row.title }}</RouterLink>
        </template>
        <template #cell-project="{ row }">
          <RouterLink v-if="row.project_id" class="link" :to="`/projects/${encodeURIComponent(row.project_id)}`">{{ projectName(row.project_id) }}</RouterLink>
          <TxStatusBadge v-else text="未关联项目" status="warning" size="sm" />
        </template>
        <template #cell-source="{ row }">{{ DEMAND_SOURCE_LABELS[row.source as DemandRecord["source"]] }}</template>
        <template #cell-status="{ row }">
          <TxStatusBadge :text="DEMAND_STATUS_LABELS[row.status as DemandStatus].label" :status="DEMAND_STATUS_LABELS[row.status as DemandStatus].tone" size="sm" />
        </template>
        <template #cell-created_at="{ row }">{{ formatTime(row.created_at) }}</template>
      </TxDataTable>
      <CursorPager :list="list" label="需求列表分页" />
    </StateView>
  </section>
</template>
