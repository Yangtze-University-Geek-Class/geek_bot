/**
 * control 的配置：产品默认值（可以用环境变量覆盖的行为数值）与部署配置（实例角色、监听地址、库路径、密钥文件路径等）。
 * 这里只做纯计算：调用方传入环境变量表，本文件不读 process.env，也不读文件。
 * 密钥只从 `*_FILE` 指向的文件读取，由 src/secrets/key-files.ts 负责；这里只解析路径（`*_KEY_FILE` 只接受路径的写法，
 * 不合规时不回显值），并拒绝直接写值的密钥变量。
 */
import { dirname, isAbsolute, join, resolve } from "node:path";

export type Env = Readonly<Record<string, string | undefined>>;

export interface ControlConfig {
  /** 轮询已监控仓库的间隔（秒）。 */
  readonly pollIntervalSeconds: number;
  /** 静默窗口（秒）：最后一次非机器人变动之后等这么久才入队。 */
  readonly quietWindowSeconds: number;
  /** 等回复的第几天发提醒。 */
  readonly remindAfterDays: number;
  /** 等回复的第几天关闭 issue，必须晚于提醒。 */
  readonly closeAfterDays: number;
  /** 同一个 issue 最多追问几轮。 */
  readonly maxFollowUpRounds: number;
  /** PR 通道每台临时 VM 的 vCPU 数。 */
  readonly vmVcpus: number;
  /** PR 通道每台临时 VM 的内存（MiB）。 */
  readonly vmMemoryMiB: number;
  /** 保留几份每日备份。 */
  readonly backupKeepDaily: number;
  /** 保留几份每周备份（每周第一次每日备份记为每周；为 0 时不做每周备份，每周第一次也记为每日）。 */
  readonly backupKeepWeekly: number;
  /** 每天在 UTC 的第几点之后做当天的备份与恢复校验（0–23）。 */
  readonly backupHourUtc: number;
}

type ControlKey = keyof ControlConfig;

/**
 * 产品默认值：轮询 60 秒、静默窗口 300 秒、第 5 天提醒、第 7 天关闭、最多追问 2 轮、每台 VM 1 vCPU / 2 GiB；
 * 备份保留 7 份每日加 4 份每周，每天 UTC 03:00 之后备份一次。
 */
export const CONTROL_DEFAULTS: ControlConfig = Object.freeze({
  pollIntervalSeconds: 60,
  quietWindowSeconds: 300,
  remindAfterDays: 5,
  closeAfterDays: 7,
  maxFollowUpRounds: 2,
  vmVcpus: 1,
  vmMemoryMiB: 2048,
  backupKeepDaily: 7,
  backupKeepWeekly: 4,
  backupHourUtc: 3,
});

/** 每个配置项对应的环境变量名。部署模板里的字段名必须与这里一致。 */
export const CONTROL_ENV: Readonly<Record<ControlKey, string>> = Object.freeze({
  pollIntervalSeconds: "GEEK_BOT_POLL_INTERVAL_SECONDS",
  quietWindowSeconds: "GEEK_BOT_QUIET_WINDOW_SECONDS",
  remindAfterDays: "GEEK_BOT_REMIND_AFTER_DAYS",
  closeAfterDays: "GEEK_BOT_CLOSE_AFTER_DAYS",
  maxFollowUpRounds: "GEEK_BOT_MAX_FOLLOWUP_ROUNDS",
  vmVcpus: "GEEK_BOT_VM_VCPUS",
  vmMemoryMiB: "GEEK_BOT_VM_MEMORY_MIB",
  backupKeepDaily: "GEEK_BOT_BACKUP_KEEP_DAILY",
  backupKeepWeekly: "GEEK_BOT_BACKUP_KEEP_WEEKLY",
  backupHourUtc: "GEEK_BOT_BACKUP_HOUR_UTC",
});

/**
 * 每个配置项允许的最小值。静默窗口、追问轮数、每周备份份数可以是 0（不等待、不追问、不留每周备份）。
 * VM 内存下限 512 MiB，用来拦下把 GiB 误写成 MiB 的情况。
 */
const MINIMUM: Readonly<Record<ControlKey, number>> = Object.freeze({
  pollIntervalSeconds: 1,
  quietWindowSeconds: 0,
  remindAfterDays: 1,
  closeAfterDays: 1,
  maxFollowUpRounds: 0,
  vmVcpus: 1,
  vmMemoryMiB: 512,
  backupKeepDaily: 1,
  backupKeepWeekly: 0,
  backupHourUtc: 0,
});

