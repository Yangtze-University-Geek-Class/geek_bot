import type { CodeProvider, ConnectionProvider } from "@geek-bot/protocol";
import { storedCredentials } from "./credentials.js";
import { GitHubConnector } from "./github.js";
import { GitLabConnector } from "./gitlab.js";
import { FeishuConnector, WebhookConnector } from "./im.js";
import { ConnectorError, type CodeConnector, type ConnectorOptions, type ImConnector, type ImConnectorOptions, type StoredConnectorOptions } from "./types.js";

export * from "./types.js";
export { sealCredentials, mergeSealedCredentials, requiredCredentialsMissing } from "./credentials.js";

type CodeFactory = (options: ConnectorOptions) => CodeConnector;
type ImFactory = (options: ImConnectorOptions) => ImConnector;
const codeFactories: Record<string, CodeFactory> = { github: options => new GitHubConnector(options), gitlab: options => new GitLabConnector(options) };
const imFactories: Record<string, ImFactory> = { feishu: options => new FeishuConnector(options), webhook: options => new WebhookConnector(options) };

/** 注册来自可信产品代码的适配器；绝不根据仓库或消息中的路径加载插件。 */
export function registerCodeConnector(provider: CodeProvider, factory: CodeFactory): void {
  if (codeFactories[provider]) throw new ConnectorError("connector_already_registered", "代码渠道适配器已经注册", 409);
  codeFactories[provider] = factory;
}
export function registerImConnector(provider: ConnectionProvider, factory: ImFactory): void {
  if (imFactories[provider]) throw new ConnectorError("connector_already_registered", "IM渠道适配器已经注册", 409);
  imFactories[provider] = factory;
}
export function createConnector(provider: ConnectionProvider, options: ConnectorOptions): CodeConnector {
  const factory = codeFactories[provider];
  if (!factory) throw new ConnectorError("connector_unavailable", "此连接不是已注册的代码渠道", 422);
  if (!options.token) throw new ConnectorError("connection_unconfigured", "代码渠道尚未绑定账号", 409);
  return factory(options);
}
export function createImConnector(provider: ConnectionProvider, options: ImConnectorOptions): ImConnector {
  const factory = imFactories[provider];
  if (!factory) throw new ConnectorError("connector_unavailable", "此连接不是已注册的IM渠道", 422);
  if (options.redactor) for (const [key, value] of Object.entries(options.credentials)) if (value && key !== "app_id") options.redactor.addKnownSecret(value);
  return factory(options);
}
export function connectorForConnection(options: StoredConnectorOptions): CodeConnector {
  if (!options.connection.enabled) throw new ConnectorError("connection_disabled", "渠道已禁用", 409);
  const credentials = storedCredentials(options.db, options.masterKey, options.connection.id, options.redactor);
  return createConnector(options.connection.provider, { baseUrl: options.connection.base_url, token: credentials.token ?? "", fetchImpl: options.fetchImpl, redactor: options.redactor });
}
export function imConnectorForConnection(options: StoredConnectorOptions): ImConnector {
  if (!options.connection.enabled) throw new ConnectorError("connection_disabled", "渠道已禁用", 409);
  const credentials = storedCredentials(options.db, options.masterKey, options.connection.id, options.redactor);
  return createImConnector(options.connection.provider, { baseUrl: options.connection.base_url, credentials, fetchImpl: options.fetchImpl, redactor: options.redactor });
}
