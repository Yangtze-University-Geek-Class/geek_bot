/**
 * 页面读取数据的两种形状：
 * - useCursorList：列表端点（ApiList），游标与筛选都写在地址栏里，刷新、分享后状态不丢（DESIGN「状态、表单和导航」）。
 * - useRecord：单个资源，带回 ETag 供随后的更新作为 If-Match。
 * 请求被新请求取代或组件卸载时取消，迟到的响应不覆盖新状态。
 */
import { computed, onBeforeUnmount, ref, watch, type ComputedRef, type Ref } from "vue";
import { useRoute, useRouter, type LocationQueryRaw } from "vue-router";
import type { ApiList } from "@geek-bot/protocol";
import { etagOf, withQuery } from "../lib/api.js";
import { stateFromError, type PageState } from "../lib/page-state.js";
import { useConsoleContext } from "./context.js";

/** 每页条数（API 允许 1–200）。 */
export const PAGE_SIZE = 50;

/** 地址栏查询参数的单个字符串值；数组或缺失时为空字符串。 */
export function queryText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * 改地址栏里的筛选：空字符串表示去掉这一项；同时去掉 resetKeys 里的游标，换了筛选就回到第一页。
 */
export function useQueryFilters(resetKeys: readonly string[] = ["cursor"]) {
  const route = useRoute();
  const router = useRouter();
  return (patch: Readonly<Record<string, string>>) => {
    const query: LocationQueryRaw = { ...route.query };
    for (const [key, value] of Object.entries(patch)) {
      if (value) query[key] = value;
      else delete query[key];
    }
    for (const key of resetKeys) delete query[key];
    void router.replace({ query });
  };
}

export interface CursorList<T> {
  readonly state: Ref<PageState<ApiList<T>>>;
  readonly items: ComputedRef<readonly T[]>;
  readonly hasNext: ComputedRef<boolean>;
  /** 不在第一页（地址栏里有游标）。 */
  readonly hasPrev: ComputedRef<boolean>;
  /** 重新读取当前页；quiet 为 true 时保留已显示的列表，不闪回加载状态（实时刷新用）。 */
  reload(quiet?: boolean): Promise<void>;
  next(): void;
  prev(): void;
  first(): void;
}

export interface CursorListOptions {
  /** 端点路径（不带查询串）；返回 null 时不请求（例如依赖的 id 还没有）。 */
  readonly path: () => string | null;
  /** 端点的筛选参数（来自地址栏）；变化时回到第一页。 */
  readonly filters?: () => Readonly<Record<string, string>>;
  /** 地址栏里存游标用的参数名；一页上有两个列表时区分开。 */
  readonly cursorKey?: string;
}

export function useCursorList<T>(options: CursorListOptions): CursorList<T> {
  const { api } = useConsoleContext();
  const route = useRoute();
  const router = useRouter();
  const cursorKey = options.cursorKey ?? "cursor";
  // 泛型 T 经 ref 的 UnwrapRef 后无法与声明的返回类型对上；记录本身不含 ref，按原类型持有。
  const state = ref<PageState<ApiList<T>>>({ kind: "loading" }) as Ref<PageState<ApiList<T>>>;
  /** 本次浏览里经过的游标，用来回到上一页；从分享的链接直接进入时为空，上一页即第一页。 */
  const trail = ref<string[]>([]);
  let controller: AbortController | null = null;

  const cursor = computed(() => queryText(route.query[cursorKey]));
  const filterKey = computed(() => JSON.stringify(options.filters?.() ?? {}));

  async function reload(quiet = false) {
    const path = options.path();
    controller?.abort();
    if (path === null) return;
    const current = new AbortController();
    controller = current;
    if (!quiet || state.value.kind !== "ready") state.value = { kind: "loading" };
    try {
      const url = withQuery(path, { ...(options.filters?.() ?? {}), limit: PAGE_SIZE, cursor: cursor.value });
      const data = await api.get<ApiList<T>>(url, { signal: current.signal });
      if (current.signal.aborted) return;
      state.value = data.items.length === 0 && cursor.value === "" ? { kind: "empty" } : { kind: "ready", data };
    } catch (error) {
      if (!current.signal.aborted) state.value = stateFromError(error);
    }
  }

  function setCursor(value: string) {
    const query: LocationQueryRaw = { ...route.query };
    if (value) query[cursorKey] = value;
    else delete query[cursorKey];
    void router.push({ query });
  }

  watch(filterKey, () => {
    trail.value = [];
  });
  watch([() => options.path(), filterKey, cursor], () => reload(), { immediate: true });
  onBeforeUnmount(() => controller?.abort());

  const data = computed(() => (state.value.kind === "ready" ? state.value.data : null));
  return {
    state,
    items: computed(() => data.value?.items ?? []),
    hasNext: computed(() => Boolean(data.value?.next_cursor)),
    hasPrev: computed(() => cursor.value !== ""),
    reload,
    next() {
      const nextCursor = data.value?.next_cursor;
      if (!nextCursor) return;
      trail.value = [...trail.value, cursor.value];
      setCursor(nextCursor);
    },
    prev() {
      const previous = trail.value.at(-1) ?? "";
      trail.value = trail.value.slice(0, -1);
      setCursor(previous);
    },
    first() {
      trail.value = [];
      setCursor("");
    },
  };
}

export interface RecordHandle<T> {
  readonly state: Ref<PageState<T>>;
  readonly data: ComputedRef<T | null>;
  readonly etag: Ref<string | null>;
  reload(): Promise<void>;
  /** 用更新接口返回的新记录替换当前数据，ETag 换成新的 revision。 */
  replace(next: T): void;
}

export function useRecord<T>(path: () => string | null): RecordHandle<T> {
  const { api } = useConsoleContext();
  const state = ref<PageState<T>>({ kind: "loading" }) as Ref<PageState<T>>;
  const etag = ref<string | null>(null);
  let controller: AbortController | null = null;
  let shownPath: string | null = null;

  async function reload() {
    const target = path();
    controller?.abort();
    if (target === null) return;
    const current = new AbortController();
    controller = current;
    // 同一个资源刷新时保留已显示的内容，不闪回加载状态；换了资源才显示加载。
    if (state.value.kind !== "ready" || shownPath !== target) state.value = { kind: "loading" };
    try {
      const result = await api.getVersioned<T>(target, { signal: current.signal });
      if (current.signal.aborted) return;
      const data = result.data;
      const revision = data !== null && typeof data === "object" && "revision" in data && typeof data.revision === "number" ? data.revision : null;
      etag.value = result.etag ?? (revision !== null ? etagOf(revision) : null);
      state.value = { kind: "ready", data: result.data };
      shownPath = target;
    } catch (error) {
      if (!current.signal.aborted) state.value = stateFromError(error);
    }
  }

  watch(path, reload, { immediate: true });
  onBeforeUnmount(() => controller?.abort());

  return {
    state,
    data: computed(() => (state.value.kind === "ready" ? state.value.data : null)),
    etag,
    reload,
    replace(next) {
      state.value = { kind: "ready", data: next };
      // 记录里没有 revision 时拿不到新的 ETag，重新读一次，免得下一次更新带着旧的 If-Match 被拒。
      if (next !== null && typeof next === "object" && "revision" in next && typeof next.revision === "number") etag.value = etagOf(next.revision);
      else void reload();
    },
  };
}
