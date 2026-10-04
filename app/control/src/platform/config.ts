/**
 * 共享平台的部署配置（#34）：loadPlatformConfig 是纯计算，调用方传入环境变量表；loadPlatformSecrets 读密钥文件。
 *
 * 密钥只从 `*_FILE` 读（S-01、S-02、SECURITY 密钥表）：会话签名密钥、OAuth client secret、模型网关密钥。
 * 直接写值的同名变量一律拒绝启动，报错只写变量名，不回显值。
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WriteMode } from "@geek-bot/protocol";
import type { Env } from "../config.js";
import type { Redactor } from "../log/redact.js";
import { KeyFileError, loadKeyFile } from "../secrets/key-files.js";

export interface PlatformConfig {
  /** 实例 origin；null 表示只绑回环地址，按请求的 Host 推出回环 origin。 */
  readonly publicOrigin: string | null;
  readonly secureCookies: boolean;
  readonly insecureContext: boolean;
  readonly instanceRole: "preview" | "production";
  /** 会话签名密钥文件（必需）；默认 compose secrets 的挂载路径。 */
  readonly sessionSecretFile: string;
  readonly github: {
    readonly webUrl: string;
    readonly apiUrl: string;
    readonly clientId: string | null;
    readonly clientSecretFile: string | null;
  };
  readonly model: {
    readonly gatewayUrl: string | null;
    readonly gatewayKeyFile: string | null;
    readonly catalogFile: string | null;
  };
  readonly writeModeCeiling: WriteMode;
  readonly leaseLostAfterS: number;
  readonly ackDeadlineS: number;
  readonly infraRetryMax: number;
  readonly taskTokenBudget: number;
  readonly taskRequestBudget: number;
  readonly taskTimeoutS: number;
  readonly syncIntervalS: number;
  readonly consoleDist: string;
  readonly release: { readonly display: string; readonly version: string; readonly commit: string };
}

export const PLATFORM_ENV = Object.freeze({
  sessionSecretFile: "GEEK_BOT_SESSION_SECRET_FILE",
  githubWebUrl: "GEEK_BOT_GITHUB_WEB_URL",
  githubApiUrl: "GEEK_BOT_GITHUB_API_URL",
  githubClientId: "GEEK_BOT_GITHUB_CLIENT_ID",
  githubClientSecretFile: "GEEK_BOT_OAUTH_CLIENT_SECRET_FILE",
  modelGatewayUrl: "GEEK_BOT_MODEL_GATEWAY_URL",
  modelGatewayKeyFile: "GEEK_BOT_MODEL_GATEWAY_KEY_FILE",
  modelCatalogFile: "GEEK_BOT_MODEL_CATALOG_FILE",
  writeMode: "GEEK_BOT_WRITE_MODE",
  leaseLostAfter: "GEEK_BOT_LEASE_LOST_AFTER_SECONDS",
  infraRetryMax: "GEEK_BOT_INFRA_RETRY_MAX",
  taskTokenBudget: "GEEK_BOT_TASK_TOKEN_BUDGET",
  taskRequestBudget: "GEEK_BOT_TASK_REQUEST_BUDGET",
  taskTimeout: "GEEK_BOT_TASK_TIMEOUT_SECONDS",
  pollInterval: "GEEK_BOT_POLL_INTERVAL_SECONDS",
  consoleDist: "GEEK_BOT_CONSOLE_DIST",
  releaseDisplay: "GEEK_BOT_RELEASE_DISPLAY",
  releaseVersion: "GEEK_BOT_RELEASE_VERSION",
  releaseCommit: "GEEK_BOT_RELEASE_COMMIT",
});

/** 直接写值即拒绝启动的密钥变量（与 config.ts 的 FORBIDDEN_SECRET_ENV 同一口径）。 */
export const PLATFORM_FORBIDDEN_SECRET_ENV = Object.freeze(["GEEK_BOT_SESSION_SECRET", "GEEK_BOT_OAUTH_CLIENT_SECRET", "GEEK_BOT_MODEL_GATEWAY_KEY"] as const);
/** 会话签名密钥文件的默认挂载路径（与 master_key、backup_key 同在 compose secrets 下）。 */
export const SESSION_SECRET_DEFAULT = "/run/secrets/session_secret";

export class PlatformConfigError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`共享平台配置不合法：${problems.join("；")}`);
    this.name = "PlatformConfigError";
    this.problems = Object.freeze([...problems]);
  }
}

const KEY_FILE_PATH_RE = /^(?:\/|\.{1,2}\/)[^\s\0]*$/;
const KEY_TEXT_RE = /^[A-Za-z0-9+/]{43}=$/;
const CLIENT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const RELEASE_TEXT_RE = /^[^\0\n\r]{1,80}$/;
const WRITE_MODES: readonly WriteMode[] = ["off", "dry_run", "on"];

