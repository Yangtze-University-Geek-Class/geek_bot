/**
 * 工作节点进程的完整配置：在 createNodeConfig（control 地址、节点名、槽位上限）之上，加上令牌文件、标签、
 * 本机可分配的资源、工作目录、sandbox 槽位目录、VM 资产与出网代理规则。纯函数：调用方传入环境变量表与宿主默认值，
 * 本文件不读 process.env，也不读令牌文件内容；任一项不合法时抛 NodeConfigError，一次列出全部问题。
 */
import { isAbsolute } from "node:path";
import { createNodeConfig, NodeConfigError } from "./config.js";
import type { Env, NodeConfig } from "./config.js";

export interface HostDefaults {
  /** 宿主的逻辑 CPU 数。 */
  readonly cpus: number;
  /** 宿主的总内存（MiB）。 */
  readonly memoryMib: number;
}

export interface VmAssets {
  readonly qemu: string;
  readonly qemuImg: string;
  /** guestfwd 的 cmd: 转发用的 netcat（需要支持 -U）。 */
  readonly netcat: string;
  readonly baseImage: string;
  readonly toolsImage: string;
  readonly seedIso: string;
  readonly diskGib: number;
}

export interface EgressConfig {
  /** 允许的域名后缀；为空时 VM 不能出网。 */
  readonly allow: readonly string[];
  /** 在内置禁止地址段之外追加的 CIDR（例如部署者的组网网段）。 */
  readonly denyCidrs: readonly string[];
  readonly maxConnections: number;
  readonly maxBytes: number;
}

export interface WorkerConfig {
  readonly node: NodeConfig;
  readonly tokenFile: string;
  readonly tags: readonly string[];
  /** 本机交给平台调度的资源上限。 */
  readonly capacity: { readonly cpu: number; readonly memory_mib: number };
  readonly dataDir: string;
  readonly slotsDir: string;
  readonly vm: VmAssets;
  readonly egress: EgressConfig;
  readonly heartbeatIntervalS: number;
  /** 每个任务的磁盘事件缓存上限（字节）；超过时先丢文本事件，保留工具、错误、重试与模型事件。 */
  readonly spoolMaxBytes: number;
  /** sandbox 与 VM 里的 omp 必须报出的版本（形如 omp/18.4.4，节点镜像构建时写入）；null 表示不比较。 */
  readonly ompVersion: string | null;
}

export const WORKER_CONFIG_ENV = Object.freeze({
  tokenFile: "GEEK_BOT_NODE_TOKEN_FILE",
  tags: "GEEK_BOT_NODE_TAGS",
  cpu: "GEEK_BOT_NODE_CPU",
  memoryMib: "GEEK_BOT_NODE_MEMORY_MIB",
  dataDir: "GEEK_BOT_NODE_DATA_DIR",
  slotsDir: "GEEK_BOT_NODE_SLOTS_DIR",
  qemu: "GEEK_BOT_NODE_QEMU",
  qemuImg: "GEEK_BOT_NODE_QEMU_IMG",
  netcat: "GEEK_BOT_NODE_NETCAT",
  vmBaseImage: "GEEK_BOT_NODE_VM_BASE_IMAGE",
  vmToolsImage: "GEEK_BOT_NODE_VM_TOOLS_IMAGE",
  vmSeedIso: "GEEK_BOT_NODE_VM_SEED_ISO",
  vmDiskGib: "GEEK_BOT_NODE_VM_DISK_GIB",
  egressAllow: "GEEK_BOT_NODE_EGRESS_ALLOW",
  egressDenyCidrs: "GEEK_BOT_NODE_EGRESS_DENY_CIDRS",
  egressMaxConnections: "GEEK_BOT_NODE_EGRESS_MAX_CONNECTIONS",
  egressMaxBytes: "GEEK_BOT_NODE_EGRESS_MAX_BYTES",
  heartbeatSeconds: "GEEK_BOT_NODE_HEARTBEAT_SECONDS",
  spoolMaxMib: "GEEK_BOT_NODE_SPOOL_MAX_MIB",
  ompVersion: "GEEK_BOT_NODE_OMP_VERSION",
});

const TAG_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,62}$/;
const DOMAIN_SUFFIX_PATTERN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const CIDR_PATTERN = /^(?:\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}|[0-9a-f:]+\/\d{1,3})$/i;

