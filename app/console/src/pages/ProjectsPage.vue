<script setup lang="ts">
/**
 * 项目列表（`GET /api/v1/projects`）：渠道连接发现的代码平台项目（GitHub 仓库、GitLab 项目）。
 * 按连接与关键词筛选，筛选与游标写在地址栏里。开关、写入模式、机器分配在项目详情里改。
 */
import { computed, ref, watch } from "vue";
import { useRoute } from "vue-router";
import type { ProjectRecord } from "@geek-bot/protocol";
import { TxButton } from "@talex-touch/tuffex/button";
import { TxDataTable } from "@talex-touch/tuffex/data-table";
import { TxInput } from "@talex-touch/tuffex/input";
import { TxSelect, type TxSelectModelValue } from "@talex-touch/tuffex/select";
import { TxStatusBadge } from "@talex-touch/tuffex/status-badge";
import CursorPager from "../components/CursorPager.vue";
import StateView from "../components/StateView.vue";
import { useConnectionDirectory } from "../components/use-connections.js";
import { queryText, useCursorList, useQueryFilters } from "../components/use-data.js";
import { formatTime } from "../lib/format.js";
import { PROJECT_STATUS_LABELS, WRITE_MODE_LABELS } from "../lib/labels.js";

const route = useRoute();
const setFilters = useQueryFilters();
const directory = useConnectionDirectory();

const connectionId = computed(() => queryText(route.query.connection_id));
const search = computed(() => queryText(route.query.search));
const searchDraft = ref(search.value);
watch(search, value => {
  searchDraft.value = value;
});

const list = useCursorList<ProjectRecord>({
  path: () => "/api/v1/projects",
  filters: () => ({ connection_id: connectionId.value, search: search.value }),
});

const connectionOptions = computed(() => [
  { value: "", label: "全部连接" },
  ...directory.connections.value.filter(connection => connection.provider === "github" || connection.provider === "gitlab").map(connection => ({ value: connection.id, label: directory.nameOf(connection.id) })),
]);

const columns = [
  { key: "name", title: "项目" },
  { key: "connection", title: "连接" },
  { key: "status", title: "状态" },
  { key: "enabled", title: "执行" },
  { key: "write_mode", title: "写入" },
  { key: "machines", title: "机器" },
  { key: "updated_at", title: "更新时间" },
];

function onConnection(value: TxSelectModelValue) {
  setFilters({ connection_id: typeof value === "string" ? value : "" });
}
</script>

<template>
  <section class="page" aria-labelledby="page-title-projects">
    <div class="page-header">
      <div class="page-header__text">
        <h1 id="page-title-projects" class="page-title">项目</h1>
        <p class="page-lede">渠道连接按账号的实际权限发现的项目。新项目默认不执行任何任务、不写入；在详情里打开执行、选择写入模式，并可限定使用哪些机器。</p>
      </div>
    </div>

    <form class="toolbar" role="search" aria-label="筛选项目" @submit.prevent="setFilters({ search: searchDraft.trim() })">
      <label class="field">
        <span class="field__label">连接</span>
        <TxSelect :model-value="connectionId" :options="connectionOptions" placeholder="全部连接" @update:model-value="onConnection" />
      </label>
      <label class="field">
        <span class="field__label">名称或路径</span>
        <TxInput v-model="searchDraft" clearable placeholder="例如 sample-repo" @clear="setFilters({ search: '' })" />
      </label>
      <TxButton variant="secondary" native-type="submit" icon="i-carbon-search">筛选</TxButton>
    </form>

    <StateView
      :state="list.state.value"
      subject="项目列表"
      :empty-title="connectionId || search ? '没有符合筛选的项目' : '还没有发现项目'"
      :empty-description="connectionId || search ? '换个连接或关键词再试。' : '先在「渠道连接」里添加 GitHub 或 GitLab 连接并执行发现，账号能访问的项目会列在这里。'"
      @retry="list.reload"
    >
      <template #empty>
        <RouterLink v-if="!connectionId && !search" class="link" to="/connections">去配置渠道连接</RouterLink>
      </template>
      <TxDataTable :columns="columns" :data="[...list.items.value]" row-key="id" scroll-x empty-text="这一页没有项目">
        <template #cell-name="{ row }">
          <RouterLink class="link" :to="`/projects/${encodeURIComponent(row.id)}`">{{ row.name }}</RouterLink>
          <div class="mono cell-sub">{{ row.path }}</div>
        </template>
        <template #cell-connection="{ row }">{{ directory.nameOf(row.connection_id) }}</template>
        <template #cell-status="{ row }">
          <TxStatusBadge v-if="row.archived" text="已归档" status="muted" size="sm" />
          <TxStatusBadge v-else :text="PROJECT_STATUS_LABELS[row.status as ProjectRecord['status']].label" :status="PROJECT_STATUS_LABELS[row.status as ProjectRecord['status']].tone" size="sm" />
        </template>
        <template #cell-enabled="{ row }">
          <TxStatusBadge :text="row.enabled ? '已开启' : '未开启'" :status="row.enabled ? 'success' : 'muted'" size="sm" />
        </template>
        <template #cell-write_mode="{ row }">
          <TxStatusBadge :text="WRITE_MODE_LABELS[row.write_mode as ProjectRecord['write_mode']].label" :status="WRITE_MODE_LABELS[row.write_mode as ProjectRecord['write_mode']].tone" size="sm" />
        </template>
        <template #cell-machines="{ row }">{{ row.machine_ids.length === 0 ? "全局机器池" : `${row.machine_ids.length} 台指定机器` }}</template>
        <template #cell-updated_at="{ row }">{{ formatTime(row.updated_at) }}</template>
      </TxDataTable>
      <CursorPager :list="list" label="项目列表分页" />
    </StateView>
  </section>
</template>

<style scoped>
.cell-sub {
  margin-top: 2px;
  color: var(--tx-text-color-regular);
  overflow-wrap: anywhere;
}
</style>
