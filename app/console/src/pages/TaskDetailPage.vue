<script setup lang="ts">
/**
 * 任务详情（`GET /api/v1/tasks/:id`、`GET /:id/events`、`POST /:id/{cancel,requeue,publish}`）。
 * - 没结束的任务实时刷新：真实模式订阅 SSE `task:<id>`，断线时每 5 秒轮询；样板数据模式不建连接，只按 5 秒轮询。
 * - 结果、事件、错误都来自模型与节点，一律按纯文本显示；补丁按原文放在代码块里。
 * - 取消与发布先确认（初始焦点在「取消」）；重新排队带 Idempotency-Key。
 */
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { Executor, ProjectRecord, TaskEvent, TaskFinding, TaskKind, TaskRecord } from "@geek-bot/protocol";
import { TxAlert } from "@talex-touch/tuffex/alert";
import { TxButton } from "@talex-touch/tuffex/button";
import { TxDataTable } from "@talex-touch/tuffex/data-table";
import { TxStatusBadge } from "@talex-touch/tuffex/status-badge";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import CursorPager from "../components/CursorPager.vue";
import StateView from "../components/StateView.vue";
import { useConsoleContext } from "../components/context.js";
import { useAction } from "../components/use-action.js";
import { useCursorList, useRecord } from "../components/use-data.js";
import { newIdempotencyKey } from "../lib/api.js";
import { formatTime } from "../lib/format.js";
import { EXECUTOR_LABELS, TASK_KIND_LABELS, TASK_STATUS_LABELS, TASK_TERMINAL, WRITE_MODE_LABELS } from "../lib/labels.js";
import { POLL_INTERVAL_MS, openStream, type StreamHandle, type StreamStatus } from "../lib/sse.js";

const props = defineProps<{ id: string }>();

const { api, sampleMode, session } = useConsoleContext();
const taskPath = computed(() => `/api/v1/tasks/${encodeURIComponent(props.id)}`);
const record = useRecord<TaskRecord>(() => taskPath.value);
const task = record.data;
const canOperate = computed(() => session.allows("operator"));

const events = useCursorList<TaskEvent>({ path: () => `${taskPath.value}/events`, cursorKey: "events_cursor" });
const eventColumns = [
  { key: "seq", title: "序号" },
  { key: "at", title: "时间" },
  { key: "kind", title: "类型" },
  { key: "text", title: "内容" },
];
const EVENT_KIND_LABELS: Readonly<Record<TaskEvent["kind"], string>> = { text: "输出", tool: "工具", error: "错误", retry: "重试", model: "模型" };

const SEVERITY_LABELS: Readonly<Record<TaskFinding["severity"], { label: string; tone: "danger" | "warning" | "info" }>> = {
  blocking: { label: "阻塞", tone: "danger" },
  warning: { label: "应修", tone: "warning" },
  suggestion: { label: "建议", tone: "info" },
};
const findingColumns = [
  { key: "severity", title: "严重度" },
  { key: "location", title: "位置" },
  { key: "message", title: "说明" },
];

// 项目的写入模式：发布前在确认里说明会发生什么。
const project = ref<ProjectRecord | null>(null);
watch(
  () => task.value?.project_id ?? null,
  async id => {
    if (!id) return;
    try {
      project.value = await api.get<ProjectRecord>(`/api/v1/projects/${encodeURIComponent(id)}`);
    } catch {
      project.value = null;
    }
  },
  { immediate: true },
);

// 实时刷新。
const live = computed(() => task.value !== null && !TASK_TERMINAL[task.value.status]);
const streamStatus = ref<StreamStatus | "off">("off");
let stream: StreamHandle | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

function refresh() {
  void record.reload();
  void events.reload(true);
}

function stopLive() {
  stream?.close();
  stream = null;
  if (pollTimer !== null) clearInterval(pollTimer);
  pollTimer = null;
  streamStatus.value = "off";
}

function startLive() {
  stopLive();
  if (sampleMode) {
    pollTimer = setInterval(refresh, POLL_INTERVAL_MS);
    return;
  }
  stream = openStream({
    topics: [`task:${props.id}`],
    onEvent: event => {
      if (event.type === "task.updated" || event.type === "task.event") refresh();
    },
    onStatus: status => {
      streamStatus.value = status;
    },
    onReset: refresh,
    poll: refresh,
  });
}

watch(live, isLive => (isLive ? startLive() : stopLive()), { immediate: true });
watch(
  () => record.state.value,
  state => {
    // 会话过期后 SSE 重建会一直失败，轮询拿到 401 时关掉连接（sse.ts 的约定）。
    if (state.kind === "unauthenticated") stopLive();
  },
);
onBeforeUnmount(stopLive);

