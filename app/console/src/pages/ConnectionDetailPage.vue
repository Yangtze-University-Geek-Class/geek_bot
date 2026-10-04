<script setup lang="ts">
/**
 * 连接详情（`GET/PATCH /api/v1/connections/:id`、`POST /:id/{discover,sync,disable}`）。
 * - GitHub：用 OAuth device flow（purpose=connection）绑定账号，只接受 repo、read:org 范围内的授权；
 * - GitLab：平台令牌在凭据里更新；
 * - 飞书、签名 Webhook：显示要填到对方平台的入站地址；
 * - 凭据只写不读，留空的字段不改动；停用前确认。
 */
import { computed, ref, watch } from "vue";
import type { ConnectionRecord, DiscoverResponse, SyncResponse } from "@geek-bot/protocol";
import { TxAlert } from "@talex-touch/tuffex/alert";
import { TxButton, TxCopyButton } from "@talex-touch/tuffex/button";
import { TxInput } from "@talex-touch/tuffex/input";
import { TxStatusBadge } from "@talex-touch/tuffex/status-badge";
import { TxSwitch } from "@talex-touch/tuffex/switch";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import CredentialFields from "../components/CredentialFields.vue";
import DeviceFlowPanel from "../components/DeviceFlowPanel.vue";
import StateView from "../components/StateView.vue";
import { useConsoleContext } from "../components/context.js";
import { useAction } from "../components/use-action.js";
import { useRecord } from "../components/use-data.js";
import { credentialsPayload, emptyCredentialDraft } from "../lib/credentials.js";
import { formatTime } from "../lib/format.js";
import { CAPABILITY_LABELS, PROVIDER_LABELS, connectionStatus } from "../lib/labels.js";

const props = defineProps<{ id: string }>();

const { api, session } = useConsoleContext();
const connectionPath = computed(() => `/api/v1/connections/${encodeURIComponent(props.id)}`);
const record = useRecord<ConnectionRecord>(() => connectionPath.value);
const connection = record.data;
const isOwner = computed(() => session.allows("owner"));
const canOperate = computed(() => session.allows("operator"));
const isCodePlatform = computed(() => connection.value?.provider === "github" || connection.value?.provider === "gitlab");
const status = computed(() => (connection.value ? connectionStatus(connection.value.status, connection.value.enabled) : null));

const intakeUrl = computed(() => {
  const value = connection.value;
  if (!value || (value.provider !== "feishu" && value.provider !== "webhook")) return null;
  return `${window.location.origin}/api/v1/intake/${value.provider}/${encodeURIComponent(value.id)}`;
});

type ConnectionPatch = { name?: string; base_url?: string; enabled?: boolean; credentials?: Record<string, string> };
const patch = useAction(
  async (body: ConnectionPatch) => {
    const next = await api.send<ConnectionRecord>("PATCH", connectionPath.value, { body, ifMatch: record.etag.value });
    record.replace(next);
    return next;
  },
  { name: "保存连接", success: () => "连接已保存" },
);

// 基本信息。
const draftName = ref("");
const draftBaseUrl = ref("");
watch(
  connection,
  value => {
    if (!value) return;
    draftName.value = value.name;
    draftBaseUrl.value = value.base_url;
  },
  { immediate: true },
);
const basicsDirty = computed(() => connection.value !== null && (draftName.value.trim() !== connection.value.name || draftBaseUrl.value.trim() !== connection.value.base_url));

async function toggleEnabled(enabled: boolean) {
  if (!enabled) {
    disableOpen.value = true;
    return;
  }
  if ((await patch.run({ enabled: true })) === undefined) await record.reload();
}

// 凭据。
const credentials = ref(emptyCredentialDraft());
const credentialPayload = computed(() => (connection.value ? credentialsPayload(connection.value.provider, credentials.value) : null));
async function saveCredentials() {
  if (!credentialPayload.value) return;
  const result = await patch.run({ credentials: { ...credentialPayload.value } });
  if (result !== undefined) credentials.value = emptyCredentialDraft();
}

