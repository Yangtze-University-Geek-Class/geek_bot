/** 外壳用到的浏览器环境：网络是否在线、是否窄屏。组件卸载时移除监听。 */
import { onBeforeUnmount, ref, type Ref } from "vue";

/** 窄屏断点：宽度小于它时侧栏收进抽屉（docs/services/console/README.md「窄屏断点」）。 */
export const NARROW_QUERY = "(max-width: 959.98px)";

export function useOnline(): Ref<boolean> {
  const online = ref(typeof navigator === "undefined" ? true : navigator.onLine);
  const update = () => {
    online.value = navigator.onLine;
  };
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  onBeforeUnmount(() => {
    window.removeEventListener("online", update);
    window.removeEventListener("offline", update);
  });
  return online;
}

export function useMediaQuery(query: string): Ref<boolean> {
  const list = window.matchMedia(query);
  const matches = ref(list.matches);
  const update = (event: MediaQueryListEvent) => {
    matches.value = event.matches;
  };
  list.addEventListener("change", update);
  onBeforeUnmount(() => list.removeEventListener("change", update));
  return matches;
}
