/**
 * 页面上每个写操作的执行与反馈：进行中状态、成功轻提示、失败持续提示（带 `HTTP 状态 · 机器码 · request id`）。
 * 服务端回 403 reauth_required 时先打开重新认证，认证成功后自动重试一次；放弃认证就按失败处理。
 * 样板数据模式下写请求被样板层拒绝（405），失败提示原样显示，不假装成功。
 */
import { ref, type Ref } from "vue";
import { toast } from "@talex-touch/tuffex/utils";
import { describeError, toApiError, type ApiError } from "../lib/api.js";
import { useConsoleContext } from "./context.js";

export interface Action<A extends unknown[], R> {
  readonly pending: Ref<boolean>;
  /** 最近一次失败；成功或重新执行时清空。表单用它在原位显示错误。 */
  readonly error: Ref<ApiError | null>;
  /** 执行；成功返回结果，失败返回 undefined（已提示）。 */
  run(...args: A): Promise<R | undefined>;
}

export interface ActionMessages<R> {
  /** 动作名，用在失败提示的标题里，例如「同步项目」。 */
  readonly name: string;
  /** 成功提示；返回 null 不提示（例如页面自己显示了结果）。 */
  readonly success?: (result: R) => string | null;
}

export function useAction<A extends unknown[], R>(perform: (...args: A) => Promise<R>, messages: ActionMessages<R>): Action<A, R> {
  const { session } = useConsoleContext();
  const pending = ref(false);
  const error = ref<ApiError | null>(null);

  async function attempt(args: A, allowReauth: boolean): Promise<R | undefined> {
    try {
      const result = await perform(...args);
      error.value = null;
      const text = messages.success?.(result);
      if (text) toast({ title: text, variant: "success" });
      return result;
    } catch (cause) {
      const apiError = toApiError(cause);
      if (allowReauth && apiError.code === "reauth_required" && (await session.requestReauth())) return attempt(args, false);
      if (apiError.status === 401) void session.load();
      error.value = apiError;
      toast({
        title: `${messages.name}失败`,
        description: `${apiError.message}（${describeError(apiError)}）`,
        variant: "danger",
        duration: 0,
      });
      return undefined;
    }
  }

  return {
    pending,
    error,
    async run(...args: A) {
      if (pending.value) return undefined;
      pending.value = true;
      try {
        return await attempt(args, true);
      } finally {
        pending.value = false;
      }
    },
  };
}