// 发现与同步。
const discover = useAction(
  async () => {
    const result = await api.send<DiscoverResponse>("POST", `${connectionPath.value}/discover`);
    await record.reload();
    return result;
  },
  { name: "发现项目", success: result => `发现完成：${result.discovered} 个项目可访问，${result.lost} 个失去访问` },
);
const sync = useAction(
  async () => {
    const result = await api.send<SyncResponse>("POST", `${connectionPath.value}/sync`);
    await record.reload();
    return result;
  },
  { name: "同步条目", success: result => `同步完成：${result.projects} 个项目，${result.items} 个条目` },
);

// 停用。
const disableOpen = ref(false);
const disable = useAction(
  async () => {
    const next = await api.send<ConnectionRecord>("POST", `${connectionPath.value}/disable`);
    record.replace(next);
    disableOpen.value = false;
    return next;
  },
  { name: "停用连接", success: () => "连接已停用" },
);

// GitHub 绑定。
const binding = ref(false);
async function bound() {
  binding.value = false;
  await record.reload();
}
</script>

<template>
  <section class="page" aria-labelledby="page-title-connection">
    <StateView :state="record.state.value" subject="连接" @retry="record.reload">
      <template v-if="connection && status">
        <div class="page-header">
          <div class="page-header__text">
            <RouterLink class="page-header__back" to="/connections">返回渠道连接</RouterLink>
            <h1 id="page-title-connection" class="page-title">{{ connection.name }}</h1>
            <p class="page-lede">{{ PROVIDER_LABELS[connection.provider] }}</p>
          </div>
          <div class="actions">
            <TxStatusBadge :text="status.label" :status="status.tone" />
            <template v-if="isCodePlatform">
              <TxButton variant="secondary" icon="i-carbon-search" :loading="discover.pending.value" :disabled="!canOperate || !connection.enabled" @click="discover.run()">发现项目</TxButton>
              <TxButton variant="secondary" icon="i-carbon-renew" :loading="sync.pending.value" :disabled="!canOperate || !connection.enabled" @click="sync.run()">同步条目</TxButton>
              <RouterLink class="link" :to="{ path: '/projects', query: { connection_id: connection.id } }">这个连接的项目</RouterLink>
            </template>
          </div>
        </div>

        <TxAlert v-if="!isOwner" type="info" title="连接凭据仅所有者可修改" message="操作员可以发现、同步和停用连接；重新启用或修改凭据、地址仍需所有者。" :closable="false" />

        <dl class="meta-list section">
          <div><dt>账号</dt><dd class="mono">{{ connection.account_name ?? "未绑定" }}</dd></div>
          <div><dt>平台地址</dt><dd class="mono">{{ connection.base_url || "无" }}</dd></div>
          <div><dt>凭据</dt><dd>{{ connection.secret_configured ? "已配置（不显示）" : "未配置" }}</dd></div>
          <div><dt>能力</dt><dd>{{ connection.capabilities.length ? connection.capabilities.map(capability => CAPABILITY_LABELS[capability]).join("、") : "没有" }}</dd></div>
          <div><dt>创建时间</dt><dd>{{ formatTime(connection.created_at) }}</dd></div>
          <div><dt>配置版本</dt><dd class="mono">{{ connection.revision }}</dd></div>
        </dl>

        <section v-if="connection.provider === 'github'" class="section" aria-labelledby="bind-title">
          <h2 id="bind-title" class="section__title">绑定 GitHub 账号</h2>
          <p class="section__hint">
            用要作为机器人的 GitHub 账号（一般是小号）完成一次设备授权。授权范围只允许 repo 与 read:org，出现其它范围会被拒绝。机器人会以这个账号的身份在 GitHub 上发言；批准与合并始终由人来做。重新绑定必须是同一个 GitHub 账号。
          </p>
          <DeviceFlowPanel
            v-if="binding"
            purpose="connection"
            :connection-id="connection.id"
            start-label="打开 GitHub 授权"
            @done="bound"
            @cancel="binding = false"
          />
          <div v-else class="actions">
            <TxButton variant="primary" icon="i-carbon-logo-github" :disabled="!isOwner" @click="binding = true">
              {{ connection.secret_configured ? "重新授权绑定" : "开始绑定" }}
            </TxButton>
          </div>
        </section>

        <section v-if="intakeUrl" class="section" aria-labelledby="intake-title">
          <h2 id="intake-title" class="section__title">{{ connection.provider === "feishu" ? "飞书事件订阅地址" : "Webhook 入站地址" }}</h2>
          <p v-if="connection.provider === 'feishu'" class="section__hint">
            在飞书开放平台的应用里，把事件订阅的请求地址填成下面的地址，并订阅接收消息事件；控制面会按 Verification Token（和 Encrypt Key）校验来源，重复的事件只处理一次。收到的需求会出现在「需求」里，关联项目后才能执行。
          </p>
          <p v-else class="section__hint">
            发送方向下面的地址 POST JSON，并用签名密钥对请求体签名；签名不符或重复的事件会被拒绝。收到的需求会出现在「需求」里，关联项目后才能执行；配置了回传地址时，进展与结果会回传过去。
          </p>
          <div class="secret-box">
            <code>{{ intakeUrl }}</code>
            <TxCopyButton :text="intakeUrl" copy-label="复制入站地址" copied-label="已复制" size="sm" />
          </div>
        </section>

        <section class="section" aria-labelledby="basics-title">
          <h2 id="basics-title" class="section__title">基本信息</h2>
          <form class="form-grid" @submit.prevent="patch.run({ name: draftName.trim(), base_url: draftBaseUrl.trim() })">
            <label class="field">
              <span class="field__label">名称</span>
              <TxInput v-model="draftName" :disabled="!isOwner" />
            </label>
            <label class="field">
              <span class="field__label">平台地址</span>
              <TxInput v-model="draftBaseUrl" :disabled="!isOwner" />
            </label>
            <div class="field">
              <span id="connection-enabled-label" class="field__label">启用</span>
              <TxSwitch
                :model-value="connection.enabled"
                aria-labelledby="connection-enabled-label"
                :disabled="(!isOwner && (!canOperate || !connection.enabled)) || patch.pending.value"
                :loading="patch.pending.value"
                @update:model-value="toggleEnabled"
              />
            </div>
            <div class="actions form-grid__wide">
              <TxButton variant="primary" native-type="submit" :loading="patch.pending.value" :disabled="!isOwner || !basicsDirty || draftName.trim() === ''">保存基本信息</TxButton>
            </div>
          </form>
        </section>

        <section v-if="connection.provider !== 'github'" class="section" aria-labelledby="credentials-title">
          <h2 id="credentials-title" class="section__title">更新凭据</h2>
          <p class="section__hint">凭据加密保存在控制面，任何接口都不会返回明文。只填要更换的字段，留空的字段保持原值。</p>
          <form class="form-grid" @submit.prevent="saveCredentials">
            <CredentialFields v-model="credentials" :provider="connection.provider" :updating="true" :disabled="!isOwner" />
            <div class="actions form-grid__wide">
              <TxButton variant="primary" native-type="submit" :loading="patch.pending.value" :disabled="!isOwner || credentialPayload === null">更新凭据</TxButton>
            </div>
          </form>
        </section>

        <p v-if="patch.error.value" class="field__error" role="alert">{{ patch.error.value.message }}</p>

        <ConfirmDialog v-model="disableOpen" title="停用这个连接" confirm-label="停用连接" :pending="disable.pending.value" :error="disable.error.value" @confirm="disable.run()">
          <p>停用后不再通过这个连接发现项目、同步条目、接收需求或写回结果；凭据保留，重新启用后恢复。</p>
        </ConfirmDialog>
      </template>
    </StateView>
  </section>
</template>
