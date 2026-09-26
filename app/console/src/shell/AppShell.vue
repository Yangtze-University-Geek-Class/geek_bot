<script setup lang="ts">
/**
 * 后台外壳：宽屏是侧栏导航，窄屏收进左侧抽屉；顶栏标明样板数据模式与当前账号；
 * 断网时顶部显示提示，不把整页换成错误页；页脚显示版本（RELEASES「展示值与发布身份」）。
 */
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { MeResponse, ReleaseInfo } from "@geek-bot/protocol";
import { TxAlert } from "@talex-touch/tuffex/alert";
import { TxButton } from "@talex-touch/tuffex/button";
import { TxDrawer } from "@talex-touch/tuffex/drawer";
import { TxSidebarNav, type SidebarNavItem, type SidebarNavValue } from "@talex-touch/tuffex/sidebar-nav";
import { TxStatusBadge } from "@talex-touch/tuffex/status-badge";
import { useConsoleContext } from "../components/context.js";
import { NARROW_QUERY, useMediaQuery, useOnline } from "../components/use-environment.js";
import { CONSOLE_PAGES, PAGE_GROUPS } from "./pages.js";

/** 后台角色的中文名（ADR-0002）；接口里的机器值不直接显示。 */
const ROLE_LABELS: Readonly<Record<MeResponse["role"], string>> = { owner: "所有者", operator: "操作员", viewer: "只读成员" };

const { api, sampleMode } = useConsoleContext();
const route = useRoute();
const router = useRouter();
const narrow = useMediaQuery(NARROW_QUERY);
const online = useOnline();
const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
const drawerOpen = ref(false);
const me = ref<MeResponse | null>(null);
const release = ref<ReleaseInfo | null>(null);

const navItems: SidebarNavItem[] = CONSOLE_PAGES.map(page => ({ value: page.name, label: page.label, group: page.group, icon: page.icon }));
const navGroups = PAGE_GROUPS.map(group => ({ key: group.key, label: group.label }));
const activePage = computed(() => (typeof route.name === "string" ? route.name : ""));
const versionText = computed(() => release.value?.display ?? "版本未知");
const accountText = computed(() => (me.value ? `${me.value.login} · ${ROLE_LABELS[me.value.role]}` : ""));

function navigate(value: SidebarNavValue) {
  const page = CONSOLE_PAGES.find(candidate => candidate.name === value);
  drawerOpen.value = false;
  if (page && page.name !== activePage.value) void router.push(page.path);
}

watch(narrow, isNarrow => {
  if (!isNarrow) drawerOpen.value = false;
});

onMounted(async () => {
  const [meResult, releaseResult] = await Promise.allSettled([api.get<MeResponse>("/api/v1/me"), api.get<ReleaseInfo>("/api/release")]);
  if (meResult.status === "fulfilled") me.value = meResult.value;
  if (releaseResult.status === "fulfilled") release.value = releaseResult.value;
});
</script>

<template>
  <div class="shell" :class="{ 'shell--narrow': narrow }">
    <a class="shell__skip" href="#main-content">跳到主要内容</a>

    <aside v-if="!narrow" class="shell__sidebar">
      <TxSidebarNav
        :model-value="activePage"
        :items="navItems"
        :groups="navGroups"
        aria-label="主导航"
        :indicator-duration="reducedMotion ? 0 : 220"
        @select="item => navigate(item.value)"
      />
    </aside>

    <div class="shell__body">
      <header class="shell__topbar">
        <TxButton v-if="narrow" variant="ghost" icon="i-carbon-menu" aria-haspopup="dialog" :aria-expanded="drawerOpen" @click="drawerOpen = true">
          导航
        </TxButton>
        <span class="shell__brand">geek_bot 后台</span>
        <span class="shell__spacer" />
        <TxStatusBadge v-if="sampleMode" text="样板数据" status="warning" size="sm" />
        <span v-if="accountText" class="shell__account" :title="accountText">{{ accountText }}</span>
      </header>

      <div v-if="!online" class="shell__notice">
        <TxAlert type="warning" title="网络已断开" message="页面显示的是断开前的数据；网络恢复后重新加载即可。" />
      </div>

      <main id="main-content" class="shell__main" tabindex="-1">
        <RouterView />
      </main>

      <footer class="shell__footer">
        <span>版本 <span class="shell__mono">{{ versionText }}</span></span>
        <span v-if="sampleMode">样板数据模式：页面上的数据全部虚构，不连控制面，也不发任何网络请求。</span>
      </footer>
    </div>

    <TxDrawer
      v-if="narrow"
      v-model:visible="drawerOpen"
      direction="left"
      size="min(320px, 86vw)"
      title="导航"
      :mobile-adapt="false"
      :show-footer="false"
      mask-effect="opacity"
    >
      <template #header="{ close, titleId }">
        <div class="shell__drawer-header">
          <h2 :id="titleId" class="shell__drawer-title">导航</h2>
          <TxButton variant="ghost" size="sm" icon="i-carbon-close" @click="close">关闭导航</TxButton>
        </div>
      </template>
      <div class="shell__drawer-nav">
        <TxSidebarNav
          :model-value="activePage"
          :items="navItems"
          :groups="navGroups"
          aria-label="主导航"
          :indicator-duration="reducedMotion ? 0 : 220"
          @select="item => navigate(item.value)"
        />
      </div>
    </TxDrawer>
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: 248px minmax(0, 1fr);
  min-height: 100vh;
  background: var(--tx-bg-color-page);
  color: var(--tx-text-color-primary);
}

.shell--narrow {
  grid-template-columns: minmax(0, 1fr);
}

.shell__skip {
  position: absolute;
  left: 8px;
  top: -48px;
  z-index: 10;
  padding: 8px 12px;
  border-radius: var(--tx-border-radius-base);
  background: var(--tx-bg-color);
  color: var(--tx-text-color-primary);
}

.shell__skip:focus {
  top: 8px;
}

/* TxSidebarNav 自带卡片外观，侧栏本身只管位置，不再叠一层底色和边框；宽度经组件变量填满容器。 */
.shell__sidebar {
  position: sticky;
  top: 0;
  height: 100vh;
  overflow-y: auto;
  padding: 12px;
  --tx-bui-sidebar-nav-width: 100%;
}

.shell__drawer-nav {
  --tx-bui-sidebar-nav-width: 100%;
}

.shell__body {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.shell__topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 56px;
  padding: 8px 24px;
  border-bottom: 1px solid var(--tx-border-color-light);
  background: var(--tx-bg-color);
}

.shell--narrow .shell__topbar {
  padding: 8px 12px;
}

.shell__brand {
  font-weight: 600;
  white-space: nowrap;
}

.shell__spacer {
  flex: 1;
}

.shell__topbar :deep(.tx-status-badge) {
  flex-shrink: 0;
  white-space: nowrap;
}

.shell__account {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--tx-bui-font-mono, ui-monospace, monospace);
  font-size: 0.8125rem;
  color: var(--tx-text-color-regular);
}

.shell__notice {
  padding: 12px 24px 0;
}

.shell__main {
  flex: 1;
  min-width: 0;
  padding: 24px;
  outline: none;
}

.shell--narrow .shell__main,
.shell--narrow .shell__notice {
  padding-left: 12px;
  padding-right: 12px;
}

.shell__footer {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  padding: 12px 24px;
  border-top: 1px solid var(--tx-border-color-light);
  font-size: 0.8125rem;
  color: var(--tx-text-color-regular);
}

.shell__mono {
  font-family: var(--tx-bui-font-mono, ui-monospace, monospace);
}

.shell__drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
}

.shell__drawer-title {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
}
</style>
