<script setup lang="ts">
/**
 * 模型池（`GET /api/v1/model-pools`、`PATCH /api/v1/model-pools/:kind`）。模型目录来自部署者的只读 catalog 文件，
 * 控制面没有模型表；这里只按任务类型排列要用的模型与思考档位。修改需要操作员或所有者。
 */
import { computed, onMounted, ref } from "vue";
import type { ModelPool, ModelPoolsResponse } from "@geek-bot/protocol";
import { TxAlert } from "@talex-touch/tuffex/alert";
import ModelPoolEditor from "../components/ModelPoolEditor.vue";
import StateView from "../components/StateView.vue";
import { useConsoleContext } from "../components/context.js";
import { stateFromError, type PageState } from "../lib/page-state.js";
import { TASK_KIND_VALUES } from "../lib/labels.js";

const { api, session } = useConsoleContext();
const state = ref<PageState<ModelPoolsResponse>>({ kind: "loading" });
const canOperate = computed(() => session.allows("operator"));

async function load() {
  state.value = { kind: "loading" };
  try {
    state.value = { kind: "ready", data: await api.get<ModelPoolsResponse>("/api/v1/model-pools") };
  } catch (error) {
    state.value = stateFromError(error);
  }
}

/** 按任务类型的固定顺序排列；catalog 文件里多出来的池放在后面。 */
const pools = computed(() => {
  if (state.value.kind !== "ready") return [];
  const order = new Map(TASK_KIND_VALUES.map((kind, index) => [kind, index]));
  return [...state.value.data.pools].sort((a, b) => (order.get(a.kind) ?? 99) - (order.get(b.kind) ?? 99));
});

function saved(next: ModelPool) {
  if (state.value.kind !== "ready") return;
  const data = state.value.data;
  state.value = { kind: "ready", data: { ...data, pools: data.pools.map(pool => (pool.kind === next.kind ? next : pool)) } };
}

onMounted(load);
</script>

<template>
  <section class="page" aria-labelledby="page-title-model-pools">
    <div class="page-header">
      <div class="page-header__text">
        <h1 id="page-title-model-pools" class="page-title">模型池</h1>
        <p class="page-lede">每种任务按顺序尝试的模型与思考档位。模型目录来自部署者配置的 catalog 文件；任务只拿到限定在这个池里的短期模型令牌，拿不到网关密钥。</p>
      </div>
    </div>

    <StateView :state="state" subject="模型池" @retry="load">
      <template v-if="state.kind === 'ready'">
        <TxAlert v-if="state.data.catalog.error" type="error" title="catalog 文件读取失败" :closable="false">
          <span class="plain-text">{{ state.data.catalog.error }}</span>
        </TxAlert>
        <TxAlert
          v-else-if="state.data.catalog.models.length === 0"
          type="warning"
          title="catalog 里没有模型"
          message="在控制面的 catalog 文件里登记模型后，才能在这里排列模型池。"
          :closable="false"
        />
        <TxAlert v-if="!canOperate" type="info" title="只读" message="当前角色只能查看模型池；修改需要操作员或所有者。" :closable="false" />
        <ModelPoolEditor
          v-for="pool in pools"
          :key="pool.kind"
          :pool="pool"
          :models="state.data.catalog.models"
          :disabled="!canOperate || state.data.catalog.models.length === 0"
          @saved="saved"
        />
      </template>
    </StateView>
  </section>
</template>
