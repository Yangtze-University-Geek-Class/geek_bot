/**
 * 单实例共享平台（#34）的组装：配置与密钥、服务、路由与生命周期。
 *
 *   const platform = createSharedPlatform({ db, masterKey, env, deployment, clock, redactor, logger, fetchImpl });
 *   platform.register(app);   // 后台 API、IM 入站、节点 API、SSE、console 静态托管与 /api/release
 *   platform.start();         // 定时同步（同步后按项目开关自动入队）、租约收回、publisher 对账
 *   await platform.stop();    // 停机前调用
 *   platform.bootstrapCode(); // CLI 经运维本地通道生成认领码
 *
 * 出网请求（GitHub、GitLab、Feishu、模型网关）只经注入的 fetchImpl，测试注入打桩并默认拒绝网络。
 */
import type { FastifyInstance } from "fastify";
import type { Env } from "../config.js";
import { createAlerts } from "../db/alerts.js";
import { createAuditor } from "../db/audit.js";
import type { Db } from "../db/database.js";
import type { Logger } from "../log/logger.js";
import type { Redactor } from "../log/redact.js";
import { createPublisher } from "../publisher/index.js";
import { registerAdminRoutes } from "../routes/platform/admins/index.js";
import { registerAuthRoutes } from "../routes/platform/auth/index.js";
import { registerConnectionRoutes } from "../routes/platform/connections/index.js";
import { registerConsoleRoutes } from "../routes/platform/console/index.js";
import { registerDemandRoutes } from "../routes/platform/demands/index.js";
import { registerMachineRoutes } from "../routes/platform/machines/index.js";
import { registerModelRoutes } from "../routes/platform/models/index.js";
import { registerNodeRoutes } from "../routes/platform/node/index.js";
import { registerProjectRoutes } from "../routes/platform/projects/index.js";
import { registerStreamRoutes } from "../routes/platform/stream/index.js";
import { registerTaskRoutes } from "../routes/platform/tasks/index.js";
import { createAdminsService } from "./admins.js";
import { createAuthService, issueBootstrapCode } from "./auth.js";
import { loadPlatformConfig, loadPlatformSecrets, type DeploymentView, type PlatformConfig } from "./config.js";
import { createConnectionsService } from "./connections.js";
import { createIdempotencyStore, createLocalVault, createRateLimiter, type FetchImpl, type PlatformContext } from "./context.js";
import { createDemandsService } from "./demands.js";
import { createEventBus } from "./events.js";
import { createCookieSigner } from "./http.js";
import { createRepositoryIntake } from "./intake.js";
import { createMachinesService } from "./machines.js";
import { createModelsService } from "./models.js";
import type { PlatformServices } from "./registry.js";
import { createRelayService } from "./relay.js";
import { installConsoleGuards } from "./security.js";
import { createConsoleAssets } from "./static.js";
import { createTasksService, type DemandNotifier } from "./tasks.js";

export { PlatformConfigError } from "./config.js";
export { PlatformError } from "./http.js";
export { issueBootstrapCode } from "./auth.js";

export interface SharedPlatformOptions {
  readonly db: Db;
  readonly masterKey: Buffer;
  /** 只用于核对会话签名密钥与它不是同一把；平台不用它加解密任何数据。 */
  readonly backupKey: Buffer;
  readonly env: Env;
  readonly deployment: DeploymentView;
  readonly clock: () => number;
  readonly redactor: Redactor;
  readonly logger: Logger;
  /** 出网请求的实现；默认全局 fetch。测试注入打桩。 */
  readonly fetchImpl?: FetchImpl;
  readonly cwd?: string;
}

export interface SharedPlatform {
  readonly config: PlatformConfig;
  readonly services: PlatformServices;
  register(app: FastifyInstance): void;
  start(): void;
  stop(): Promise<void>;
  /** 生成一枚认领码（只给 CLI 经运维本地通道调用）；已认领时抛 PlatformError already_claimed。 */
  bootstrapCode(): { code: string; expiresAt: string };
}

