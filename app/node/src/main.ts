/**
 * 工作节点的可执行入口（dist/main.js）。与库入口 index.ts 分开：导入 index 不会启动服务。
 *
 *   GEEK_BOT_NODE_CONTROL_URL=https://geek-bot.example.com GEEK_BOT_NODE_NAME=node-1 \
 *   GEEK_BOT_NODE_TOKEN_FILE=/run/secrets/node_token node app/node/dist/main.js
 *
 * 启动检查：配置合法、令牌文件可读；control 地址是明文 http 时，主机名解析出的全部地址都必须是私网或回环
 * （同机 compose 网络或私有组网），指向公网地址时拒绝启动（docs/services/node/protocol.md「传输」）。
 * SIGTERM / SIGINT：停止领任务，在跑的任务停下并以 node_shutdown 回报后退出。
 */
import { lookup } from "node:dns/promises";
import { mkdirSync } from "node:fs";
import { isIP } from "node:net";
import { availableParallelism, totalmem } from "node:os";
import { NodeConfigError } from "./config.js";
import { isForbiddenAddress } from "./egress-proxy.js";
import { Worker } from "./worker.js";
import type { Logger } from "./worker.js";
import { createWorkerConfig } from "./worker-config.js";

const log: Logger = (level, message, fields = {}) => {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, message, ...fields });
  if (level === "error") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
};

/** 明文 http 只允许指向私网或回环地址。 */
async function assertPlaintextAllowed(controlUrl: string): Promise<void> {
  const url = new URL(controlUrl);
  if (url.protocol !== "http:") return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) !== 0 ? [host] : (await lookup(host, { all: true, verbatim: true })).map(entry => entry.address);
  const publicAddress = addresses.find(address => !isForbiddenAddress(address));
  if (addresses.length === 0 || publicAddress !== undefined) {
    throw new Error(`control 地址是明文 http，但 ${host} 解析到公网地址${publicAddress ? ` ${publicAddress}` : ""}；公网上必须用 https`);
  }
}

async function main(): Promise<number> {
  let worker: Worker;
  try {
    const config = createWorkerConfig(process.env, { cpus: availableParallelism(), memoryMib: Math.floor(totalmem() / 1024 / 1024) });
    await assertPlaintextAllowed(config.node.controlUrl);
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    worker = new Worker({ config, log });
  } catch (error) {
    const message = error instanceof NodeConfigError ? error.message : `节点启动失败：${error instanceof Error ? error.message : String(error)}`;
    log("error", message);
    return 78;
  }
  let stopping: Promise<void> | null = null;
  const onSignal = (signal: NodeJS.Signals): void => {
    log("info", "收到停机信号", { signal });
    stopping ??= worker.shutdown();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  try {
    await worker.run();
  } catch (error) {
    log("error", "节点异常退出", { error: error instanceof Error ? error.message : String(error) });
    await worker.shutdown();
    return 1;
  }
  await stopping;
  return 0;
}

void main().then(code => process.exit(code));
