<script setup lang="ts">
/**
 * 连接凭据的输入项（只写，control 用 AES-256-GCM 加密保存，从不回传界面）。按平台显示需要的字段：
 * - GitLab：最小权限的平台令牌；
 * - 飞书：应用的 App ID、App Secret、事件订阅的 Verification Token，以及可选的 Encrypt Key；
 * - 签名 Webhook：入站签名密钥，以及可选的结果回传地址（地址可能带密钥，所以也按凭据保存）；
 * - GitHub：不在这里填，绑定账号走 OAuth device flow。
 * 更新已有连接时留空的字段不改动原值。
 */
import type { ConnectionCredentials, ConnectionProvider } from "@geek-bot/protocol";
import { TxInput } from "@talex-touch/tuffex/input";

defineProps<{ provider: ConnectionProvider; updating: boolean; disabled?: boolean }>();
const model = defineModel<Record<keyof ConnectionCredentials, string>>({ required: true });
</script>

<template>
  <template v-if="provider === 'gitlab'">
    <label class="field form-grid__wide">
      <span class="field__label">平台令牌{{ updating ? "（留空不修改）" : "" }}</span>
      <TxInput v-model="model.token" type="password" autocomplete="off" :disabled="disabled" caps-lock-text="大写锁定已打开" />
      <span class="field__hint">建议用只读加评论所需的最小权限令牌；实际能力按令牌在每个项目上的真实权限取交集。</span>
    </label>
  </template>

  <template v-else-if="provider === 'feishu'">
    <label class="field">
      <span class="field__label">App ID{{ updating ? "（留空不修改）" : "" }}</span>
      <TxInput v-model="model.app_id" autocomplete="off" :disabled="disabled" />
    </label>
    <label class="field">
      <span class="field__label">App Secret{{ updating ? "（留空不修改）" : "" }}</span>
      <TxInput v-model="model.app_secret" type="password" autocomplete="off" :disabled="disabled" caps-lock-text="大写锁定已打开" />
    </label>
    <label class="field">
      <span class="field__label">Verification Token{{ updating ? "（留空不修改）" : "" }}</span>
      <TxInput v-model="model.verification_token" type="password" autocomplete="off" :disabled="disabled" caps-lock-text="大写锁定已打开" />
    </label>
    <label class="field">
      <span class="field__label">Encrypt Key（可选{{ updating ? "，留空不修改" : "" }}）</span>
      <TxInput v-model="model.encrypt_key" type="password" autocomplete="off" :disabled="disabled" caps-lock-text="大写锁定已打开" />
      <span class="field__hint">飞书事件订阅开启了加密时填写。</span>
    </label>
  </template>

  <template v-else-if="provider === 'webhook'">
    <label class="field">
      <span class="field__label">签名密钥{{ updating ? "（留空不修改）" : "" }}</span>
      <TxInput v-model="model.signing_secret" type="password" autocomplete="off" :disabled="disabled" caps-lock-text="大写锁定已打开" />
      <span class="field__hint">发送方用它对请求体签名；签名不符的请求会被拒绝。</span>
    </label>
    <label class="field">
      <span class="field__label">结果回传地址（可选{{ updating ? "，留空不修改" : "" }}）</span>
      <TxInput v-model="model.webhook_url" type="password" autocomplete="off" :disabled="disabled" placeholder="https://" />
      <span class="field__hint">任务进展与结果回传到这个地址；地址里可能带密钥，所以按凭据加密保存，不显示。</span>
    </label>
  </template>
</template>