/** 有上限的配置项。 */
const MAXIMUM: Readonly<Partial<Record<ControlKey, number>>> = Object.freeze({ backupHourUtc: 23 });

/** 配置不合法时抛出；problems 逐条列出每个问题，message 是它们按行拼起来的结果。 */
export class ControlConfigError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`control 配置不合法：\n${problems.join("\n")}`);
    this.name = "ControlConfigError";
    this.problems = Object.freeze([...problems]);
  }
}

/** 读一个整数项：未设置或留空时用默认值；不合法时记下问题并返回 undefined。 */
function readInteger(env: Env, key: ControlKey, problems: string[]): number | undefined {
  const name = CONTROL_ENV[key];
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return CONTROL_DEFAULTS[key];
  const text = raw.trim();
  const minimum = MINIMUM[key];
  const maximum = MAXIMUM[key];
  const value = /^[0-9]+$/.test(text) ? Number(text) : Number.NaN;
  if (Number.isSafeInteger(value) && value >= minimum && (maximum === undefined || value <= maximum)) return value;
  const expected = maximum !== undefined ? ` ${minimum} 到 ${maximum} 之间的整数` : minimum === 0 ? "非负整数" : `不小于 ${minimum} 的整数`;
  problems.push(`${name} 必须是${expected}，当前值：${JSON.stringify(raw)}`);
  return undefined;
}

function collectControlConfig(env: Env, problems: string[]): ControlConfig {
  const values = {} as Record<ControlKey, number | undefined>;
  for (const key of Object.keys(CONTROL_ENV) as ControlKey[]) values[key] = readInteger(env, key, problems);

  const { remindAfterDays, closeAfterDays } = values;
  // 两项都合法时才比较先后，避免把单项错误再报成一条误导的比较错误。
  if (remindAfterDays !== undefined && closeAfterDays !== undefined && closeAfterDays <= remindAfterDays) {
    problems.push(
      `关闭天数必须大于提醒天数：${CONTROL_ENV.closeAfterDays}=${closeAfterDays}，${CONTROL_ENV.remindAfterDays}=${remindAfterDays}`,
    );
  }
  return Object.freeze(values as Record<ControlKey, number>);
}

/** 按默认值加环境变量覆盖生成 control 配置；任一项不合法时抛出 ControlConfigError，列出全部问题。 */
export function createControlConfig(env: Env = {}): ControlConfig {
  const problems: string[] = [];
  const config = collectControlConfig(env, problems);
  if (problems.length > 0) throw new ControlConfigError(problems);
  return config;
}

// ---------------------------------------------------------------------------
// 部署配置：由部署者按环境写进 env 文件（#7），不是产品行为默认值。
// ---------------------------------------------------------------------------

/** 实例角色（behavior B-64）：必须显式配置，没配就拒绝启动。 */
export const INSTANCE_ROLES = Object.freeze(["preview", "production"] as const);
export type InstanceRole = (typeof INSTANCE_ROLES)[number];

/** 日志级别，从低到高。 */
export const LOG_LEVELS = Object.freeze(["debug", "info", "warn", "error"] as const);
export type ConfigLogLevel = (typeof LOG_LEVELS)[number];

export interface DeploymentConfig {
  /** 实例角色：preview 或 production。 */
  readonly instanceRole: InstanceRole;
  /** 监听地址。默认只绑回环地址（SECURITY S-20）。 */
  readonly host: string;
  /** 监听端口：后台、节点 API 与健康检查共用。 */
  readonly port: number;
  /** 实例的 origin（例如 https://geek-bot.example.com）；没配时为 null。 */
  readonly publicOrigin: string | null;
  /** 显式开启的私网明文 HTTP 模式（S-20）。 */
  readonly allowPlaintextMesh: boolean;
  /** SQLite 库文件的绝对路径。 */
  readonly dbPath: string;
  /** 库文件所在目录；备份、本地通道都放在它下面。 */
  readonly dataDir: string;
  /** 加密备份所在目录：`<dataDir>/backups`。 */
  readonly backupDir: string;
  /** 运维本地通道（unix socket）所在目录：`<dataDir>/run`。 */
  readonly runDir: string;
  /** 令牌加密主密钥（master key）文件的绝对路径。 */
  readonly masterKeyFile: string;
  /** 备份加密密钥文件的绝对路径。 */
  readonly backupKeyFile: string;
  /** 最低输出的日志级别。 */
  readonly logLevel: ConfigLogLevel;
  /** 运行中的镜像版本，只作来源记录（写进 schema_migrations.app_version 与 backups.app_version）。 */
  readonly appVersion: string;
}

