<script setup lang="ts">
/**
 * GitHub OAuth device flow（API.md A-03 / A-04）：向 control 申请 flow，显示用户码与 GitHub 的验证地址，
 * 按 interval_s 轮询（slow_down 时加 5 秒），直到完成、被拒、过期或出错。device_code 只留在 control。
 * 用于认领实例、登录、重新认证，以及给 GitHub 连接绑定账号（purpose=connection）。
 */
import { computed, onBeforeUnmount, ref } from "vue";
import type { DeviceFlowPollResponse, DeviceFlowPurpose, DeviceFlowStartRequest, DeviceFlowStartResponse } from "@geek-bot/protocol";
import { TxAlert } from "@talex-touch/tuffex/alert";
import { TxButton, TxCopyButton } from "@talex-touch/tuffex/button";
import { describeError, toApiError, type ApiError } from "../lib/api.js";
import { useConsoleContext } from "./context.js";

const props = withDefaults(
  defineProps<{
    purpose: DeviceFlowPurpose;
    connectionId?: string;
    startLabel: string;
    disabled?: boolean;
  }>(),
  { connectionId: undefined, disabled: false },
);

const emit = defineEmits<{ done: []; cancel: [] }>();

type Phase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "waiting"; flow: DeviceFlowStartResponse; expiresAt: number }
  | { kind: "done" }
  | { kind: "ended"; title: string; message: string }
  | { kind: "error"; error: ApiError };

const { api } = useConsoleContext();
const phase = ref<Phase>({ kind: "idle" });
let timer: ReturnType<typeof setTimeout> | null = null;
let interval = 5;

/** 只把 https 地址渲染成链接；control 回传的别的形状按纯文本显示，不当作可点击地址。 */
const verificationHref = computed(() => {
  if (phase.value.kind !== "waiting") return null;
  try {
    const url = new URL(phase.value.flow.verification_uri);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
});

function stopTimer() {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

async function start() {
  stopTimer();
  phase.value = { kind: "starting" };
  const body: DeviceFlowStartRequest = props.connectionId ? { purpose: props.purpose, connection_id: props.connectionId } : { purpose: props.purpose };
  try {
    const flow = await api.send<DeviceFlowStartResponse>("POST", "/api/v1/auth/device", { body });
    interval = Math.max(1, flow.interval_s);
    phase.value = { kind: "waiting", flow, expiresAt: Date.now() + flow.expires_in_s * 1000 };
    schedule();
  } catch (error) {
    phase.value = { kind: "error", error: toApiError(error) };
  }
}

function schedule() {
  stopTimer();
  timer = setTimeout(() => void poll(), interval * 1000);
}

async function poll() {
  const current = phase.value;
  if (current.kind !== "waiting") return;
  if (Date.now() > current.expiresAt) {
    phase.value = { kind: "ended", title: "用户码已过期", message: "没有在有效期内完成授权，重新开始即可。" };
    return;
  }
  try {
    const result = await api.send<DeviceFlowPollResponse>("POST", `/api/v1/auth/device/${encodeURIComponent(current.flow.flow_id)}/poll`);
    if (phase.value !== current) return;
    switch (result.status) {
      case "pending":
        schedule();
        break;
      case "slow_down":
        interval += 5;
        schedule();
        break;
      case "expired":
        phase.value = { kind: "ended", title: "用户码已过期", message: "没有在有效期内完成授权，重新开始即可。" };
        break;
      case "denied":
        phase.value = { kind: "ended", title: "授权被拒绝", message: "GitHub 上选择了拒绝授权；需要时重新开始。" };
        break;
      case "done":
        phase.value = { kind: "done" };
        emit("done");
        break;
    }
  } catch (error) {
    if (phase.value === current) phase.value = { kind: "error", error: toApiError(error) };
  }
}

function cancel() {
  stopTimer();
  phase.value = { kind: "idle" };
  emit("cancel");
}

onBeforeUnmount(stopTimer);
</script>

<template>
  <div class="device-flow">
    <div v-if="phase.kind === 'idle' || phase.kind === 'starting'" class="actions">
      <TxButton variant="primary" icon="i-carbon-logo-github" :loading="phase.kind === 'starting'" :disabled="disabled || phase.kind === 'starting'" @click="start">
        {{ startLabel }}
      </TxButton>
    </div>

    <div v-else-if="phase.kind === 'waiting'" class="device-flow__waiting" role="status" aria-live="polite">
      <p class="device-flow__step">在 GitHub 的设备授权页输入下面的用户码，然后回到这里；页面会自动继续。</p>
      <div class="device-flow__code">
        <code class="device-flow__code-text" aria-label="用户码">{{ phase.flow.user_code }}</code>
        <TxCopyButton :text="phase.flow.user_code" copy-label="复制用户码" copied-label="已复制" size="sm" />
      </div>
      <p class="device-flow__step">
        验证地址：
        <a v-if="verificationHref" class="link mono" :href="verificationHref" target="_blank" rel="noopener noreferrer">{{ phase.flow.verification_uri }}</a>
        <span v-else class="mono">{{ phase.flow.verification_uri }}</span>
      </p>
      <div class="actions">
        <TxButton variant="ghost" size="sm" @click="cancel">放弃这次授权</TxButton>
      </div>
    </div>

    <div v-else-if="phase.kind === 'done'" role="status">
      <TxAlert type="success" title="授权完成" message="GitHub 已确认授权。" :closable="false" />
    </div>

    <div v-else-if="phase.kind === 'ended'" class="device-flow__waiting" role="alert">
      <TxAlert type="warning" :title="phase.title" :message="phase.message" :closable="false" />
      <div class="actions">
        <TxButton variant="primary" icon="i-carbon-renew" @click="start">重新开始</TxButton>
        <TxButton variant="ghost" @click="cancel">取消</TxButton>
      </div>
    </div>

    <div v-else class="device-flow__waiting" role="alert">
      <TxAlert type="error" title="授权没有完成" :closable="false">
        {{ phase.error.message }}（{{ describeError(phase.error) }}）
      </TxAlert>
      <div class="actions">
        <TxButton variant="primary" icon="i-carbon-renew" @click="start">重新开始</TxButton>
        <TxButton variant="ghost" @click="cancel">取消</TxButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
.device-flow,
.device-flow__waiting {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.device-flow__step {
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.6;
  color: var(--tx-text-color-primary);
  overflow-wrap: anywhere;
}

.device-flow__code {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}

.device-flow__code-text {
  padding: 8px 12px;
  border: 1px solid var(--tx-border-color);
  border-radius: var(--tx-border-radius-base);
  background: var(--tx-fill-color-light);
  font-family: var(--tx-bui-font-mono, ui-monospace, monospace);
  font-size: 1.5rem;
  letter-spacing: 0.08em;
  color: var(--tx-text-color-primary);
}
</style>
