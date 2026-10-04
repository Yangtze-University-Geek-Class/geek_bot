/** 路由模块拿到的服务集合（路由只做 HTTP 映射、授权声明与调用，业务规则都在这些服务里）。 */
import type { AdminsService } from "./admins.js";
import type { AuthService } from "./auth.js";
import type { ConnectionsService } from "./connections.js";
import type { PlatformContext } from "./context.js";
import type { DemandsService } from "./demands.js";
import type { MachinesService } from "./machines.js";
import type { ModelsService } from "./models.js";
import type { RelayService } from "./relay.js";
import type { ConsoleAssets } from "./static.js";
import type { TasksService } from "./tasks.js";

export interface PlatformServices {
  readonly ctx: PlatformContext;
  readonly auth: AuthService;
  readonly admins: AdminsService;
  readonly connections: ConnectionsService;
  readonly demands: DemandsService;
  readonly machines: MachinesService;
  readonly tasks: TasksService;
  readonly models: ModelsService;
  readonly relay: RelayService;
  readonly assets: ConsoleAssets;
}
