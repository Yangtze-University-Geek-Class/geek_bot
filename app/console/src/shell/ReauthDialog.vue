<script setup lang="ts">
/**
 * 重新认证（API.md「会话与 CSRF」）：高危操作要求 10 分钟内重新认证过。服务端回 403 reauth_required 时，
 * 操作反馈打开这个弹层，走 purpose=reauth 的 device flow（空 scope），完成后刷新会话并让原操作重试一次。
 * 顶栏的「重新认证」按钮也打开它。关闭弹层视为放弃，原操作按失败处理。
 */
import { computed } from "vue";
import { TxModal } from "@talex-touch/tuffex/modal";
import DeviceFlowPanel from "../components/DeviceFlowPanel.vue";
import { useConsoleContext } from "../components/context.js";

const { session } = useConsoleContext();

const open = computed({
  get: () => session.reauthRequest.value !== null,
  set: visible => {
    if (!visible) session.reauthRequest.value?.settle(false);
  },
});

async function finished() {
  await session.load();
  session.reauthRequest.value?.settle(true);
}
</script>

<template>
  <TxModal v-model="open" title="重新认证" width="min(92vw, 520px)">
    <div class="reauth">
      <p class="reauth__text">
        这个操作只允许所有者执行，并且要求 10 分钟内重新认证过。用当前登录的 GitHub 账号完成一次设备授权（不申请任何权限范围），完成后原操作会自动重试一次。
      </p>
      <DeviceFlowPanel v-if="open" purpose="reauth" start-label="用 GitHub 重新认证" @done="finished" @cancel="open = false" />
    </div>
  </TxModal>
</template>

<style scoped>
.reauth {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.reauth__text {
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.6;
  color: var(--tx-text-color-primary);
}
</style>