/** 读配置与密钥、建服务；配置或密钥不合法时抛 PlatformConfigError（只含变量名）。 */
export function createSharedPlatform(options: SharedPlatformOptions): SharedPlatform {
  const { db, masterKey, env, clock, redactor, logger } = options;
  const config = loadPlatformConfig(env, options.deployment, options.cwd);
  const secrets = loadPlatformSecrets(config, masterKey, options.backupKey, redactor);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  const ctx: PlatformContext = {
    db,
    clock,
    config,
    secrets,
    masterKey,
    redactor,
    logger,
    auditor: createAuditor(db, redactor, clock),
    alerts: createAlerts(db, redactor, clock),
    bus: createEventBus(redactor, clock),
    fetchImpl,
    signer: createCookieSigner(secrets.sessionKey),
    limiter: createRateLimiter(clock),
    idempotency: createIdempotencyStore(db, clock),
    vault: createLocalVault(masterKey, "oauth-flow"),
  };

  const publisher = createPublisher({ db, masterKey, env, clock, redactor, logger, fetchImpl });
  const auth = createAuthService(ctx);
  const models = createModelsService(ctx);
  // IM 回传：只有 IM 入站（带来源连接）的需求才回传；在当前事务提交之后的微任务里交给 publisher 的 outbox，
  // 不阻塞入站回调与节点报告。publisher 自己做写入模式、连接启用、去重和 unknown 对账。
  const notifier: DemandNotifier = (demand, text, task) => {
    if (demand.source_connection_id === null || (demand.source !== "feishu" && demand.source !== "webhook")) return;
    queueMicrotask(() => {
      publisher.notifyDemand(demand, text, task).catch((error: unknown) => logger.warn({ demand_id: demand.id, err: error }, "需求回传排队失败"));
    });
  };
  const tasks = createTasksService(ctx, models, publisher, notifier);
  // 平台条目的自动入队：同步落库后按项目开关挑条目，由任务服务以系统身份建任务。
  const intake = createRepositoryIntake(ctx, tasks);
  const connections = createConnectionsService(ctx, {
    supersedeStale: (itemId, headSha) => tasks.supersedeStale(itemId, headSha),
    itemsSynced: projectId => intake.afterSync(projectId),
  });
  const services: PlatformServices = {
    ctx,
    auth,
    admins: createAdminsService(ctx, githubId => auth.dropSessions(githubId)),
    connections,
    demands: createDemandsService(ctx, notifier),
    machines: createMachinesService(ctx, tasks),
    tasks,
    models,
    relay: createRelayService(ctx, tasks),
    assets: createConsoleAssets(config.consoleDist),
  };
  if (!services.assets.available) logger.info("没有找到 console 的构建产物，不托管后台页面（先构建 app/console，或设置 GEEK_BOT_CONSOLE_DIST）");

  return {
    config,
    services,
    register(app) {
      void app.register(async scope => {
        installConsoleGuards(scope, ctx, auth);
        registerAuthRoutes(scope, services);
        registerAdminRoutes(scope, services);
        registerConnectionRoutes(scope, services);
        registerProjectRoutes(scope, services);
        registerDemandRoutes(scope, services);
        registerMachineRoutes(scope, services);
        registerTaskRoutes(scope, services);
        registerModelRoutes(scope, services);
        registerStreamRoutes(scope, services);
      });
      registerNodeRoutes(app, services);
      registerConsoleRoutes(app, services);
    },
    start() {
      tasks.start();
      connections.startPolling();
      publisher.start();
      // 启动时读一次 catalog：配置错误尽早告警。
      models.catalog();
    },
    async stop() {
      tasks.stop();
      await connections.stopPolling();
      await publisher.stop();
    },
    bootstrapCode() {
      return issueBootstrapCode(ctx);
    },
  };
}
