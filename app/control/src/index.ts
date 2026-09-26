/**
 * control 的进程入口：只负责启动、监听和接信号（MODULAR-DEVELOPMENT「control 内部的计划分层」）。
 * 启动检查、迁移、组装都在 src/services.ts；镜像的 CMD 运行构建后的 dist/index.js。
 * 拒绝启动时 services 已经用中文记了原因，这里只以非 0 退出。
 */
import { ControlStartupError, installSignalHandlers, startControl } from "./services.js";

async function main(): Promise<void> {
  let handle;
  try {
    handle = await startControl({ env: process.env });
  } catch (error) {
    if (!(error instanceof ControlStartupError)) console.error(error);
    process.exit(1);
  }
  installSignalHandlers(process, handle, code => process.exit(code));
  try {
    await handle.listen();
  } catch (error) {
    handle.logger.fatal({ err: error }, "监听失败");
    await handle.shutdown("listen_failed").catch(() => undefined);
    process.exit(1);
  }
}

void main();
