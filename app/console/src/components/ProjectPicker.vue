<script setup lang="ts">
/**
 * 选择项目：TxSelect 的远程搜索，输入时按名称或路径查 `/api/v1/projects?search=`，每次最多 20 条。
 * 已选的项目不在搜索结果里时单独读一次，保证显示的是名称而不是 id。放在 label 元素里取得可访问名称。
 */
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { ApiList, ProjectRecord } from "@geek-bot/protocol";
import { TxSelect, type TxSelectModelValue, type TxSelectOption } from "@talex-touch/tuffex/select";
import { withQuery } from "../lib/api.js";
import { useConsoleContext } from "./context.js";

const props = withDefaults(defineProps<{ noneLabel?: string; disabled?: boolean }>(), { noneLabel: "", disabled: false });
const model = defineModel<string>({ required: true });

const { api } = useConsoleContext();
const results = ref<readonly ProjectRecord[]>([]);
const selected = ref<ProjectRecord | null>(null);
const loading = ref(false);
const failed = ref(false);
let controller: AbortController | null = null;

const options = computed<TxSelectOption[]>(() => {
  const list: TxSelectOption[] = props.noneLabel ? [{ value: "", label: props.noneLabel }] : [];
  const seen = new Set<string>();
  for (const project of selected.value ? [selected.value, ...results.value] : results.value) {
    if (seen.has(project.id)) continue;
    seen.add(project.id);
    list.push({ value: project.id, label: project.name, description: project.path, disabled: project.archived || project.status === "lost" });
  }
  return list;
});

async function search(query: string) {
  controller?.abort();
  const current = new AbortController();
  controller = current;
  loading.value = true;
  try {
    const page = await api.get<ApiList<ProjectRecord>>(withQuery("/api/v1/projects", { search: query.trim(), limit: 20 }), { signal: current.signal });
    if (current.signal.aborted) return;
    results.value = page.items;
    failed.value = false;
  } catch {
    if (!current.signal.aborted) failed.value = true;
  } finally {
    if (!current.signal.aborted) loading.value = false;
  }
}

watch(
  model,
  async id => {
    if (!id || selected.value?.id === id) return;
    const known = results.value.find(project => project.id === id);
    if (known) {
      selected.value = known;
      return;
    }
    try {
      selected.value = await api.get<ProjectRecord>(`/api/v1/projects/${encodeURIComponent(id)}`);
    } catch {
      selected.value = null;
    }
  },
  { immediate: true },
);

function onChange(value: TxSelectModelValue) {
  const id = typeof value === "string" ? value : "";
  selected.value = results.value.find(project => project.id === id) ?? null;
  model.value = id;
}

void search("");
onBeforeUnmount(() => controller?.abort());
</script>

<template>
  <TxSelect
    :model-value="model"
    :options="options"
    remote
    searchable
    :loading="loading"
    loading-text="正在查找项目"
    :empty-text="failed ? '读取项目失败，换个关键词重试' : '没有匹配的项目'"
    placeholder="输入名称或路径搜索项目"
    :disabled="disabled"
    @search="search"
    @update:model-value="onChange"
  />
</template>
