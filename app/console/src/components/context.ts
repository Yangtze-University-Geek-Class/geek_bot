/**
 * 应用级的注入：API 客户端、运行模式与当前会话。由 main.ts 在启动时提供，页面与外壳只经 inject 取用。
 * 会话只用来决定界面上显示什么；能不能操作始终由 control 在服务端判断（DESIGN「硬性规则」）。
 */
import { inject, ref, type InjectionKey, type Ref } from "vue";
import type { AdminRole, MeResponse } from "@geek-bot/protocol";
import { toApiError, type ApiClient, type ApiError } from "../lib/api.js";

/** unknown：还没读过；authenticated：有会话；anonymous：没有会话（401）或实例未认领（409 not_claimed）；error：读不到。 */
export type SessionStatus = "unknown" | "authenticated" | "anonymous" | "error";

const ROLE_RANK: Readonly<Record<AdminRole, number>> = { viewer: 0, operator: 1, owner: 2 };

export interface Session {
  readonly me: Ref<MeResponse | null>;
  readonly status: Ref<SessionStatus>;
  readonly error: Ref<ApiError | null>;
  /** 重新读取 `/api/v1/me`。 */
  load(): Promise<void>;
  /** 会话角色至少是 need（只用于界面提示）。 */
  allows(need: AdminRole): boolean;
  /** 打开重新认证（device flow，purpose=reauth）；成功返回 true，放弃返回 false。 */
  requestReauth(): Promise<boolean>;
  /** 外壳里的重新认证弹层读这一项：非 null 时显示，完成后调用 settle。 */
  readonly reauthRequest: Ref<{ settle: (ok: boolean) => void } | null>;
}

export function createSession(api: ApiClient): Session {
  const me = ref<MeResponse | null>(null);
  const status = ref<SessionStatus>("unknown");
  const error = ref<ApiError | null>(null);
  const reauthRequest = ref<{ settle: (ok: boolean) => void } | null>(null);
  let pendingReauth: Promise<boolean> | null = null;

  return {
    me,
    status,
    error,
    reauthRequest,
    async load() {
      try {
        me.value = await api.get<MeResponse>("/api/v1/me");
        status.value = "authenticated";
        error.value = null;
      } catch (cause) {
        const apiError = toApiError(cause);
        me.value = null;
        const anonymous = apiError.status === 401 || apiError.code === "not_claimed";
        status.value = anonymous ? "anonymous" : "error";
        error.value = anonymous ? null : apiError;
      }
    },
    allows(need) {
      return me.value !== null && ROLE_RANK[me.value.role] >= ROLE_RANK[need];
    },
    requestReauth() {
      pendingReauth ??= new Promise<boolean>(resolve => {
        reauthRequest.value = {
          settle: ok => {
            reauthRequest.value = null;
            pendingReauth = null;
            resolve(ok);
          },
        };
      });
      return pendingReauth;
    },
  };
}

export interface ConsoleContext {
  readonly api: ApiClient;
  /** 样板数据模式：数据全部虚构、不连控制面、写请求一律被拒绝，界面上必须标明。 */
  readonly sampleMode: boolean;
  readonly session: Session;
}

export const CONSOLE_CONTEXT: InjectionKey<ConsoleContext> = Symbol("geek-bot-console");

export function useConsoleContext(): ConsoleContext {
  const context = inject(CONSOLE_CONTEXT);
  if (!context) throw new Error("没有提供 CONSOLE_CONTEXT：组件必须挂在 main.ts 创建的应用下");
  return context;
}
