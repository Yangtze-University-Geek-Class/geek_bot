/** @geek-bot/node 的入口。连 control、心跳、领租约等节点功能由 #11 起加入；目前只导出配置。 */
export { NODE_CONFIG_ENV, NODE_NAME_PATTERN, NODE_SLOT_DEFAULTS, NODE_SLOT_ENV, NodeConfigError, createNodeConfig } from "./config.js";
export type { Env, NodeConfig } from "./config.js";
