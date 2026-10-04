<script setup lang="ts">
/**
 * 机器详情（`GET/PATCH /api/v1/machines/:id`、`POST /:id/{cordon,uncordon,drain,reset-token}`）。
 * - 停止派发（cordon）与排空（drain）先确认；恢复派发直接执行。状态切换按目标状态幂等。
 * - 重置令牌：旧令牌立即失效、租约收回，新令牌只显示这一次；需要所有者并可能要求重新认证。
 * - 属性更新带 If-Match。
 */
import { computed, ref, watch } from "vue";
import type { MachineRecord, MachineSecretResponse } from "@geek-bot/protocol";
import { TxAlert } from "@talex-touch/tuffex/alert";
import { TxButton } from "@talex-touch/tuffex/button";
import { TxInput } from "@talex-touch/tuffex/input";
import { TxNumberInput } from "@talex-touch/tuffex/number-input";
import { TxProgressBar } from "@talex-touch/tuffex/progress-bar";
import { TxSelect } from "@talex-touch/tuffex/select";
import { TxStatusBadge } from "@talex-touch/tuffex/status-badge";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import NodeTokenNotice from "../components/NodeTokenNotice.vue";
import StateView from "../components/StateView.vue";
import { useConsoleContext } from "../components/context.js";
import { useAction } from "../components/use-action.js";
import { useRecord } from "../components/use-data.js";
import { newIdempotencyKey } from "../lib/api.js";
import { formatMemory, formatTime } from "../lib/format.js";
import { MACHINE_STATUS_LABELS, TRUST_LABELS } from "../lib/labels.js";

const props = defineProps<{ id: string }>();

const { api, session } = useConsoleContext();
const machinePath = computed(() => `/api/v1/machines/${encodeURIComponent(props.id)}`);
const record = useRecord<MachineRecord>(() => machinePath.value);
const machine = record.data;
const canOperate = computed(() => session.allows("operator"));
const isOwner = computed(() => session.allows("owner"));

function percent(used: number, total: number): number {
  return total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
}

const usage = computed(() => {
  const value = machine.value;
  if (!value) return [];
  return [
    { key: "cpu", label: "CPU", text: `${value.used.cpu} / ${value.capacity.cpu} 核`, percentage: percent(value.used.cpu, value.capacity.cpu) },
    { key: "memory", label: "内存", text: `${formatMemory(value.used.memory_mib)} / ${formatMemory(value.capacity.memory_mib)}`, percentage: percent(value.used.memory_mib, value.capacity.memory_mib) },
    { key: "sandbox", label: "sandbox 槽位", text: `${value.used.sandbox} / ${value.slots.sandbox}`, percentage: percent(value.used.sandbox, value.slots.sandbox) },
    { key: "vm", label: "VM 槽位", text: `${value.used.vm} / ${value.slots.vm}`, percentage: percent(value.used.vm, value.slots.vm) },
  ];
});

// 状态切换。
type Transition = "cordon" | "uncordon" | "drain";
const TRANSITION_NAMES: Readonly<Record<Transition, string>> = { cordon: "停止派发", uncordon: "恢复派发", drain: "排空" };
const transition = useAction(
  async (action: Transition) => {
    const next = await api.send<MachineRecord>("POST", `${machinePath.value}/${action}`);
    record.replace(next);
    return { action, next };
  },
  { name: "切换机器状态", success: ({ action, next }) => `${TRANSITION_NAMES[action]}：机器现在是「${MACHINE_STATUS_LABELS[next.status].label}」` },
);
const pendingConfirm = ref<Transition | null>(null);
const confirmOpen = computed({
  get: () => pendingConfirm.value !== null,
  set: open => {
    if (!open) pendingConfirm.value = null;
  },
});
async function confirmTransition() {
  if (!pendingConfirm.value) return;
  const result = await transition.run(pendingConfirm.value);
  if (result) pendingConfirm.value = null;
}

// 重置令牌。
const resetOpen = ref(false);
const issued = ref<MachineSecretResponse | null>(null);
let resetKey = newIdempotencyKey();
const resetToken = useAction(
  async () => {
    const result = await api.send<MachineSecretResponse>("POST", `${machinePath.value}/reset-token`, { idempotencyKey: resetKey });
    resetKey = newIdempotencyKey();
    issued.value = result;
    record.replace(result.machine);
    resetOpen.value = false;
    return result;
  },
  { name: "重置节点令牌", success: () => "旧令牌已失效，新令牌只显示这一次" },
);

