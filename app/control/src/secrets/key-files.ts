/**
 * 读取以 `*_FILE` 挂载的 32 字节密钥（master key、备份加密密钥）。
 *
 * 文件内容是 32 个随机字节的 base64（例如 `openssl rand -base64 32` 的输出）或 64 位十六进制，首尾空白忽略。
 * 任何报错都只写变量名和路径，不回显文件内容；读到的原文登记进打码器，之后出现在日志里也会被替换。
 */
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Redactor } from "../log/redact.js";

export const KEY_BYTES = 32;

export interface KeyFileSpec {
  /** 环境变量名，例如 GEEK_BOT_MASTER_KEY_FILE。 */
  readonly envName: string;
  /** 已解析的绝对路径。 */
  readonly path: string;
}

export interface LoadedKey {
  readonly envName: string;
  readonly path: string;
  readonly key: Buffer;
  /** 文件权限对组或其他用户可读时的提醒（不阻止启动；部署脚本按 0600 核对，#7）。 */
  readonly warning: string | null;
}

/** 读密钥文件失败；problem 只含变量名、路径和原因。 */
export class KeyFileError extends Error {
  constructor(readonly problem: string) {
    super(problem);
    this.name = "KeyFileError";
  }
}

function decodeKey(text: string): Buffer | null {
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, "hex");
  if (/^[A-Za-z0-9+/]{43}=$/.test(text) || /^[A-Za-z0-9_-]{43}=?$/.test(text)) {
    const decoded = Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    return decoded.length === KEY_BYTES ? decoded : null;
  }
  return null;
}

/** 读一把 32 字节密钥；失败抛 KeyFileError（不含文件内容）。 */
export function loadKeyFile(spec: KeyFileSpec, redactor: Redactor): LoadedKey {
  const { envName, path } = spec;
  let stat;
  try {
    stat = statSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new KeyFileError(`${envName} 指向的密钥文件不存在：${path}`);
    throw new KeyFileError(`${envName} 指向的密钥文件读不了（${code ?? "未知原因"}）：${path}`);
  }
  if (!stat.isFile()) throw new KeyFileError(`${envName} 指向的不是普通文件：${path}`);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new KeyFileError(`${envName} 指向的密钥文件读不了（${(error as NodeJS.ErrnoException).code ?? "未知原因"}）：${path}`);
  }
  // 先登记原文再校验，校验失败的内容同样不能出现在日志里。
  redactor.addKnownSecret(raw);
  const key = decodeKey(raw.trim());
  if (!key) {
    throw new KeyFileError(`${envName} 指向的文件不是 32 字节密钥（要求 base64 或 64 位十六进制，例如 openssl rand -base64 32 的输出）：${path}`);
  }
  redactor.addKnownSecret(key.toString("base64"));
  redactor.addKnownSecret(key.toString("hex"));
  const warning = (stat.mode & 0o077) !== 0 ? `${envName} 指向的密钥文件对组或其他用户可读（权限 ${(stat.mode & 0o777).toString(8)}），建议改成 0600 或 0400：${path}` : null;
  return Object.freeze({ envName, path, key, warning });
}

/** 就绪检查用：密钥文件此刻仍然存在并且可读（不读内容）。 */
export function keyFileReadable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** 备份密钥的指纹（不是密钥本身）：换钥后据此找对应的离线密钥。 */
export function keyFingerprint(key: Buffer, purpose: string): string {
  return createHash("sha256").update(`geek-bot/${purpose}/v1\0`).update(key).digest("hex").slice(0, 16);
}
