/**
 * 页面里按 id 显示连接名称、做连接筛选用的连接清单。实例里的连接数量很少（一个平台账号一个），
 * 一次读一页最多 200 条；读不到时只显示 id，不影响主列表。
 */
import { computed, ref } from "vue";
import type { ApiList, ConnectionRecord } from "@geek-bot/protocol";
import { withQuery } from "../lib/api.js";
import { PROVIDER_LABELS } from "../lib/labels.js";
import { useConsoleContext } from "./context.js";

export function useConnectionDirectory() {
  const { api } = useConsoleContext();
  const connections = ref<readonly ConnectionRecord[]>([]);
  const loaded = ref(false);

  void api
    .get<ApiList<ConnectionRecord>>(withQuery("/api/v1/connections", { limit: 200 }))
    .then(page => {
      connections.value = page.items;
    })
    .catch(() => {
      connections.value = [];
    })
    .finally(() => {
      loaded.value = true;
    });

  const byId = computed(() => new Map(connections.value.map(connection => [connection.id, connection])));
  return {
    connections,
    loaded,
    nameOf(id: string): string {
      const connection = byId.value.get(id);
      return connection ? `${connection.name}（${PROVIDER_LABELS[connection.provider]}）` : id;
    },
  };
}
