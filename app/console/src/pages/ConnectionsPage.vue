<script setup lang="ts">
/**
 * 渠道连接（`GET/POST /api/v1/connections`）：代码平台（GitHub、GitLab）与消息渠道（飞书、签名 Webhook）。
 * 凭据只写不读，列表只显示「已配置」与否。添加连接需要所有者；GitHub 连接创建后在详情里用 OAuth 绑定账号。
 */
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import type { Capability, ConnectionProvider, ConnectionRecord } from "@geek-bot/protocol";
import { TxButton } from "@talex-touch/tuffex/button";
import { TxDataTable } from "@talex-touch/tuffex/data-table";
import { TxInput } from "@talex-touch/tuffex/input";
import { TxSelect, type TxSelectModelValue } from "@talex-touch/tuffex/select";
import { TxStatusBadge } from "@talex-touch/tuffex/status-badge";
import CredentialFields from "../components/CredentialFields.vue";
import CursorPager from "../components/CursorPager.vue";
import StateView from "../components/StateView.vue";
import { useConsoleContext } from "../components/context.js";
import { useAction } from "../components/use-action.js";
import { useCursorList } from "../components/use-data.js";
import { newIdempotencyKey } from "../lib/api.js";
import { DEFAULT_BASE_URL, credentialsComplete, credentialsPayload, emptyCredentialDraft } from "../lib/credentials.js";
import { formatTime } from "../lib/format.js";
import { CAPABILITY_LABELS, PROVIDER_LABELS, connectionStatus } from "../lib/labels.js";

const { api, session } = useConsoleContext();
const router = useRouter();
const isOwner = computed(() => session.allows("owner"));
const list = useCursorList<ConnectionRecord>({ path: () => "/api/v1/connections" });

const columns = [
  { key: "name", title: "连接" },
  { key: "provider", title: "平台" },
  { key: "status", title: "状态" },
  { key: "account_name", title: "账号" },
  { key: "capabilities", title: "能力" },
  { key: "secret_configured", title: "凭据" },
  { key: "created_at", title: "创建时间" },
];

const PROVIDER_OPTIONS = (Object.keys(PROVIDER_LABELS) as ConnectionProvider[]).map(value => ({ value, label: PROVIDER_LABELS[value] }));
function onProvider(value: TxSelectModelValue) {
  const match = PROVIDER_OPTIONS.find(option => option.value === value);
  if (match) provider.value = match.value;
}

// 添加表单。
const formOpen = ref(false);
const provider = ref<ConnectionProvider>("github");
const name = ref("");
const baseUrl = ref(DEFAULT_BASE_URL.github);
const credentials = ref(emptyCredentialDraft());
let idempotencyKey = newIdempotencyKey();

watch(provider, (next, previous) => {
  if (baseUrl.value === "" || baseUrl.value === DEFAULT_BASE_URL[previous]) baseUrl.value = DEFAULT_BASE_URL[next];
  credentials.value = emptyCredentialDraft();
  idempotencyKey = newIdempotencyKey();
});

const baseUrlValid = computed(() => {
  if (provider.value === "webhook" && baseUrl.value.trim() === "") return true;
  try {
    const url = new URL(baseUrl.value.trim());
    return (url.protocol === "https:" || url.protocol === "http:") && url.username === "" && url.password === "" && url.search === "";
  } catch {
    return false;
  }
});
const formValid = computed(() => name.value.trim() !== "" && baseUrlValid.value && credentialsComplete(provider.value, credentials.value));

const create = useAction(
  async () => {
    const secret = credentialsPayload(provider.value, credentials.value);
    const body = { provider: provider.value, name: name.value.trim(), base_url: baseUrl.value.trim(), ...(secret ? { credentials: secret } : {}) };
    const created = await api.send<ConnectionRecord>("POST", "/api/v1/connections", { body, idempotencyKey });
    idempotencyKey = newIdempotencyKey();
    credentials.value = emptyCredentialDraft();
    name.value = "";
    formOpen.value = false;
    await router.push(`/connections/${encodeURIComponent(created.id)}`);
    return created;
  },
  { name: "添加连接", success: created => `已添加连接「${created.name}」` },
);
</script>