type DeploymentKey = "instanceRole" | "host" | "port" | "publicOrigin" | "allowPlaintextMesh" | "dbPath" | "masterKeyFile" | "backupKeyFile" | "logLevel" | "appVersion";

/** 部署配置的环境变量名。 */
export const DEPLOYMENT_ENV: Readonly<Record<DeploymentKey, string>> = Object.freeze({
  instanceRole: "GEEK_BOT_INSTANCE_ROLE",
  host: "GEEK_BOT_HOST",
  port: "GEEK_BOT_PORT",
  publicOrigin: "GEEK_BOT_PUBLIC_ORIGIN",
  allowPlaintextMesh: "GEEK_BOT_ALLOW_PLAINTEXT_MESH",
  dbPath: "GEEK_BOT_DB_PATH",
  masterKeyFile: "GEEK_BOT_MASTER_KEY_FILE",
  backupKeyFile: "GEEK_BOT_BACKUP_KEY_FILE",
  logLevel: "GEEK_BOT_LOG_LEVEL",
  appVersion: "GEEK_BOT_APP_VERSION",
});

/** 部署配置的默认值：容器内的库路径与 compose secrets 的挂载路径；实例角色没有默认值。 */
export const DEPLOYMENT_DEFAULTS: Readonly<{
  host: string;
  port: number;
  dbPath: string;
  masterKeyFile: string;
  backupKeyFile: string;
  logLevel: ConfigLogLevel;
  appVersion: string;
}> = Object.freeze({
  host: "127.0.0.1",
  port: 8080,
  dbPath: "/data/geek-bot.db",
  masterKeyFile: "/run/secrets/master_key",
  backupKeyFile: "/run/secrets/backup_key",
  logLevel: "info",
  appVersion: "local",
});

/**
 * 密钥只从 `*_FILE` 读：这些变量一旦有值就拒绝启动，报错里只写变量名，不回显值。
 * 以后新增的密钥（会话签名密钥、OAuth client secret、模型网关密钥）同样只接受 `*_FILE`。
 */
export const FORBIDDEN_SECRET_ENV = Object.freeze(["GEEK_BOT_MASTER_KEY", "GEEK_BOT_BACKUP_KEY"] as const);

const APP_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,63}$/;
const HOST_RE = /^(?:[A-Za-z0-9.-]{1,253}|[0-9A-Fa-f:.]{2,45}|\[[0-9A-Fa-f:.]{2,45}\])$/;

