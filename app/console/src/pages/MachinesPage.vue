<script setup lang="ts">
/**
 * 机器列表与登记（`GET/POST /api/v1/machines`）。实例只有一个全局共享的机器池；控制面按项目分配、执行器槽位与资源调度任务。
 * 登记返回的节点令牌只出现这一次（MachineSecretResponse），页面显示后由使用者自己保存。
 */
import { computed, ref } from "vue";
import type { MachineRecord, MachineSecretResponse } from "@geek-bot/protocol";
import { TxButton } from "@talex-touch/tuffex/button";
import { TxDataTable } from "@talex-touch/tuffex/data-table";
import { TxInput } from "@talex-touch/tuffex/input";
import { TxNumberInput } from "@talex-touch/tuffex/number-input";
import { TxSelect } from "@talex-touch/tuffex/select";
import { TxStatusBadge } from "@talex-touch/tuffex/status-badge";
import CursorPager from "../components/CursorPager.vue";
import NodeTokenNotice from "../components/NodeTokenNotice.vue";
import StateView from "../components/StateView.vue";
import { useConsoleContext } from "../components/context.js";
import { useAction } from "../components/use-action.js";
import { useCursorList } from "../components/use-data.js";
import { newIdempotencyKey } from "../lib/api.js";
import { formatMemory, formatTime } from "../lib/format.js";
import { MACHINE_STATUS_LABELS, TRUST_LABELS } from "../lib/labels.js";

const { api, session } = useConsoleContext();
const isOwner = computed(() => session.allows("owner"));
const list = useCursorList<MachineRecord>({ path: () => "/api/v1/machines" });

const columns = [
  { key: "name", title: "机器" },
  { key: "status", title: "状态" },
  { key: "trust", title: "信任" },
  { key: "slots", title: "槽位占用" },
  { key: "resources", title: "资源占用" },
  { key: "last_seen_at", title: "最近心跳" },
];

// 登记表单。
const formOpen = ref(false);
const name = ref("");
const trust = ref<"standard" | "high">("standard");
const tags = ref("");
const sandboxSlots = ref<number | null>(2);
const vmSlots = ref<number | null>(1);
const cpu = ref<number | null>(4);
const memory = ref<number | null>(8192);
let idempotencyKey = newIdempotencyKey();
const issued = ref<MachineSecretResponse | null>(null);

const TRUST_OPTIONS = [
  { value: "standard", label: "标准：只接公开项目的任务" },
  { value: "high", label: "高信任：也可以接私有项目的任务" },
];

const formValid = computed(
  () =>
    name.value.trim().length > 0 &&
    name.value.trim().length <= 64 &&
    sandboxSlots.value !== null &&
    vmSlots.value !== null &&
    cpu.value !== null &&
    memory.value !== null &&
    sandboxSlots.value + vmSlots.value > 0,
);

const register = useAction(
  async () => {
    const body = {
      name: name.value.trim(),
      trust: trust.value,
      tags: [...new Set(tags.value.split(/[,，\s]+/).map(tag => tag.trim()).filter(Boolean))],
      slots: { sandbox: sandboxSlots.value ?? 0, vm: vmSlots.value ?? 0 },
      capacity: { cpu: cpu.value ?? 1, memory_mib: memory.value ?? 128 },
    };
    const result = await api.send<MachineSecretResponse>("POST", "/api/v1/machines", { body, idempotencyKey });
    idempotencyKey = newIdempotencyKey();
    issued.value = result;
    formOpen.value = false;
    name.value = "";
    tags.value = "";
    await list.reload();
    return result;
  },
  { name: "登记机器", success: result => `已登记机器「${result.machine.name}」` },
);
</script>