// 编辑属性。
const editName = ref("");
const editTrust = ref<"standard" | "high">("standard");
const editTags = ref("");
const editSandbox = ref<number | null>(0);
const editVm = ref<number | null>(0);
const editCpu = ref<number | null>(1);
const editMemory = ref<number | null>(128);
function resetDraft(value: MachineRecord | null) {
  if (!value) return;
  editName.value = value.name;
  editTrust.value = value.trust;
  editTags.value = value.tags.join(", ");
  editSandbox.value = value.slots.sandbox;
  editVm.value = value.slots.vm;
  editCpu.value = value.capacity.cpu;
  editMemory.value = value.capacity.memory_mib;
}
watch(machine, resetDraft, { immediate: true });

const TRUST_OPTIONS = [
  { value: "standard", label: TRUST_LABELS.standard },
  { value: "high", label: TRUST_LABELS.high },
];

const save = useAction(
  async () => {
    const body = {
      name: editName.value.trim(),
      trust: editTrust.value,
      tags: [...new Set(editTags.value.split(/[,，\s]+/).map(tag => tag.trim()).filter(Boolean))],
      slots: { sandbox: editSandbox.value ?? 0, vm: editVm.value ?? 0 },
      capacity: { cpu: editCpu.value ?? 1, memory_mib: editMemory.value ?? 128 },
    };
    const next = await api.send<MachineRecord>("PATCH", machinePath.value, { body, ifMatch: record.etag.value });
    record.replace(next);
    return next;
  },
  { name: "保存机器属性", success: () => "机器属性已保存" },
);
const editValid = computed(
  () => editName.value.trim().length > 0 && editName.value.trim().length <= 64 && editSandbox.value !== null && editVm.value !== null && editCpu.value !== null && editMemory.value !== null,
);
</script>

