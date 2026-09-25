/** @geek-bot/control 的入口。服务进程（Fastify 5 + better-sqlite3）由 #3 加入；目前只导出配置。 */
export { CONTROL_DEFAULTS, CONTROL_ENV, ControlConfigError, createControlConfig } from "./config.js";
export type { ControlConfig, Env } from "./config.js";
