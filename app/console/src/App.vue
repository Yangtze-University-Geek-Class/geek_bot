<script setup lang="ts">
import AppShell from "./shell/AppShell.vue";
</script>

<template>
  <AppShell />
</template>

<style>
html,
body {
  margin: 0;
  font-family: var(--tx-font-family);
  font-size: 100%;
  background: var(--tx-bg-color-page);
}

*,
*::before,
*::after {
  box-sizing: border-box;
}

/*
 * TxDrawer 关闭时面板只是平移到视口外，面板的阴影会漏进视口左边缘；关闭状态下去掉阴影。
 * 抽屉经 Teleport 挂到 body 下，scoped 样式够不到，所以写在这里。
 */
.tx-drawer:not(.tx-drawer--visible) .tx-drawer__panel {
  box-shadow: none;
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
</style>