// 操作。
const cancelOpen = ref(false);
const cancel = useAction(
  async () => {
    const next = await api.send<TaskRecord>("POST", `${taskPath.value}/cancel`);
    record.replace(next);
    cancelOpen.value = false;
    return next;
  },
  { name: "取消任务", success: next => `任务状态：${TASK_STATUS_LABELS[next.status].label}` },
);

let requeueKey = newIdempotencyKey();
const requeue = useAction(
  async () => {
    const next = await api.send<TaskRecord>("POST", `${taskPath.value}/requeue`, { idempotencyKey: requeueKey });
    requeueKey = newIdempotencyKey();
    record.replace(next);
    void events.reload(true);
    return next;
  },
  { name: "重新排队", success: () => "任务已回到队列" },
);

const publishOpen = ref(false);
const publish = useAction(
  async () => {
    const next = await api.send<TaskRecord>("POST", `${taskPath.value}/publish`);
    record.replace(next);
    publishOpen.value = false;
    return next;
  },
  { name: "发布结果", success: next => `发布已提交，任务状态：${TASK_STATUS_LABELS[next.status].label}` },
);

const streamText = computed(() => {
  switch (streamStatus.value) {
    case "live":
      return "实时更新中";
    case "polling":
      return "实时推送已断开，每 5 秒刷新一次";
    case "connecting":
      return "正在连接实时推送";
    case "closed":
      return "实时推送已停止";
    default:
      return sampleMode && live.value ? "样板数据模式：每 5 秒刷新一次" : "";
  }
});
</script>

