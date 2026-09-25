/** @geek-bot/runner 的入口。解包任务、运行 omp、转发事件、按池降级等由 #14 起加入；目前只导出 omp 参数拼装。 */
export { ISSUE_CHANNEL_TOOLS, buildOmpArgs } from "./omp-args.js";
export type { OmpArgsInput } from "./omp-args.js";