<template>
  <section class="page" aria-labelledby="page-title-connections">
    <div class="page-header">
      <div class="page-header__text">
        <h1 id="page-title-connections" class="page-title">渠道连接</h1>
        <p class="page-lede">代码平台连接用来发现项目、读取条目并在允许时写回结果；消息渠道连接用来接收需求并回传进展。凭据加密保存在控制面，界面上只显示是否已配置。</p>
      </div>
      <div class="actions">
        <TxButton variant="primary" icon="i-carbon-add" :disabled="!isOwner" :aria-expanded="formOpen" aria-controls="connection-form" @click="formOpen = !formOpen">
          {{ formOpen ? "收起" : "添加连接" }}
        </TxButton>
      </div>
    </div>

    <section v-if="formOpen" id="connection-form" class="section" aria-labelledby="connection-form-title">
      <h2 id="connection-form-title" class="section__title">添加连接</h2>
      <p class="section__hint">添加连接需要所有者，并可能要求重新认证。GitHub 连接添加后，在详情里用 GitHub 授权绑定账号；机器人会以绑定账号的身份在 GitHub 上发言。</p>
      <form class="form-grid" @submit.prevent="create.run()">
        <label class="field">
          <span class="field__label">平台</span>
          <TxSelect :model-value="provider" :options="PROVIDER_OPTIONS" @update:model-value="onProvider" />
        </label>
        <label class="field">
          <span class="field__label">名称</span>
          <TxInput v-model="name" placeholder="例如 GitHub 机器人账号" />
        </label>
        <label class="field form-grid__wide">
          <span class="field__label">{{ provider === "webhook" ? "来源说明地址（可空）" : "平台 API 地址" }}</span>
          <TxInput v-model="baseUrl" class="mono" :placeholder="DEFAULT_BASE_URL[provider] || 'https://'" />
          <span v-if="!baseUrlValid" class="field__error">需要 http(s) 地址，不能带账号、密码或查询参数；密钥放在凭据里。</span>
        </label>
        <CredentialFields v-model="credentials" :provider="provider" :updating="false" />
        <div class="actions form-grid__wide">
          <TxButton variant="primary" native-type="submit" :loading="create.pending.value" :disabled="!formValid">添加连接</TxButton>
          <TxButton variant="ghost" @click="formOpen = false">取消</TxButton>
        </div>
        <p v-if="create.error.value" class="field__error form-grid__wide" role="alert">{{ create.error.value.message }}</p>
      </form>
    </section>

    <StateView
      :state="list.state.value"
      subject="连接列表"
      empty-title="还没有渠道连接"
      empty-description="所有者点「添加连接」：先加 GitHub 或 GitLab 连接发现项目，再按需加飞书或签名 Webhook 接收需求。"
      @retry="list.reload"
    >
      <TxDataTable :columns="columns" :data="[...list.items.value]" row-key="id" scroll-x empty-text="这一页没有连接">
        <template #cell-name="{ row }">
          <RouterLink class="link" :to="`/connections/${encodeURIComponent(row.id)}`">{{ row.name }}</RouterLink>
        </template>
        <template #cell-provider="{ row }">{{ PROVIDER_LABELS[row.provider as ConnectionProvider] }}</template>
        <template #cell-status="{ row }">
          <TxStatusBadge :text="connectionStatus(row.status, row.enabled).label" :status="connectionStatus(row.status, row.enabled).tone" size="sm" />
        </template>
        <template #cell-account_name="{ row }"><span class="mono">{{ row.account_name ?? "未绑定" }}</span></template>
        <template #cell-capabilities="{ row }">{{ row.capabilities.length ? row.capabilities.map((capability: Capability) => CAPABILITY_LABELS[capability]).join("、") : "没有" }}</template>
        <template #cell-secret_configured="{ row }">
          <TxStatusBadge :text="row.secret_configured ? '已配置' : '未配置'" :status="row.secret_configured ? 'success' : 'warning'" size="sm" />
        </template>
        <template #cell-created_at="{ row }">{{ formatTime(row.created_at) }}</template>
      </TxDataTable>
      <CursorPager :list="list" label="连接列表分页" />
    </StateView>
  </section>
</template>
