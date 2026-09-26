<script setup lang="ts">
/**
 * 通用的数据页：读取这一页的后台 API，按结果显示对应状态。
 * 各业务页面的列表与操作由对应 issue 实现；在那之前成功时只说明取到了多少数据，不编造内容。
 */
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { ConsolePage } from "../shell/pages.js";
import { stateFromData, stateFromError, type PageState } from "../lib/page-state.js";
import { useConsoleContext } from "./context.js";
import StateView from "./StateView.vue";

const props = defineProps<{ page: ConsolePage }>();

const { api, sampleMode } = useConsoleContext();
/** 数据来源：样板数据模式下不能说成控制面返回的数据（DESIGN「硬性规则」）。 */
const source = sampleMode ? "样板数据" : "控制面";
const state = ref<PageState<unknown>>({ kind: "loading" });
let controller: AbortController | null = null;

async function load() {
  controller?.abort();
  const current = new AbortController();
  controller = current;
  state.value = { kind: "loading" };
  try {
    const data = await api.get<unknown>(props.page.endpoint, { signal: current.signal });
    if (!current.signal.aborted) state.value = stateFromData(data);
  } catch (error) {
    if (!current.signal.aborted) state.value = stateFromError(error);
  }
}

const readyDescription = computed(() => {
  const data = state.value.kind === "ready" ? state.value.data : null;
  const items = typeof data === "object" && data !== null && "items" in data ? (data as { items: unknown }).items : null;
  const received = Array.isArray(items) ? `${source}返回了 ${items.length} 条记录` : `${source}已返回数据`;
  return `${received}；这一页的列表与操作还在开发中。`;
});

watch(() => props.page.endpoint, load, { immediate: true });
onBeforeUnmount(() => controller?.abort());
</script>

<template>
  <section class="resource-page" :aria-labelledby="`page-title-${page.name}`">
    <h1 :id="`page-title-${page.name}`" class="resource-page__title">{{ page.label }}</h1>
    <StateView
      :state="state"
      :source="source"
      :empty-title="page.emptyTitle"
      :empty-description="page.emptyDescription"
      :ready-title="`${page.label}：数据已就绪`"
      :ready-description="readyDescription"
      @retry="load"
    />
  </section>
</template>

<style scoped>
.resource-page {
  min-width: 0;
}

.resource-page__title {
  margin: 0 0 8px;
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--tx-text-color-primary);
}
</style>
