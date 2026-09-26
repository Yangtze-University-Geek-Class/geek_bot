/** 应用级的注入：API 客户端与运行模式。由 main.ts 在启动时提供，页面与外壳只经 inject 取用。 */
import { inject, type InjectionKey } from "vue";
import type { ApiClient } from "../lib/api.js";

export interface ConsoleContext {
  readonly api: ApiClient;
  /** 样板数据模式：数据全部虚构、不连控制面，界面上必须标明。 */
  readonly sampleMode: boolean;
}

export const CONSOLE_CONTEXT: InjectionKey<ConsoleContext> = Symbol("geek-bot-console");

export function useConsoleContext(): ConsoleContext {
  const context = inject(CONSOLE_CONTEXT);
  if (!context) throw new Error("没有提供 CONSOLE_CONTEXT：组件必须挂在 main.ts 创建的应用下");
  return context;
}