<template>
  <section class="page" aria-labelledby="page-title-task">
    <StateView :state="record.state.value" subject="任务" @retry="record.reload">
      <template v-if="task">
        <div class="page-header">
          <div class="page-header__text">
            <RouterLink class="page-header__back" to="/tasks">返回任务列表</RouterLink>
            <h1 id="page-title-task" class="page-title">{{ TASK_KIND_LABELS[task.kind as TaskKind] }}任务</h1>
            <p class="page-lede mono">{{ task.id }}</p>
          </div>
          <div class="actions">
            <TxStatusBadge :text="TASK_STATUS_LABELS[task.status].label" :status="TASK_STATUS_LABELS[task.status].tone" />
            <TxButton v-if="task.status === 'awaiting_publish'" variant="primary" icon="i-carbon-send" :disabled="!canOperate" @click="publishOpen = true">发布结果</TxButton>
            <TxButton
              v-if="task.status === 'failed' || task.status === 'cancelled'"
              variant="secondary"
              icon="i-carbon-renew"
              :loading="requeue.pending.value"
              :disabled="!canOperate"
              @click="requeue.run()"
            >
              重新排队
            </TxButton>
            <TxButton v-if="!TASK_TERMINAL[task.status]" variant="danger" icon="i-carbon-close-outline" :disabled="!canOperate" @click="cancelOpen = true">取消任务</TxButton>
          </div>
        </div>

        <p v-if="streamText" class="section__hint" role="status" aria-live="polite">{{ streamText }}</p>

        <dl class="meta-list section">
          <div>
            <dt>项目</dt>
            <dd><RouterLink class="link" :to="`/projects/${encodeURIComponent(task.project_id)}`">{{ project?.name ?? task.project_id }}</RouterLink></dd>
          </div>
          <div v-if="task.demand_id">
            <dt>需求</dt>
            <dd><RouterLink class="link mono" :to="`/demands/${encodeURIComponent(task.demand_id)}`">{{ task.demand_id }}</RouterLink></dd>
          </div>
          <div v-if="task.item_id"><dt>条目</dt><dd class="mono">{{ task.item_id }}</dd></div>
          <div><dt>执行器</dt><dd>{{ EXECUTOR_LABELS[task.executor as Executor] }}</dd></div>
          <div><dt>资源预算</dt><dd>CPU {{ task.resources.cpu }} 核 · 内存 {{ task.resources.memory_mib }} MiB</dd></div>
          <div><dt>优先级</dt><dd>{{ task.priority }}</dd></div>
          <div>
            <dt>机器</dt>
            <dd>
              <RouterLink v-if="task.machine_id" class="link mono" :to="`/machines/${encodeURIComponent(task.machine_id)}`">{{ task.machine_id }}</RouterLink>
              <span v-else>未分配</span>
            </dd>
          </div>
          <div><dt>租约</dt><dd class="mono">{{ task.lease_id ? `${task.lease_id} · 第 ${task.epoch} 轮 · 到期 ${formatTime(task.lease_expires_at)}` : `没有租约 · 第 ${task.epoch} 轮` }}</dd></div>
          <div><dt>创建时间</dt><dd>{{ formatTime(task.created_at) }}</dd></div>
          <div><dt>更新时间</dt><dd>{{ formatTime(task.updated_at) }}</dd></div>
        </dl>

        <TxAlert v-if="task.error" :type="task.status === 'failed' ? 'error' : 'info'" :title="task.status === 'cancelled' ? '取消原因' : task.status === 'superseded' ? '作废原因' : task.status === 'awaiting_publish' ? '发布未确认' : '任务失败'" :closable="false">
          <span class="plain-text">{{ task.error }}</span>
        </TxAlert>

        <section class="section" aria-labelledby="result-title">
          <h2 id="result-title" class="section__title">结果</h2>
          <template v-if="task.result">
            <TxAlert
              v-if="task.status === 'awaiting_publish'"
              type="info"
              title="待发布"
              :message="`结果还没有写回平台。项目当前的写入模式：${project ? WRITE_MODE_LABELS[project.write_mode].label : '读取中'}。`"
              :closable="false"
            />
            <p class="plain-text result-summary">{{ task.result.summary }}</p>
            <p v-if="task.result.body" class="plain-text">{{ task.result.body }}</p>
            <template v-if="task.result.findings && task.result.findings.length">
              <h3 class="section__title">发现的问题</h3>
              <TxDataTable :columns="findingColumns" :data="[...task.result.findings]" :row-key="(_row: TaskFinding, index: number) => index" scroll-x>
                <template #cell-severity="{ row }">
                  <TxStatusBadge :text="SEVERITY_LABELS[row.severity as TaskFinding['severity']].label" :status="SEVERITY_LABELS[row.severity as TaskFinding['severity']].tone" size="sm" />
                </template>
                <template #cell-location="{ row }"><span class="mono">{{ row.path }}:{{ row.line }}</span></template>
                <template #cell-message="{ row }"><span class="plain-text">{{ row.message }}</span></template>
              </TxDataTable>
            </template>
            <template v-if="task.result.patch">
              <h3 class="section__title">补丁</h3>
              <pre class="code-block" tabindex="0" aria-label="补丁原文">{{ task.result.patch }}</pre>
            </template>
          </template>
          <p v-else class="section__hint">{{ TASK_TERMINAL[task.status] ? "这个任务没有产出结果。" : "任务完成后结果会显示在这里。" }}</p>
        </section>

        <section class="section" aria-labelledby="events-title">
          <h2 id="events-title" class="section__title">执行事件</h2>
          <StateView :state="events.state.value" subject="执行事件" empty-title="还没有事件" empty-description="任务被机器领取并开始执行后，输出、工具调用、模型切换与重试会按顺序列在这里。" @retry="events.reload">
            <TxDataTable :columns="eventColumns" :data="[...events.items.value]" row-key="seq" scroll-x empty-text="这一页没有事件">
              <template #cell-at="{ row }">{{ formatTime(row.at) }}</template>
              <template #cell-kind="{ row }">{{ EVENT_KIND_LABELS[row.kind as TaskEvent['kind']] ?? row.kind }}</template>
              <template #cell-text="{ row }"><span class="plain-text event-text">{{ row.text }}</span></template>
            </TxDataTable>
            <CursorPager :list="events" label="执行事件分页" />
          </StateView>
        </section>

        <ConfirmDialog v-model="cancelOpen" title="取消这个任务" confirm-label="取消任务" :pending="cancel.pending.value" :error="cancel.error.value" @confirm="cancel.run()">
          <p>排队中的任务直接取消；运行中的任务会通知机器终止并清理执行环境。取消后可以重新排队。</p>
        </ConfirmDialog>

        <ConfirmDialog v-model="publishOpen" title="发布任务结果" confirm-label="发布结果" tone="primary" :pending="publish.pending.value" :error="publish.error.value" @confirm="publish.run()">
          <p>项目当前的写入模式：{{ project ? WRITE_MODE_LABELS[project.write_mode].label : "读取失败，以控制面为准" }}。</p>
          <p>演练只在后台记录将要发布的内容；真实写入由控制面以连接账号的身份写回平台：审查只发评论，修复只推受保护的机器人分支并开变更。批准与合并始终由人来做。</p>
        </ConfirmDialog>
      </template>
    </StateView>
  </section>
</template>

<style scoped>
.result-summary {
  font-weight: 600;
}

.event-text {
  display: block;
  min-width: 24ch;
  max-width: 80ch;
}
</style>