function text(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function integer(env: Env, name: string, fallback: number, min: number, max: number, problems: string[]): number {
  const raw = text(env, name);
  if (raw === undefined) return fallback;
  const value = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
  if (Number.isSafeInteger(value) && value >= min && value <= max) return value;
  problems.push(`${name} 必须是 ${min} 到 ${max} 之间的整数，当前值：${JSON.stringify(raw)}`);
  return fallback;
}

function path(env: Env, name: string, fallback: string, problems: string[]): string {
  const value = text(env, name) ?? fallback;
  if (!isAbsolute(value) || value.includes(",") || /\s/.test(value)) problems.push(`${name} 必须是不含逗号与空白的绝对路径，当前值：${JSON.stringify(value)}`);
  return value;
}

function command(env: Env, name: string, fallback: string, problems: string[]): string {
  const value = text(env, name) ?? fallback;
  if (!/^[A-Za-z0-9_./-]+$/.test(value)) problems.push(`${name} 只能是程序名或绝对路径，当前值：${JSON.stringify(value)}`);
  return value;
}

function list(env: Env, name: string): string[] {
  return (text(env, name) ?? "").split(",").map(item => item.trim().toLowerCase()).filter(Boolean);
}

/** 生成工作节点配置；不合法时抛 NodeConfigError。 */
export function createWorkerConfig(env: Env, host: HostDefaults): WorkerConfig {
  const problems: string[] = [];
  let node: NodeConfig | null = null;
  try {
    node = createNodeConfig(env);
  } catch (error) {
    if (error instanceof NodeConfigError) problems.push(...error.problems);
    else throw error;
  }
  const tokenFile = text(env, WORKER_CONFIG_ENV.tokenFile);
  if (tokenFile === undefined) problems.push(`缺少环境变量 ${WORKER_CONFIG_ENV.tokenFile}（节点令牌文件的路径）`);
  else if (!isAbsolute(tokenFile)) problems.push(`${WORKER_CONFIG_ENV.tokenFile} 必须是绝对路径`);

  const tags = list(env, WORKER_CONFIG_ENV.tags);
  for (const tag of tags) if (!TAG_PATTERN.test(tag)) problems.push(`${WORKER_CONFIG_ENV.tags} 里的标签不合法：${JSON.stringify(tag)}`);
  if (tags.length > 32) problems.push(`${WORKER_CONFIG_ENV.tags} 最多 32 个标签`);

  const cpu = integer(env, WORKER_CONFIG_ENV.cpu, Math.max(1, host.cpus), 1, 256, problems);
  const memoryMib = integer(env, WORKER_CONFIG_ENV.memoryMib, Math.max(128, host.memoryMib), 128, 1_048_576, problems);
  const dataDir = path(env, WORKER_CONFIG_ENV.dataDir, "/var/lib/geek-bot", problems);
  const slotsDir = path(env, WORKER_CONFIG_ENV.slotsDir, `${dataDir}/slots`, problems);

  const vm: VmAssets = {
    qemu: command(env, WORKER_CONFIG_ENV.qemu, "qemu-system-x86_64", problems),
    qemuImg: command(env, WORKER_CONFIG_ENV.qemuImg, "qemu-img", problems),
    netcat: command(env, WORKER_CONFIG_ENV.netcat, "nc", problems),
    baseImage: path(env, WORKER_CONFIG_ENV.vmBaseImage, "/opt/geekbot/vm/base.qcow2", problems),
    toolsImage: path(env, WORKER_CONFIG_ENV.vmToolsImage, "/opt/geekbot/vm/tools.img", problems),
    seedIso: path(env, WORKER_CONFIG_ENV.vmSeedIso, "/opt/geekbot/vm/seed.iso", problems),
    diskGib: integer(env, WORKER_CONFIG_ENV.vmDiskGib, 20, 4, 512, problems),
  };

  const allow = list(env, WORKER_CONFIG_ENV.egressAllow);
  for (const suffix of allow) if (!DOMAIN_SUFFIX_PATTERN.test(suffix)) problems.push(`${WORKER_CONFIG_ENV.egressAllow} 里的域名不合法：${JSON.stringify(suffix)}`);
  const denyCidrs = list(env, WORKER_CONFIG_ENV.egressDenyCidrs);
  for (const cidr of denyCidrs) if (!CIDR_PATTERN.test(cidr)) problems.push(`${WORKER_CONFIG_ENV.egressDenyCidrs} 里的网段不合法：${JSON.stringify(cidr)}`);
  const egress: EgressConfig = {
    allow,
    denyCidrs,
    maxConnections: integer(env, WORKER_CONFIG_ENV.egressMaxConnections, 512, 1, 100_000, problems),
    maxBytes: integer(env, WORKER_CONFIG_ENV.egressMaxBytes, 4 * 1024 ** 3, 1024 * 1024, 1024 ** 4, problems),
  };
  const heartbeatIntervalS = integer(env, WORKER_CONFIG_ENV.heartbeatSeconds, 10, 2, 60, problems);
  const spoolMaxBytes = integer(env, WORKER_CONFIG_ENV.spoolMaxMib, 200, 1, 10_240, problems) * 1024 * 1024;
  const ompVersionRaw = text(env, WORKER_CONFIG_ENV.ompVersion);
  const ompVersion = ompVersionRaw === undefined ? null : ompVersionRaw.startsWith("omp/") ? ompVersionRaw : `omp/${ompVersionRaw}`;
  if (ompVersion !== null && !/^omp\/\d+\.\d+\.\d+$/.test(ompVersion)) problems.push(`${WORKER_CONFIG_ENV.ompVersion} 必须形如 18.4.4，当前值：${JSON.stringify(ompVersionRaw)}`);

  if (problems.length > 0 || node === null || tokenFile === undefined) throw new NodeConfigError(problems);
  return Object.freeze({
    node,
    tokenFile,
    tags: Object.freeze(tags),
    capacity: Object.freeze({ cpu, memory_mib: memoryMib }),
    dataDir,
    slotsDir,
    vm: Object.freeze(vm),
    egress: Object.freeze({ ...egress, allow: Object.freeze(allow), denyCidrs: Object.freeze(denyCidrs) }),
    heartbeatIntervalS,
    spoolMaxBytes,
    ompVersion,
  });
}
