<script setup lang="ts">
/**
 * 危险或有外部后果的操作先确认（DESIGN「硬性规则」）：TxModal，打开后初始焦点在「取消」上；
 * 不监听 Enter 直接确认，Esc、遮罩和「取消」都关闭，关闭后焦点回到触发按钮（TxModal 负责恢复）。
 * 确认按钮执行传入的异步动作；进行中禁用两个按钮，失败时弹层保持打开，错误写在弹层里。
 */
import { nextTick, ref, watch } from "vue";
import { TxButton } from "@talex-touch/tuffex/button";
import { TxModal } from "@talex-touch/tuffex/modal";
import { describeError, type ApiError } from "../lib/api.js";

const props = withDefaults(
  defineProps<{
    title: string;
    confirmLabel: string;
    /** 确认按钮的色调：danger 用于不可撤销或影响执行的动作。 */
    tone?: "danger" | "primary";
    pending?: boolean;
    error?: ApiError | null;
  }>(),
  { tone: "danger", pending: false, error: null },
);

const open = defineModel<boolean>({ required: true });
const emit = defineEmits<{ confirm: [] }>();
const body = ref<HTMLElement | null>(null);

/**
 * TxModal 打开后在下一拍把焦点放到对话框本身；再晚一拍把焦点移到「取消」。
 * 它自带的关闭按钮的可访问名是英文，这里换成中文。
 */
watch(open, async visible => {
  if (!visible) return;
  await nextTick();
  await nextTick();
  const dialog = body.value?.closest<HTMLElement>("[role='dialog']");
  dialog?.querySelector<HTMLButtonElement>(".tx-modal__close")?.setAttribute("aria-label", "关闭对话框");
  dialog?.querySelector<HTMLButtonElement>("[data-confirm-cancel] button, button[data-confirm-cancel]")?.focus();
});

function cancel() {
  if (!props.pending) open.value = false;
}
</script>

<template>
  <TxModal v-model="open" :title="title" width="min(92vw, 480px)">
    <div ref="body" class="confirm">
      <slot />
      <p v-if="error" class="confirm__error" role="alert">{{ error.message }}（{{ describeError(error) }}）</p>
    </div>
    <template #footer>
      <div class="confirm__actions">
        <TxButton data-confirm-cancel variant="secondary" :disabled="pending" @click="cancel">取消</TxButton>
        <TxButton :variant="tone" :loading="pending" :disabled="pending" @click="emit('confirm')">{{ confirmLabel }}</TxButton>
      </div>
    </template>
  </TxModal>
</template>

<style scoped>
.confirm {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 0.875rem;
  line-height: 1.6;
  color: var(--tx-text-color-primary);
  overflow-wrap: anywhere;
}

.confirm :deep(p) {
  margin: 0;
}

.confirm__error {
  color: var(--tx-color-danger);
}

.confirm__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}
</style>
