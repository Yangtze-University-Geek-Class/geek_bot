<script setup lang="ts">
/**
 * 按数据状态显示加载、空、失败、未登录、无权限、离线；成功时渲染默认插槽里的真实内容（DESIGN「状态、表单和导航」）。
 * 全部用 Tuffex 的状态组件；标题与说明都传中文，不用组件自带的英文默认文案。
 * 失败类状态带 `HTTP 状态 · 机器码 · request id`，并用 role=alert 播报；加载与空用 role=status。
 */
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { TxEmptyState } from "@talex-touch/tuffex/empty-state";
import { TxErrorState } from "@talex-touch/tuffex/error-state";
import { TxLoadingState } from "@talex-touch/tuffex/loading-state";
import { TxOfflineState } from "@talex-touch/tuffex/offline-state";
import { TxPermissionState } from "@talex-touch/tuffex/permission-state";
import { describeError } from "../lib/api.js";
import type { PageState } from "../lib/page-state.js";
import { useConsoleContext } from "./context.js";

const props = withDefaults(
  defineProps<{
    state: PageState<unknown>;
    /** 这一块数据的称呼，用在加载说明里，例如「项目列表」。 */
    subject: string;
    emptyTitle?: string;
    emptyDescription?: string;
  }>(),
  { emptyTitle: "还没有数据", emptyDescription: "" },
);

const emit = defineEmits<{ retry: [] }>();

const { sampleMode } = useConsoleContext();
const route = useRoute();
const router = useRouter();
const source = sampleMode ? "样板数据" : "控制面";
const detail = computed(() => ("error" in props.state ? describeError(props.state.error) : ""));
const retryAction = { label: "重试", variant: "secondary" as const };
const loginAction = { label: "去登录", variant: "primary" as const };

function goLogin() {
  void router.push({ name: "login", query: { redirect: route.fullPath } });
}
</script>

<template>
  <slot v-if="state.kind === 'ready'" />

  <div v-else class="state-view" :data-state="state.kind">
    <div v-if="state.kind === 'loading'" role="status" aria-live="polite" aria-busy="true">
      <TxLoadingState title="正在加载" :description="`正在从${source}读取${subject}。`" />
    </div>

    <div v-else-if="state.kind === 'empty'" role="status" aria-live="polite">
      <TxEmptyState variant="empty" :title="emptyTitle" :description="emptyDescription">
        <template v-if="$slots.empty" #actions>
          <slot name="empty" />
        </template>
      </TxEmptyState>
    </div>

    <div v-else-if="state.kind === 'offline'" role="alert">
      <TxOfflineState
        title="连不上控制面"
        description="网络断开，或控制面没有响应。恢复后点「重试」。"
        :primary-action="retryAction"
        @primary="emit('retry')"
      />
      <p class="state-view__detail">{{ detail }}</p>
    </div>

    <div v-else-if="state.kind === 'unauthenticated'" role="alert">
      <TxPermissionState title="需要登录" description="还没有登录，或会话已经过期。" :primary-action="loginAction" @primary="goLogin" />
      <p class="state-view__detail">{{ detail }}</p>
    </div>

    <div v-else-if="state.kind === 'forbidden'" role="alert">
      <TxPermissionState
        title="没有权限查看"
        :description="`当前账号的角色不能查看${subject}；需要时请实例的所有者调整你的角色。`"
      />
      <p class="state-view__detail">{{ detail }}</p>
    </div>

    <div v-else-if="state.kind === 'error'" role="alert">
      <TxErrorState
        title="加载失败"
        :description="`${state.error.message}。可以重试；一直失败时把下面这行发给维护者。`"
        :primary-action="retryAction"
        @primary="emit('retry')"
      />
      <p class="state-view__detail">{{ detail }}</p>
    </div>
  </div>
</template>

<style scoped>
.state-view {
  min-width: 0;
  padding: 24px 0;
}

.state-view__detail {
  margin: 8px 0 0;
  text-align: center;
  font-family: var(--tx-bui-font-mono, ui-monospace, monospace);
  font-size: 0.8125rem;
  color: var(--tx-text-color-regular);
  overflow-wrap: anywhere;
}
</style>
