<script setup lang="ts">
/**
 * 一个任务类型的模型池：按先后顺序尝试的模型与思考档位（1 到 8 项）。
 * 拖拽或键盘（空格拿起、方向键移动、空格放下）重排，也可以用「上移 / 下移」按钮；保存时 PATCH 带 If-Match。
 * 模型与档位只能从 catalog 文件里选；catalog 里已经没有的模型标出来，保存会被服务端拒绝。
 */
import { computed, ref, watch } from "vue";
import type { CatalogModel, ModelPool, ModelPoolEntry } from "@geek-bot/protocol";
import { TxButton } from "@talex-touch/tuffex/button";
import { TxSelect, type TxSelectModelValue } from "@talex-touch/tuffex/select";
import { TxSortableList } from "@talex-touch/tuffex/sortable-list";
import { TxStatusBadge } from "@talex-touch/tuffex/status-badge";
import { etagOf } from "../lib/api.js";
import { TASK_KIND_LABELS } from "../lib/labels.js";
import { useConsoleContext } from "./context.js";
import { useAction } from "./use-action.js";

const props = defineProps<{ pool: ModelPool; models: readonly CatalogModel[]; disabled: boolean }>();
const emit = defineEmits<{ saved: [pool: ModelPool] }>();

const MAX_ENTRIES = 8;
interface DraftEntry {
  id: string;
  model: string;
  effort: string;
}

const { api } = useConsoleContext();
let counter = 0;
const draft = ref<DraftEntry[]>([]);

function fromPool(entries: readonly ModelPoolEntry[]): DraftEntry[] {
  return entries.map(entry => ({ id: `entry-${++counter}`, model: entry.model, effort: entry.effort }));
}
watch(
  () => props.pool,
  pool => {
    draft.value = fromPool(pool.entries);
  },
  { immediate: true },
);

const modelOptions = computed(() => props.models.map(model => ({ value: model.id, label: model.name, description: model.id })));
const byId = computed(() => new Map(props.models.map(model => [model.id, model])));

/** 没有档位的模型只接受 off（API.md A-47）。 */
function effortsOf(modelId: string): readonly string[] {
  const efforts = byId.value.get(modelId)?.efforts ?? [];
  return efforts.length ? efforts : ["off"];
}

const dirty = computed(
  () =>
    draft.value.length !== props.pool.entries.length ||
    draft.value.some((entry, index) => entry.model !== props.pool.entries[index]?.model || entry.effort !== props.pool.entries[index]?.effort),
);
const problems = computed(() => {
  if (draft.value.length === 0) return "至少保留一个模型。";
  if (draft.value.some(entry => !byId.value.has(entry.model))) return "有模型已经不在 catalog 里，换成 catalog 里的模型再保存。";
  if (draft.value.some(entry => !effortsOf(entry.model).includes(entry.effort))) return "有档位不被所选模型支持。";
  return "";
});

function setModel(entry: DraftEntry, value: TxSelectModelValue) {
  if (typeof value !== "string") return;
  entry.model = value;
  const efforts = effortsOf(value);
  if (!efforts.includes(entry.effort)) entry.effort = efforts[0];
}
function setEffort(entry: DraftEntry, value: TxSelectModelValue) {
  if (typeof value === "string") entry.effort = value;
}
function move(index: number, offset: -1 | 1) {
  const target = index + offset;
  if (target < 0 || target >= draft.value.length) return;
  const next = [...draft.value];
  [next[index], next[target]] = [next[target], next[index]];
  draft.value = next;
}
function remove(index: number) {
  draft.value = draft.value.filter((_, position) => position !== index);
}
function add() {
  const first = props.models[0];
  if (!first || draft.value.length >= MAX_ENTRIES) return;
  draft.value = [...draft.value, { id: `entry-${++counter}`, model: first.id, effort: effortsOf(first.id)[0] }];
}

const save = useAction(
  async () => {
    const entries = draft.value.map(entry => ({ model: entry.model, effort: entry.effort }));
    const next = await api.send<ModelPool>("PATCH", `/api/v1/model-pools/${encodeURIComponent(props.pool.kind)}`, {
      body: { entries },
      ifMatch: etagOf(props.pool.revision),
    });
    emit("saved", next);
    return next;
  },
  { name: `保存「${TASK_KIND_LABELS[props.pool.kind]}」模型池`, success: () => `「${TASK_KIND_LABELS[props.pool.kind]}」模型池已保存` },
);

