<script setup lang="ts">
/**
 * 节点令牌只出现在登记或重置令牌的那一次响应里（API.md「路径与格式」），control 只存它的 SHA-256。
 * 这里明确写出「只显示这一次」，提供复制，并说明放到节点主机的哪里；关闭后页面上不再保留明文。
 */
import { TxAlert } from "@talex-touch/tuffex/alert";
import { TxButton, TxCopyButton } from "@talex-touch/tuffex/button";

defineProps<{ machineName: string; token: string }>();
const emit = defineEmits<{ dismiss: [] }>();
</script>

<template>
  <section class="section" aria-labelledby="node-token-title" role="alert">
    <h2 id="node-token-title" class="section__title">机器「{{ machineName }}」的节点令牌：只显示这一次</h2>
    <TxAlert
      type="warning"
      :closable="false"
      title="离开或关闭后无法再次查看"
      message="控制面只保存令牌的摘要。丢失后只能重置令牌，旧令牌会立即失效。"
    />
    <div class="secret-box">
      <code>{{ token }}</code>
      <TxCopyButton :text="token" copy-label="复制节点令牌" copied-label="已复制" size="sm" />
    </div>
    <p class="section__hint">
      把令牌写进节点主机上的令牌文件（只给节点进程读权限），节点通过 <span class="mono">GEEK_BOT_NODE_TOKEN_FILE</span> 读取它，然后启动或重启节点；节点第一次心跳后机器会出现在列表里。
    </p>
    <div class="actions">
      <TxButton variant="secondary" @click="emit('dismiss')">已保存，隐藏令牌</TxButton>
    </div>
  </section>
</template>