<template>
  <section class="page" aria-labelledby="page-title-machines">
    <div class="page-header">
      <div class="page-header__text">
        <h1 id="page-title-machines" class="page-title">机器</h1>
        <p class="page-lede">全局共享的执行机器。节点只主动连接控制面，不开放入站端口；任务在只读 sandbox 或一次性 VM 里执行，宿主不运行仓库代码。</p>
      </div>
      <div class="actions">
        <TxButton variant="primary" icon="i-carbon-add" :disabled="!isOwner" :aria-expanded="formOpen" aria-controls="machine-form" @click="formOpen = !formOpen">
          {{ formOpen ? "收起登记" : "登记机器" }}
        </TxButton>
      </div>
    </div>

    <NodeTokenNotice v-if="issued" :machine-name="issued.machine.name" :token="issued.node_token" @dismiss="issued = null" />

    <section v-if="formOpen" id="machine-form" class="section" aria-labelledby="machine-form-title">
      <h2 id="machine-form-title" class="section__title">登记机器</h2>
      <p class="section__hint">登记只生成节点令牌；机器在节点第一次心跳后才会接任务。槽位与资源是控制面给这台机器的上限，超过节点自己上报的能力时以较小者为准。登记需要所有者，并可能要求重新认证。</p>
      <form class="form-grid" @submit.prevent="register.run()">
        <label class="field">
          <span class="field__label">名称</span>
          <TxInput v-model="name" placeholder="例如 builder-01" autocomplete="off" />
          <span class="field__hint">在机器列表与任务里显示，最多 64 个字符。</span>
        </label>
        <label class="field">
          <span class="field__label">信任级别</span>
          <TxSelect :model-value="trust" :options="TRUST_OPTIONS" @update:model-value="value => (trust = value === 'high' ? 'high' : 'standard')" />
        </label>
        <label class="field">
          <span class="field__label">标签</span>
          <TxInput v-model="tags" placeholder="用逗号分隔，例如 arm64, kvm" />
        </label>
        <label class="field">
          <span class="field__label">sandbox 槽位</span>
          <TxNumberInput v-model="sandboxSlots" :min="0" :max="256" :step="1" :precision="0" decrease-label="减少 sandbox 槽位" increase-label="增加 sandbox 槽位" />
        </label>
        <label class="field">
          <span class="field__label">VM 槽位</span>
          <TxNumberInput v-model="vmSlots" :min="0" :max="256" :step="1" :precision="0" decrease-label="减少 VM 槽位" increase-label="增加 VM 槽位" />
        </label>
        <label class="field">
          <span class="field__label">CPU 上限（核）</span>
          <TxNumberInput v-model="cpu" :min="1" :max="256" :step="1" :precision="0" decrease-label="减少 CPU" increase-label="增加 CPU" />
        </label>
        <label class="field">
          <span class="field__label">内存上限（MiB）</span>
          <TxNumberInput v-model="memory" :min="128" :max="1048576" :step="1024" :precision="0" decrease-label="减少内存" increase-label="增加内存" />
        </label>
        <div class="actions form-grid__wide">
          <TxButton variant="primary" native-type="submit" :loading="register.pending.value" :disabled="!formValid">登记并生成节点令牌</TxButton>
          <TxButton variant="ghost" @click="formOpen = false">取消</TxButton>
        </div>
        <p v-if="register.error.value" class="field__error form-grid__wide" role="alert">{{ register.error.value.message }}</p>
      </form>
    </section>

    <StateView
      :state="list.state.value"
      subject="机器列表"
      empty-title="还没有机器"
      empty-description="所有者点「登记机器」生成节点令牌，在节点主机上配置令牌并启动节点后，机器会开始接任务。"
      @retry="list.reload"
    >
      <TxDataTable :columns="columns" :data="[...list.items.value]" row-key="id" scroll-x empty-text="这一页没有机器">
        <template #cell-name="{ row }">
          <RouterLink class="link" :to="`/machines/${encodeURIComponent(row.id)}`">{{ row.name }}</RouterLink>
          <div v-if="row.tags.length" class="cell-sub">{{ row.tags.join("、") }}</div>
        </template>
        <template #cell-status="{ row }">
          <TxStatusBadge :text="MACHINE_STATUS_LABELS[row.status as MachineRecord['status']].label" :status="MACHINE_STATUS_LABELS[row.status as MachineRecord['status']].tone" size="sm" />
        </template>
        <template #cell-trust="{ row }">{{ TRUST_LABELS[row.trust as MachineRecord['trust']] }}</template>
        <template #cell-slots="{ row }">sandbox {{ row.used.sandbox }}/{{ row.slots.sandbox }} · VM {{ row.used.vm }}/{{ row.slots.vm }}</template>
        <template #cell-resources="{ row }">CPU {{ row.used.cpu }}/{{ row.capacity.cpu }} · 内存 {{ formatMemory(row.used.memory_mib) }}/{{ formatMemory(row.capacity.memory_mib) }}</template>
        <template #cell-last_seen_at="{ row }">{{ formatTime(row.last_seen_at) }}</template>
      </TxDataTable>
      <CursorPager :list="list" label="机器列表分页" />
    </StateView>
  </section>
</template>

<style scoped>
.cell-sub {
  margin-top: 2px;
  font-size: 0.75rem;
  color: var(--tx-text-color-regular);
}
</style>