const sortLabels = {
  grabbed: "已拿起 {item}，当前第 {position} 位，共 {size} 位；方向键移动，空格放下，Esc 取消",
  moved: "{item} 移到第 {position} 位",
  dropped: "{item} 放在第 {position} 位",
  cancelled: "已取消，{item} 回到原位",
  handle: "拖动 {item}",
};
function itemLabel(entry: DraftEntry) {
  return `${byId.value.get(entry.model)?.name ?? entry.model}（${entry.effort}）`;
}
</script>

<template>
  <section class="section" :aria-labelledby="`pool-${pool.kind}`">
    <div class="section__head">
      <h2 :id="`pool-${pool.kind}`" class="section__title">{{ TASK_KIND_LABELS[pool.kind] }}</h2>
      <span class="mono pool-revision">版本 {{ pool.revision }}</span>
    </div>
    <p class="section__hint">任务按顺序尝试，前一个模型不可用时换下一个。最多 {{ MAX_ENTRIES }} 个。</p>

    <TxSortableList
      v-model="draft"
      handle
      :disabled="disabled"
      :aria-label="`${TASK_KIND_LABELS[pool.kind]}模型池顺序`"
      :item-label="itemLabel"
      :labels="sortLabels"
    >
      <template #item="{ item, index, handleAttrs }">
        <div class="pool-row">
          <!-- 拖拽手柄只服务指针；键盘重排在列表项本身上（Tab 进入后空格拿起），所以手柄不占 Tab 停靠点。 -->
          <span class="pool-row__handle" v-bind="handleAttrs" aria-hidden="true">
            <i class="i-carbon-draggable" />
          </span>
          <span class="pool-row__index">{{ index + 1 }}</span>
          <label class="field pool-row__model">
            <span class="visually-hidden">第 {{ index + 1 }} 个模型</span>
            <TxSelect :model-value="item.model" :options="modelOptions" :disabled="disabled" placeholder="选择模型" @update:model-value="value => setModel(item, value)" />
          </label>
          <label class="field pool-row__effort">
            <span class="visually-hidden">第 {{ index + 1 }} 个模型的思考档位</span>
            <TxSelect
              :model-value="item.effort"
              :options="effortsOf(item.model).map(effort => ({ value: effort, label: effort }))"
              :disabled="disabled"
              @update:model-value="value => setEffort(item, value)"
            />
          </label>
          <TxStatusBadge v-if="!byId.has(item.model)" text="不在 catalog" status="danger" size="sm" />
          <div class="actions pool-row__actions">
            <TxButton variant="ghost" size="sm" icon="i-carbon-arrow-up" :disabled="disabled || index === 0" @click="move(index, -1)">上移</TxButton>
            <TxButton variant="ghost" size="sm" icon="i-carbon-arrow-down" :disabled="disabled || index === draft.length - 1" @click="move(index, 1)">下移</TxButton>
            <TxButton variant="ghost" size="sm" icon="i-carbon-trash-can" :disabled="disabled || draft.length <= 1" @click="remove(index)">移除</TxButton>
          </div>
        </div>
      </template>
    </TxSortableList>

    <p v-if="problems" class="field__error" role="alert">{{ problems }}</p>
    <div class="actions">
      <TxButton variant="secondary" icon="i-carbon-add" :disabled="disabled || draft.length >= MAX_ENTRIES || models.length === 0" @click="add">添加模型</TxButton>
      <TxButton variant="primary" :loading="save.pending.value" :disabled="disabled || !dirty || problems !== ''" @click="save.run()">保存顺序与档位</TxButton>
      <TxButton variant="ghost" :disabled="disabled || !dirty" @click="draft = fromPool(pool.entries)">还原</TxButton>
    </div>
  </section>
</template>

<style scoped>
.pool-revision {
  color: var(--tx-text-color-regular);
}

.pool-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  padding: 8px 0;
  border-bottom: 1px solid var(--tx-border-color-lighter);
}

.pool-row__handle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--tx-border-color-light);
  border-radius: var(--tx-border-radius-base);
  background: var(--tx-bg-color);
  color: var(--tx-text-color-regular);
  cursor: grab;
}

.pool-row__index {
  min-width: 2ch;
  font-variant-numeric: tabular-nums;
  color: var(--tx-text-color-regular);
}

.pool-row__model {
  flex: 2 1 220px;
}

.pool-row__effort {
  flex: 1 1 120px;
}

.pool-row__actions {
  margin-left: auto;
}
</style>
