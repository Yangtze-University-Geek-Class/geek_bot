<script setup lang="ts">
/**
 * 管理员（`GET/POST /api/v1/admins`、`DELETE /api/v1/admins/:github_id`）。按 GitHub 数字 id 授权，
 * 角色只有所有者、操作员、只读成员；加入与移除只归所有者，并要求 10 分钟内重新认证过。
 */
import { computed, ref } from "vue";
import type { AdminRole, PlatformAdministrator } from "@geek-bot/protocol";
import { TxAlert } from "@talex-touch/tuffex/alert";
import { TxButton } from "@talex-touch/tuffex/button";
import { TxDataTable } from "@talex-touch/tuffex/data-table";
import { TxNumberInput } from "@talex-touch/tuffex/number-input";
import { TxSelect } from "@talex-touch/tuffex/select";
import { TxStatusBadge } from "@talex-touch/tuffex/status-badge";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import CursorPager from "../components/CursorPager.vue";
import StateView from "../components/StateView.vue";
import { useConsoleContext } from "../components/context.js";
import { useAction } from "../components/use-action.js";
import { useCursorList } from "../components/use-data.js";
import { newIdempotencyKey } from "../lib/api.js";
import { ROLE_LABELS } from "../lib/labels.js";

const { api, session } = useConsoleContext();
const isOwner = computed(() => session.allows("owner"));
const list = useCursorList<PlatformAdministrator>({ path: () => "/api/v1/admins" });

const columns = [
  { key: "login", title: "GitHub 账号" },
  { key: "github_id", title: "GitHub 数字 id" },
  { key: "role", title: "角色" },
  { key: "actions", title: "操作" },
];

const ROLE_OPTIONS = [
  { value: "operator", label: `${ROLE_LABELS.operator}：日常操作，不能改连接、机器令牌与管理员` },
  { value: "viewer", label: `${ROLE_LABELS.viewer}：只能查看` },
];
const ROLE_TONES: Readonly<Record<AdminRole, "success" | "info" | "muted">> = { owner: "success", operator: "info", viewer: "muted" };

const githubId = ref<number | null>(null);
const role = ref<"operator" | "viewer">("viewer");
let idempotencyKey = newIdempotencyKey();
const idValid = computed(() => githubId.value !== null && Number.isSafeInteger(githubId.value) && githubId.value > 0);

const add = useAction(
  async () => {
    const created = await api.send<PlatformAdministrator>("POST", "/api/v1/admins", { body: { github_id: githubId.value, role: role.value }, idempotencyKey });
    idempotencyKey = newIdempotencyKey();
    githubId.value = null;
    await list.reload();
    return created;
  },
  { name: "加入管理员", success: created => `已加入 ${created.login || created.github_id}（${ROLE_LABELS[created.role]}）` },
);

const removing = ref<PlatformAdministrator | null>(null);
const removeOpen = computed({
  get: () => removing.value !== null,
  set: open => {
    if (!open) removing.value = null;
  },
});
const remove = useAction(
  async () => {
    const target = removing.value;
    if (!target) return null;
    await api.send<void>("DELETE", `/api/v1/admins/${encodeURIComponent(String(target.github_id))}`);
    removing.value = null;
    await list.reload();
    return target;
  },
  { name: "移除管理员", success: target => (target ? `已移除 ${target.login || target.github_id}，他的会话已全部失效` : null) },
);
</script>

<template>
  <section class="page" aria-labelledby="page-title-admins">
    <div class="page-header">
      <div class="page-header__text">
        <h1 id="page-title-admins" class="page-title">管理员</h1>
        <p class="page-lede">能登录后台的 GitHub 账号。按 GitHub 数字 id 授权，改名不影响；登录只确认身份，不申请任何仓库权限。</p>
      </div>
    </div>

    <section class="section" aria-labelledby="add-admin-title">
      <h2 id="add-admin-title" class="section__title">加入管理员</h2>
      <TxAlert
        type="warning"
        :closable="false"
        title="加入后能看到所有项目的内容"
        message="管理员能看到渠道连接读到的私有项目内容，不按他自己在平台上的权限过滤。只加入可信的人。"
      />
      <p v-if="!isOwner" class="section__hint">只有所有者能加入或移除管理员。</p>
      <form class="form-grid" @submit.prevent="add.run()">
        <label class="field">
          <span class="field__label">GitHub 数字 id</span>
          <TxNumberInput v-model="githubId" :min="1" :step="1" :precision="0" :controls="false" :disabled="!isOwner" placeholder="例如 1000001" />
          <span class="field__hint">可以从 <span class="mono">https://api.github.com/users/&lt;login&gt;</span> 的 <span class="mono">id</span> 字段查到。</span>
        </label>
        <label class="field">
          <span class="field__label">角色</span>
          <TxSelect :model-value="role" :options="ROLE_OPTIONS" :disabled="!isOwner" @update:model-value="value => (role = value === 'operator' ? 'operator' : 'viewer')" />
        </label>
        <div class="actions form-grid__wide">
          <TxButton variant="primary" native-type="submit" :loading="add.pending.value" :disabled="!isOwner || !idValid">加入管理员</TxButton>
        </div>
        <p v-if="add.error.value" class="field__error form-grid__wide" role="alert">{{ add.error.value.message }}</p>
      </form>
    </section>

    <StateView :state="list.state.value" subject="管理员名单" empty-title="名单是空的" empty-description="认领实例的账号会作为所有者出现在这里。" @retry="list.reload">
      <TxDataTable :columns="columns" :data="[...list.items.value]" row-key="github_id" scroll-x empty-text="这一页没有管理员">
        <template #cell-login="{ row }">
          <span class="mono">{{ row.login || "尚未登录过" }}</span>
          <TxStatusBadge v-if="session.me.value?.github_id === row.github_id" text="你" status="info" size="sm" />
        </template>
        <template #cell-github_id="{ row }"><span class="mono">{{ row.github_id }}</span></template>
        <template #cell-role="{ row }">
          <TxStatusBadge :text="ROLE_LABELS[row.role as AdminRole]" :status="ROLE_TONES[row.role as AdminRole]" size="sm" />
        </template>
        <template #cell-actions="{ row }">
          <TxButton v-if="row.role !== 'owner'" variant="ghost" size="sm" icon="i-carbon-trash-can" :disabled="!isOwner" @click="removing = row">移除</TxButton>
          <span v-else class="section__hint">所有者不能移除</span>
        </template>
      </TxDataTable>
      <CursorPager :list="list" label="管理员名单分页" />
    </StateView>

    <ConfirmDialog v-model="removeOpen" title="移除管理员" confirm-label="移除管理员" :pending="remove.pending.value" :error="remove.error.value" @confirm="remove.run()">
      <p v-if="removing">
        移除 <span class="mono">{{ removing.login || removing.github_id }}</span> 后，他的全部会话立即失效，不能再登录后台；以后可以重新加入。
      </p>
    </ConfirmDialog>
  </section>
</template>
