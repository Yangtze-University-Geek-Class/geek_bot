<script setup lang="ts">
import { useRouter } from "vue-router";
import { TxEmptyState } from "@talex-touch/tuffex/empty-state";
import { DEFAULT_PAGE } from "../shell/pages.js";

const router = useRouter();
</script>

<template>
  <section class="not-found" aria-labelledby="page-title-not-found">
    <h1 id="page-title-not-found" class="not-found__title">页面不存在</h1>
    <div role="status">
      <TxEmptyState
        variant="search-empty"
        title="没有这个页面"
        description="地址可能输错了，或者这个页面还没有上线。"
        :primary-action="{ label: `回到${DEFAULT_PAGE.label}`, variant: 'secondary' }"
        @primary="router.push(DEFAULT_PAGE.path)"
      />
    </div>
  </section>
</template>

<style scoped>
.not-found__title {
  margin: 0 0 8px;
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--tx-text-color-primary);
}
</style>