function text(env: Env, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function readInt(env: Env, name: string, fallback: number, min: number, max: number, problems: string[]): number {
  const raw = text(env, name);
  if (raw === undefined) return fallback;
  const value = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
  if (Number.isSafeInteger(value) && value >= min && value <= max) return value;
  problems.push(`${name} 必须是 ${min} 到 ${max} 之间的整数`);
  return fallback;
}

function readFilePath(env: Env, name: string, cwd: string, problems: string[]): string | null {
  const value = text(env, name);
  if (value === undefined) return null;
  if (!KEY_FILE_PATH_RE.test(value) || KEY_TEXT_RE.test(value)) {
    problems.push(`${name} 只接受密钥文件的路径（绝对路径，或以 ./、../ 开头）：当前值不是这样的路径，报错里不回显它`);
    return null;
  }
  return isAbsolute(value) ? value : resolve(cwd, value);
}

function readBaseUrl(env: Env, name: string, fallback: string | null, problems: string[]): string | null {
  const raw = text(env, name);
  if (raw === undefined) return fallback;
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.search || url.hash || !(url.protocol === "https:" || url.protocol === "http:")) throw new Error("bad");
    return url.href.replace(/\/+$/, "");
  } catch {
    problems.push(`${name} 必须是 http(s) 地址，不带用户信息、查询串和片段`);
    return fallback;
  }
}

export interface DeploymentView {
  readonly instanceRole: "preview" | "production";
  readonly publicOrigin: string | null;
  readonly appVersion: string;
}

export function loadPlatformConfig(env: Env, deployment: DeploymentView, cwd: string = process.cwd()): PlatformConfig {
  const problems: string[] = [];
  for (const name of PLATFORM_FORBIDDEN_SECRET_ENV) {
    if (text(env, name) !== undefined) problems.push(`${name} 不接受直接写值：密钥只能以文件提供，改用 ${name}_FILE 指向密钥文件`);
  }
  const clientId = text(env, PLATFORM_ENV.githubClientId) ?? null;
  if (clientId !== null && !CLIENT_ID_RE.test(clientId)) problems.push(`${PLATFORM_ENV.githubClientId} 只能由字母、数字和 . _ - 组成`);
  const writeModeText = text(env, PLATFORM_ENV.writeMode) ?? "dry_run";
  if (!(WRITE_MODES as readonly string[]).includes(writeModeText)) problems.push(`${PLATFORM_ENV.writeMode} 只能是 off、dry_run 或 on`);
  const consoleDistText = text(env, PLATFORM_ENV.consoleDist);
  const catalogText = text(env, PLATFORM_ENV.modelCatalogFile);
  const releaseDisplay = text(env, PLATFORM_ENV.releaseDisplay);
  const releaseVersion = text(env, PLATFORM_ENV.releaseVersion);
  const releaseCommit = text(env, PLATFORM_ENV.releaseCommit);
  for (const [name, value] of [[PLATFORM_ENV.releaseDisplay, releaseDisplay], [PLATFORM_ENV.releaseVersion, releaseVersion]] as const) {
    if (value !== undefined && !RELEASE_TEXT_RE.test(value)) problems.push(`${name} 不是合法的展示值`);
  }
  if (releaseCommit !== undefined && !/^[0-9a-f]{40}$/.test(releaseCommit)) problems.push(`${PLATFORM_ENV.releaseCommit} 必须是 40 位小写十六进制提交 SHA`);
  const releaseConfigured = releaseDisplay !== undefined && releaseVersion !== undefined && releaseCommit !== undefined;
  const gatewayUrl = readBaseUrl(env, PLATFORM_ENV.modelGatewayUrl, null, problems);

  const config: PlatformConfig = Object.freeze({
    publicOrigin: deployment.publicOrigin,
    secureCookies: deployment.publicOrigin?.startsWith("https:") ?? false,
    insecureContext: deployment.publicOrigin !== null && deployment.publicOrigin.startsWith("http:"),
    instanceRole: deployment.instanceRole,
    sessionSecretFile: readFilePath(env, PLATFORM_ENV.sessionSecretFile, cwd, problems) ?? SESSION_SECRET_DEFAULT,
    github: Object.freeze({
      webUrl: readBaseUrl(env, PLATFORM_ENV.githubWebUrl, "https://github.com", problems) ?? "https://github.com",
      apiUrl: readBaseUrl(env, PLATFORM_ENV.githubApiUrl, "https://api.github.com", problems) ?? "https://api.github.com",
      clientId,
      clientSecretFile: readFilePath(env, PLATFORM_ENV.githubClientSecretFile, cwd, problems),
    }),
    model: Object.freeze({
      gatewayUrl,
      gatewayKeyFile: readFilePath(env, PLATFORM_ENV.modelGatewayKeyFile, cwd, problems),
      catalogFile: catalogText === undefined ? null : isAbsolute(catalogText) ? catalogText : resolve(cwd, catalogText),
    }),
    writeModeCeiling: ((WRITE_MODES as readonly string[]).includes(writeModeText) ? writeModeText : "dry_run") as WriteMode,
    leaseLostAfterS: readInt(env, PLATFORM_ENV.leaseLostAfter, 600, 60, 86_400, problems),
    ackDeadlineS: 60,
    infraRetryMax: readInt(env, PLATFORM_ENV.infraRetryMax, 2, 0, 10, problems),
    taskTokenBudget: readInt(env, PLATFORM_ENV.taskTokenBudget, 400_000, 1_000, 100_000_000, problems),
    taskRequestBudget: readInt(env, PLATFORM_ENV.taskRequestBudget, 300, 1, 100_000, problems),
    taskTimeoutS: readInt(env, PLATFORM_ENV.taskTimeout, 3600, 60, 86_400, problems),
    syncIntervalS: readInt(env, PLATFORM_ENV.pollInterval, 60, 1, 86_400, problems),
    // 默认位置：本文件在 app/control/{src,dist}/platform 下，console 产物在 app/console/dist。
    consoleDist:
      consoleDistText === undefined
        ? resolve(dirname(fileURLToPath(import.meta.url)), "../../../console/dist")
        : isAbsolute(consoleDistText) ? consoleDistText : resolve(cwd, consoleDistText),
    release: Object.freeze(
      releaseConfigured
        ? { display: releaseDisplay, version: releaseVersion, commit: releaseCommit }
        : { display: "本地开发 · 未发布", version: deployment.appVersion, commit: "" },
    ),
  });
  if (problems.length > 0) throw new PlatformConfigError(problems);
  return config;
}

