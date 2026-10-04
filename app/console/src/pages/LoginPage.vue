<script setup lang="ts">
/**
 * 认领与登录（API.md A-01…A-04）：
 * - 实例未认领：输入目标机上 `bootstrap-code` 打印的认领码（A-02），再用 GitHub device flow（purpose=claim）完成认领，这个 GitHub 账号成为所有者；
 * - 已认领：GitHub device flow（purpose=login）登录；只有管理员名单里的 GitHub 账号能登录，名单由所有者在「管理员」页维护。
 * 登录成功后回到进入登录页前的地址（只接受站内路径）。
 */
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { AuthStateResponse } from "@geek-bot/protocol";
import { TxAlert } from "@talex-touch/tuffex/alert";
import { TxButton } from "@talex-touch/tuffex/button";
import { TxInput } from "@talex-touch/tuffex/input";
import StateView from "../components/StateView.vue";
import DeviceFlowPanel from "../components/DeviceFlowPanel.vue";
import { useConsoleContext } from "../components/context.js";
import { useAction } from "../components/use-action.js";
import { queryText } from "../components/use-data.js";
import { stateFromError, type PageState } from "../lib/page-state.js";
import { DEFAULT_PAGE } from "../shell/pages.js";

const { api, session } = useConsoleContext();
const route = useRoute();
const router = useRouter();
const state = ref<PageState<AuthStateResponse>>({ kind: "loading" });
const claimCode = ref("");
const claimAccepted = ref(false);

/** 只接受站内的绝对路径，避免登录后被带到别的站点。 */
const redirectTarget = computed(() => {
  const target = queryText(route.query.redirect);
  return target.startsWith("/") && !target.startsWith("//") && !target.startsWith("/login") ? target : DEFAULT_PAGE.path;
});

async function load() {
  state.value = { kind: "loading" };
  try {
    state.value = { kind: "ready", data: await api.get<AuthStateResponse>("/api/v1/auth/state") };
  } catch (error) {
    state.value = stateFromError(error);
  }
}

const claim = useAction(
  async () => {
    await api.send<void>("POST", "/api/v1/auth/claim", { body: { code: claimCode.value.trim() } });
    claimCode.value = "";
    claimAccepted.value = true;
  },
  { name: "核对认领码", success: () => "认领码正确，继续完成 GitHub 授权" },
);

async function signedIn() {
  await session.load();
  if (session.status.value === "authenticated") await router.replace(redirectTarget.value);
}

onMounted(load);
</script>

<template>
  <section class="page login" aria-labelledby="page-title-login">
    <div class="page-header">
      <div class="page-header__text">
        <h1 id="page-title-login" class="page-title">登录 geek_bot 后台</h1>
        <p class="page-lede">后台管理员用 GitHub 账号登录；登录只确认身份，不申请任何仓库权限。代码平台与消息渠道的凭据在「渠道连接」里单独配置。</p>
      </div>
    </div>

    <section v-if="session.status.value === 'authenticated' && session.me.value" class="section" aria-labelledby="already-title">
      <h2 id="already-title" class="section__title">已经登录</h2>
      <p class="section__hint">
        当前会话的 GitHub 账号是 <span class="mono">{{ session.me.value.login }}</span>。
      </p>
      <div class="actions">
        <TxButton variant="primary" @click="router.replace(redirectTarget)">进入后台</TxButton>
      </div>
    </section>

    <StateView v-else :state="state" subject="实例的登录状态" @retry="load">
      <template v-if="state.kind === 'ready'">
        <TxAlert
          v-if="state.data.insecure_context"
          type="warning"
          title="当前不是安全上下文"
          message="实例以明文 HTTP 提供后台，会话 cookie 不带 Secure；只应在受信任的私网里这样部署。"
          :closable="false"
        />

        <section v-if="!state.data.claimed" class="section" aria-labelledby="claim-title">
          <h2 id="claim-title" class="section__title">认领实例</h2>
          <p class="section__hint">
            实例还没有所有者。在部署 control 的主机上运行 <span class="mono">bootstrap-code</span> 命令取得认领码，填在下面；然后用 GitHub 完成一次授权，这个 GitHub 账号就成为实例的所有者。认领码连续输错 5 次会作废，需要在主机上重新生成。
          </p>
          <form v-if="!claimAccepted" class="form-grid" @submit.prevent="claim.run()">
            <label class="field">
              <span class="field__label">认领码</span>
              <TxInput v-model="claimCode" type="password" autocomplete="off" spellcheck="false" caps-lock-text="大写锁定已打开" />
            </label>
            <div class="actions form-grid__wide">
              <TxButton variant="primary" native-type="submit" :loading="claim.pending.value" :disabled="claimCode.trim() === ''">核对认领码</TxButton>
            </div>
            <p v-if="claim.error.value" class="field__error form-grid__wide" role="alert">{{ claim.error.value.message }}</p>
          </form>
          <DeviceFlowPanel v-else purpose="claim" start-label="用 GitHub 完成认领" @done="signedIn" @cancel="claimAccepted = false" />
        </section>

        <section v-else class="section" aria-labelledby="login-title">
          <h2 id="login-title" class="section__title">用 GitHub 登录</h2>
          <p class="section__hint">只有所有者加入管理员名单的 GitHub 账号能登录；不在名单里的账号授权后会被拒绝。</p>
          <DeviceFlowPanel purpose="login" start-label="用 GitHub 登录" @done="signedIn" />
        </section>
      </template>
    </StateView>
  </section>
</template>

<style scoped>
.login {
  max-width: 720px;
  margin: 0 auto;
}
</style>