/** 回环地址：localhost、127.0.0.0/8、::1。 */
export function isLoopbackHost(host: string): boolean {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return bare === "localhost" || bare === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

function text(env: Env, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** 解析实例的 origin：只接受 http(s)://主机[:端口]，不许带路径、查询串、片段和用户信息。 */
function parseOrigin(raw: string, problems: string[]): string | null {
  const name = DEPLOYMENT_ENV.publicOrigin;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    problems.push(`${name} 不是合法的地址，要写成 https://geek-bot.example.com 这样的 origin，当前值：${JSON.stringify(raw)}`);
    return null;
  }
  const bare = (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
  // 主机部分之后只允许一个结尾的 /；空的 ? 与 # 在 URL 对象里看不出来，按原文查。
  const rest = raw.slice(raw.indexOf("//") + 2).replace(/\/$/, "");
  if (!bare || /[/?#@]/.test(rest)) {
    problems.push(`${name} 只能是 http(s)://主机[:端口]，不带路径、查询串和用户信息，当前值：${JSON.stringify(raw)}`);
    return null;
  }
  return url.origin;
}

function readBoolean(env: Env, name: string, problems: string[]): boolean {
  const value = text(env, name);
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  problems.push(`${name} 只能是 true 或 false，当前值：${JSON.stringify(env[name])}`);
  return false;
}

function readPath(env: Env, name: string, fallback: string, cwd: string, problems: string[]): string {
  const value = text(env, name) ?? fallback;
  if (/[\0\n\r]/.test(value)) {
    problems.push(`${name} 不是合法的路径`);
    return fallback;
  }
  return isAbsolute(value) ? value : resolve(cwd, value);
}

/** 密钥文件路径的写法：绝对路径，或以 ./、../ 开头的相对路径（与 scripts/check-secrets.mjs 的 FILE_REFERENCE_RE 同一口径）。 */
const KEY_FILE_PATH_RE = /^(?:\/|\.{1,2}\/)[^\s\0]*$/;
/** 以 / 开头的标准 base64 密钥（openssl rand -base64 32 的输出）也满足上面的写法，按 32 字节密钥的样子单独拦下。 */
const KEY_TEXT_RE = /^[A-Za-z0-9+/]{43}=$/;

/**
 * 读 `*_KEY_FILE`：只接受路径的写法。运维把密钥原文误填进这个变量时，值会被当成相对路径拼进报错与日志，
 * 所以不合规时报错只写变量名，不回显值。返回 null 表示没通过（问题已记下）。
 */
function readKeyFilePath(env: Env, name: string, fallback: string, cwd: string, problems: string[]): string | null {
  const value = text(env, name);
  if (value === undefined) return fallback;
  if (!KEY_FILE_PATH_RE.test(value) || KEY_TEXT_RE.test(value)) {
    problems.push(`${name} 只接受密钥文件的路径（绝对路径，或以 ./、../ 开头）：当前值不是这样的路径，报错里不回显它；如果误填的是密钥原文，这把密钥要换掉`);
    return null;
  }
  return isAbsolute(value) ? value : resolve(cwd, value);
}

function collectDeploymentConfig(env: Env, cwd: string, problems: string[]): DeploymentConfig {
  for (const name of FORBIDDEN_SECRET_ENV) {
    if (text(env, name) !== undefined) problems.push(`${name} 不接受直接写值：密钥只能以文件提供，改用 ${name}_FILE 指向密钥文件`);
  }

  const roleName = DEPLOYMENT_ENV.instanceRole;
  const roleText = text(env, roleName);
  let instanceRole: InstanceRole = "preview";
  if (roleText === undefined) problems.push(`${roleName} 必须显式配置为 preview 或 production，没有默认值`);
  else if ((INSTANCE_ROLES as readonly string[]).includes(roleText)) instanceRole = roleText as InstanceRole;
  else problems.push(`${roleName} 只能是 preview 或 production，当前值：${JSON.stringify(env[roleName])}`);

  const host = text(env, DEPLOYMENT_ENV.host) ?? DEPLOYMENT_DEFAULTS.host;
  if (!HOST_RE.test(host)) problems.push(`${DEPLOYMENT_ENV.host} 不是合法的监听地址，当前值：${JSON.stringify(env[DEPLOYMENT_ENV.host])}`);

  const portText = text(env, DEPLOYMENT_ENV.port);
  let port = DEPLOYMENT_DEFAULTS.port;
  if (portText !== undefined) {
    const value = /^[0-9]+$/.test(portText) ? Number(portText) : Number.NaN;
    if (Number.isInteger(value) && value >= 1 && value <= 65535) port = value;
    else problems.push(`${DEPLOYMENT_ENV.port} 必须是 1 到 65535 之间的整数，当前值：${JSON.stringify(env[DEPLOYMENT_ENV.port])}`);
  }

  const originText = text(env, DEPLOYMENT_ENV.publicOrigin);
  const publicOrigin = originText === undefined ? null : parseOrigin(originText, problems);
  const allowPlaintextMesh = readBoolean(env, DEPLOYMENT_ENV.allowPlaintextMesh, problems);

  // S-20：绑定非回环地址时必须配置 origin；origin 不是 https 时还要显式开启私网明文模式。
  if (HOST_RE.test(host) && !isLoopbackHost(host)) {
    if (originText === undefined) {
      problems.push(`${DEPLOYMENT_ENV.host}=${host} 不是回环地址：绑定非回环地址时必须配置 ${DEPLOYMENT_ENV.publicOrigin}`);
    } else if (publicOrigin !== null && publicOrigin.startsWith("http:") && !allowPlaintextMesh) {
      problems.push(
        `${DEPLOYMENT_ENV.host}=${host} 不是回环地址，而 ${DEPLOYMENT_ENV.publicOrigin} 不是 https：前面加 TLS 反代并改成 https，或者显式设置 ${DEPLOYMENT_ENV.allowPlaintextMesh}=true`,
      );
    }
  }

  const dbPath = readPath(env, DEPLOYMENT_ENV.dbPath, DEPLOYMENT_DEFAULTS.dbPath, cwd, problems);
  const masterKeyFile = readKeyFilePath(env, DEPLOYMENT_ENV.masterKeyFile, DEPLOYMENT_DEFAULTS.masterKeyFile, cwd, problems);
  const backupKeyFile = readKeyFilePath(env, DEPLOYMENT_ENV.backupKeyFile, DEPLOYMENT_DEFAULTS.backupKeyFile, cwd, problems);
  if (masterKeyFile !== null && masterKeyFile === backupKeyFile) {
    problems.push(`${DEPLOYMENT_ENV.masterKeyFile} 与 ${DEPLOYMENT_ENV.backupKeyFile} 指向同一个文件：master key 和备份加密密钥必须是两把不同的密钥`);
  }

  const levelText = text(env, DEPLOYMENT_ENV.logLevel);
  let logLevel = DEPLOYMENT_DEFAULTS.logLevel;
  if (levelText !== undefined) {
    if ((LOG_LEVELS as readonly string[]).includes(levelText)) logLevel = levelText as ConfigLogLevel;
    else problems.push(`${DEPLOYMENT_ENV.logLevel} 只能是 ${LOG_LEVELS.join("、")}，当前值：${JSON.stringify(env[DEPLOYMENT_ENV.logLevel])}`);
  }

  const appVersion = text(env, DEPLOYMENT_ENV.appVersion) ?? DEPLOYMENT_DEFAULTS.appVersion;
  if (!APP_VERSION_RE.test(appVersion)) {
    problems.push(`${DEPLOYMENT_ENV.appVersion} 只能由字母、数字和 . _ @ + - 组成，最长 64 个字符`);
  }

  const dataDir = dirname(dbPath);
  return Object.freeze({
    instanceRole,
    host,
    port,
    publicOrigin,
    allowPlaintextMesh,
    dbPath,
    dataDir,
    backupDir: join(dataDir, "backups"),
    runDir: join(dataDir, "run"),
    masterKeyFile: masterKeyFile ?? DEPLOYMENT_DEFAULTS.masterKeyFile,
    backupKeyFile: backupKeyFile ?? DEPLOYMENT_DEFAULTS.backupKeyFile,
    logLevel,
    appVersion,
  });
}

/**
 * 按环境变量生成部署配置；任一项不合法时抛出 ControlConfigError，列出全部问题。
 * 相对路径按 cwd 解析（默认是当前工作目录）。
 */
export function createDeploymentConfig(env: Env = {}, cwd: string = process.cwd()): DeploymentConfig {
  const problems: string[] = [];
  const config = collectDeploymentConfig(env, cwd, problems);
  if (problems.length > 0) throw new ControlConfigError(problems);
  return config;
}

export interface LoadedConfig {
  readonly behavior: ControlConfig;
  readonly deployment: DeploymentConfig;
}

/** 一次读出产品默认值与部署配置；两部分的问题合在一个 ControlConfigError 里一起报。 */
export function loadControlConfig(env: Env, cwd: string = process.cwd()): LoadedConfig {
  const problems: string[] = [];
  const behavior = collectControlConfig(env, problems);
  const deployment = collectDeploymentConfig(env, cwd, problems);
  if (problems.length > 0) throw new ControlConfigError(problems);
  return Object.freeze({ behavior, deployment });
}

/** 健康检查进程要连的地址：通配地址换成对应的回环地址。只读监听地址与端口，不校验其它配置。 */
export function probeAddress(env: Env): { host: string; port: number } {
  const host = text(env, DEPLOYMENT_ENV.host) ?? DEPLOYMENT_DEFAULTS.host;
  const portText = text(env, DEPLOYMENT_ENV.port);
  const port = portText !== undefined && /^[0-9]+$/.test(portText) ? Number(portText) : DEPLOYMENT_DEFAULTS.port;
  if (host === "0.0.0.0") return { host: "127.0.0.1", port };
  if (host === "::" || host === "[::]") return { host: "::1", port };
  return { host: host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host, port };
}
