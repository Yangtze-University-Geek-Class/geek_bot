/**
 * runner 程序入口（打包为单文件 dist/runner.mjs）：
 *   runner.mjs slot [--socket <path>] [--work <dir>] [--omp <path>] [--omp-data <dir>]
 *   runner.mjs vm --input <dev> --output <dev> --events <port> --token-file <path> --run-as <user>
 *                 [--work <dir>] [--omp <path>] [--omp-data <dir>] [--node-bin <dir>]
 *   runner.mjs --version
 * 参数不认识时打印用法并以 2 退出。
 */
import { RUNNER_VERSION } from "./probe.js";
import { runSlot } from "./slot.js";
import { runVm } from "./vm.js";

const USAGE = [
  "用法：",
  "  runner.mjs slot [--socket /run/geek-bot/node.sock] [--work /work] [--omp /opt/geekbot/omp/omp] [--omp-data /opt/geekbot/omp-data]",
  "  runner.mjs vm --input <设备> --output <设备> --events <virtio 端口> --token-file <fw_cfg 文件> --run-as <用户>",
  "                [--work /work] [--omp /opt/geekbot/omp/omp] [--omp-data /opt/geekbot/omp-data] [--node-bin /opt/geekbot/node/bin]",
].join("\n");

const DEFAULTS: Readonly<Record<string, string>> = Object.freeze({
  "--socket": "/run/geek-bot/node.sock",
  "--work": "/work",
  "--omp": "/opt/geekbot/omp/omp",
  "--omp-data": "/opt/geekbot/omp-data",
  "--node-bin": "/opt/geekbot/node/bin",
});

const FLAGS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  slot: ["--socket", "--work", "--omp", "--omp-data"],
  vm: ["--input", "--output", "--events", "--token-file", "--run-as", "--work", "--omp", "--omp-data", "--node-bin"],
});

function parseFlags(mode: string, argv: readonly string[]): Map<string, string> {
  const allowed = FLAGS[mode];
  if (!allowed) throw new Error(`不认识的模式：${mode}`);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.includes(flag)) throw new Error(`不认识的参数：${flag}`);
    if (value === undefined || value === "") throw new Error(`参数缺值：${flag}`);
    values.set(flag, value);
  }
  for (const flag of allowed) if (!values.has(flag) && DEFAULTS[flag] !== undefined) values.set(flag, DEFAULTS[flag]);
  for (const flag of allowed) if (!values.has(flag)) throw new Error(`缺少参数：${flag}`);
  return values;
}

async function main(argv: readonly string[]): Promise<number> {
  const [mode, ...rest] = argv;
  if (mode === "--version" && rest.length === 0) {
    process.stdout.write(`geekbot-runner/${RUNNER_VERSION}\n`);
    return 0;
  }
  let flags: Map<string, string>;
  try {
    flags = parseFlags(mode ?? "", rest);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
    return 2;
  }
  const flag = (name: string): string => flags.get(name) ?? "";
  if (mode === "slot") {
    return runSlot({ socketPath: flag("--socket"), workRoot: flag("--work"), ompPath: flag("--omp"), ompDataDir: flag("--omp-data") });
  }
  return runVm({
    inputDevice: flag("--input"),
    outputDevice: flag("--output"),
    eventsPort: flag("--events"),
    tokenFile: flag("--token-file"),
    runAs: flag("--run-as"),
    workRoot: flag("--work"),
    ompPath: flag("--omp"),
    ompDataDir: flag("--omp-data"),
    nodeBinDir: flag("--node-bin"),
  });
}

// 一个进程只做一件事：结束后立即退出，不让残留的 keep-alive 连接拖住进程（sandbox 靠重启拿到干净的 tmpfs）。
main(process.argv.slice(2)).then(
  code => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`runner 异常退出：${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