<template>
  <section class="page" aria-labelledby="page-title-machine">
    <StateView :state="record.state.value" subject="机器" @retry="record.reload">
      <template v-if="machine">
        <div class="page-header">
          <div class="page-header__text">
            <RouterLink class="page-header__back" to="/machines">返回机器列表</RouterLink>
            <h1 id="page-title-machine" class="page-title">{{ machine.name }}</h1>
            <p class="page-lede mono">{{ machine.id }}</p>
          </div>
          <div class="actions">
            <TxStatusBadge :text="MACHINE_STATUS_LABELS[machine.status].label" :status="MACHINE_STATUS_LABELS[machine.status].tone" />
            <TxButton v-if="machine.status === 'ready'" variant="secondary" icon="i-carbon-pause" :disabled="!canOperate" @click="pendingConfirm = 'cordon'">停止派发</TxButton>
            <TxButton
              v-if="machine.status === 'cordoned' || machine.status === 'draining'"
              variant="secondary"
              icon="i-carbon-play"
              :loading="transition.pending.value"
              :disabled="!canOperate"
              @click="transition.run('uncordon')"
            >
              恢复派发
            </TxButton>
            <TxButton v-if="machine.status === 'ready' || machine.status === 'cordoned'" variant="secondary" icon="i-carbon-stop" :disabled="!canOperate" @click="pendingConfirm = 'drain'">排空</TxButton>
            <TxButton variant="danger" icon="i-carbon-password" :disabled="!isOwner" @click="resetOpen = true">重置节点令牌</TxButton>
          </div>
        </div>

        <NodeTokenNotice v-if="issued" :machine-name="issued.machine.name" :token="issued.node_token" @dismiss="issued = null" />
        <TxAlert v-if="machine.status === 'pending'" type="info" title="等待节点第一次心跳" message="在节点主机上配置节点令牌并启动节点；第一次心跳后机器进入停止派发状态，确认无误后恢复派发。" :closable="false" />
        <TxAlert v-if="machine.status === 'offline'" type="error" title="机器离线" message="控制面没有按时收到心跳；它持有的租约到期后任务会重新排队。" :closable="false" />

        <dl class="meta-list section">
          <div><dt>信任级别</dt><dd>{{ TRUST_LABELS[machine.trust] }}</dd></div>
          <div><dt>标签</dt><dd>{{ machine.tags.length ? machine.tags.join("、") : "没有" }}</dd></div>
          <div><dt>最近心跳</dt><dd>{{ formatTime(machine.last_seen_at) }}</dd></div>
          <div><dt>属性版本</dt><dd class="mono">{{ machine.revision }}</dd></div>
        </dl>

        <section class="section" aria-labelledby="usage-title">
          <h2 id="usage-title" class="section__title">资源占用</h2>
          <div class="usage">
            <TxProgressBar
              v-for="row in usage"
              :key="row.key"
              :percentage="row.percentage"
              :message="row.label"
              :detail="row.text"
              text-placement="top"
              :status="row.percentage >= 90 ? 'warning' : ''"
              height="6px"
            />
          </div>
        </section>

        <section class="section" aria-labelledby="edit-machine-title">
          <h2 id="edit-machine-title" class="section__title">属性与上限</h2>
          <p class="section__hint">槽位与资源是控制面分配给这台机器的上限；调高信任级别后它可以接私有项目的任务，需要所有者。</p>
          <form class="form-grid" @submit.prevent="save.run()">
            <label class="field">
              <span class="field__label">名称</span>
              <TxInput v-model="editName" :disabled="!isOwner" />
            </label>
            <label class="field">
              <span class="field__label">信任级别</span>
              <TxSelect :model-value="editTrust" :options="TRUST_OPTIONS" :disabled="!isOwner" @update:model-value="value => (editTrust = value === 'high' ? 'high' : 'standard')" />
            </label>
            <label class="field">
              <span class="field__label">标签</span>
              <TxInput v-model="editTags" :disabled="!isOwner" />
            </label>
            <label class="field">
              <span class="field__label">sandbox 槽位</span>
              <TxNumberInput v-model="editSandbox" :min="0" :max="256" :precision="0" :disabled="!isOwner" decrease-label="减少 sandbox 槽位" increase-label="增加 sandbox 槽位" />
            </label>
            <label class="field">
              <span class="field__label">VM 槽位</span>
              <TxNumberInput v-model="editVm" :min="0" :max="256" :precision="0" :disabled="!isOwner" decrease-label="减少 VM 槽位" increase-label="增加 VM 槽位" />
            </label>
            <label class="field">
              <span class="field__label">CPU 上限（核）</span>
              <TxNumberInput v-model="editCpu" :min="1" :max="256" :precision="0" :disabled="!isOwner" decrease-label="减少 CPU" increase-label="增加 CPU" />
            </label>
            <label class="field">
              <span class="field__label">内存上限（MiB）</span>
              <TxNumberInput v-model="editMemory" :min="128" :max="1048576" :step="1024" :precision="0" :disabled="!isOwner" decrease-label="减少内存" increase-label="增加内存" />
            </label>
            <div class="actions form-grid__wide">
              <TxButton variant="primary" native-type="submit" :loading="save.pending.value" :disabled="!isOwner || !editValid">保存属性</TxButton>
              <TxButton variant="ghost" :disabled="!isOwner" @click="resetDraft(machine)">还原</TxButton>
            </div>
            <p v-if="save.error.value" class="field__error form-grid__wide" role="alert">{{ save.error.value.message }}</p>
          </form>
        </section>

        <ConfirmDialog
          v-model="confirmOpen"
          :title="pendingConfirm === 'drain' ? '排空这台机器' : '停止向这台机器派发'"
          :confirm-label="pendingConfirm === 'drain' ? '排空' : '停止派发'"
          :pending="transition.pending.value"
          :error="transition.error.value"
          @confirm="confirmTransition"
        >
          <p v-if="pendingConfirm === 'drain'">运行中的任务会做完，之后不再派新任务；排空期间机器仍需保持在线。</p>
          <p v-else>正在运行的任务不受影响，新任务不再派到这台机器，直到恢复派发。</p>
        </ConfirmDialog>

        <ConfirmDialog v-model="resetOpen" title="重置节点令牌" confirm-label="重置令牌" :pending="resetToken.pending.value" :error="resetToken.error.value" @confirm="resetToken.run()">
          <p>旧令牌立即失效，这台机器上的租约全部收回，正在执行的任务会重新排队；机器回到等待首次心跳。</p>
          <p>新令牌只显示这一次，需要换掉节点主机上的令牌文件并重启节点。</p>
        </ConfirmDialog>
      </template>
    </StateView>
  </section>
</template>

<style scoped>
.usage {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
  gap: 16px;
}
</style>
