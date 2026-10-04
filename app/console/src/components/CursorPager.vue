<script setup lang="ts">
/**
 * 游标分页：只有「第一页 / 上一页 / 下一页」，没有页码和总数（API 不返回总条数）。
 * 游标写在地址栏里，由 useCursorList 管理；这里只负责按钮与播报。
 */
import { TxButton } from "@talex-touch/tuffex/button";
import type { CursorList } from "./use-data.js";

defineProps<{
  list: Pick<CursorList<unknown>, "hasNext" | "hasPrev" | "next" | "prev" | "first">;
  /** 分页区域的可访问名称，例如「项目列表分页」。 */
  label: string;
}>();
</script>

<template>
  <nav v-if="list.hasPrev.value || list.hasNext.value" class="pager" :aria-label="label">
    <TxButton v-if="list.hasPrev.value" variant="ghost" size="sm" icon="i-carbon-page-first" @click="list.first()">第一页</TxButton>
    <TxButton variant="secondary" size="sm" icon="i-carbon-chevron-left" :disabled="!list.hasPrev.value" @click="list.prev()">上一页</TxButton>
    <TxButton variant="secondary" size="sm" icon="i-carbon-chevron-right" :disabled="!list.hasNext.value" @click="list.next()">下一页</TxButton>
  </nav>
</template>

<style scoped>
.pager {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}
</style>