export interface PlatformSecrets {
  /** 会话、认领、登录流程 cookie 的 HMAC 密钥（独立的会话签名密钥文件，SECURITY 密钥表）。 */
  readonly sessionKey: Buffer;
  readonly githubClientSecret: string | null;
  readonly modelGatewayKey: string | null;
}

/** 读普通文本密钥文件（OAuth client secret、网关密钥）：原文登记进打码器，报错不回显路径与内容。 */
function readTextSecret(envName: string, path: string, redactor: Redactor, problems: string[]): string | null {
  let raw: string;
  try {
    if (!statSync(path).isFile()) throw new Error("not a file");
    raw = readFileSync(path, "utf8");
  } catch {
    problems.push(`${envName} 指向的密钥文件读不了：核对挂载、属主和权限（报错里不回显路径）`);
    return null;
  }
  redactor.addKnownSecret(raw);
  const value = raw.trim();
  if (value.length < 8 || value.length > 4096 || /\s/.test(value)) {
    problems.push(`${envName} 指向的文件内容不是合法的密钥（8 到 4096 个非空白字符）`);
    return null;
  }
  return value;
}

/** 读平台密钥文件；任一失败抛 PlatformConfigError（只含变量名）。 */
export function loadPlatformSecrets(config: PlatformConfig, masterKey: Buffer, backupKey: Buffer, redactor: Redactor): PlatformSecrets {
  const problems: string[] = [];
  let sessionKey: Buffer | null = null;
  // 会话签名密钥必须是独立文件、独立轮换；读不到就拒绝启动，不从别的密钥派生。
  try {
    sessionKey = loadKeyFile({ envName: PLATFORM_ENV.sessionSecretFile, path: config.sessionSecretFile }, redactor).key;
    if (sessionKey.equals(masterKey) || sessionKey.equals(backupKey)) problems.push(`${PLATFORM_ENV.sessionSecretFile} 与 master key 或备份加密密钥是同一把密钥：必须各自独立生成`);
  } catch (error) {
    if (error instanceof KeyFileError) problems.push(error.problem);
    else throw error;
  }
  const githubClientSecret = config.github.clientSecretFile === null ? null : readTextSecret(PLATFORM_ENV.githubClientSecretFile, config.github.clientSecretFile, redactor, problems);
  const modelGatewayKey = config.model.gatewayKeyFile === null ? null : readTextSecret(PLATFORM_ENV.modelGatewayKeyFile, config.model.gatewayKeyFile, redactor, problems);
  if (problems.length > 0 || sessionKey === null) throw new PlatformConfigError(problems);
  return Object.freeze({ sessionKey, githubClientSecret, modelGatewayKey });
}
