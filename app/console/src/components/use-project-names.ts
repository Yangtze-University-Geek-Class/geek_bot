/**
 * 列表里按项目 id 显示项目名称：对当前页出现的 id 逐个读取（同一 id 只读一次），读不到时显示 id。
 * 需求和任务记录只带 project_id，后台没有批量查名称的端点。
 */
import { reactive, watch, type WatchSource } from "vue";
import type { ProjectRecord } from "@geek-bot/protocol";
import { useConsoleContext } from "./context.js";

export function useProjectNames(ids: WatchSource<readonly (string | null)[]>) {
  const { api } = useConsoleContext();
  const names = reactive(new Map<string, string>());
  const requested = new Set<string>();

  watch(
    ids,
    list => {
      for (const id of list) {
        if (!id || requested.has(id)) continue;
        requested.add(id);
        api
          .get<ProjectRecord>(`/api/v1/projects/${encodeURIComponent(id)}`)
          .then(project => names.set(id, project.name))
          .catch(() => names.set(id, id));
      }
    },
    { immediate: true },
  );

  return (id: string) => names.get(id) ?? id;
}
