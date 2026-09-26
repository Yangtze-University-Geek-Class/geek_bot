/**
 * 加密备份文件的格式（data-model「备份与每日恢复校验」，SECURITY S-17）。
 *
 *   0..7      魔数 "GBBK0001"（格式版本 1）
 *   8..11     头部长度 N（uint32，大端）
 *   12..12+N  头部 JSON（UTF-8）：加密参数、备份种类、时间、库版本、兼容版本、镜像版本、备份密钥指纹、各表行数
 *   之后      AES-256-GCM 密文（明文是 SQLite 库文件）
 *   最后 16   GCM 认证标签
 *
 * 前 12+N 字节整体作为附加认证数据（AAD）：头部被改动同样解不开。每个文件用独立的 12 字节随机 IV。
 * 加密、解密都按流处理，不把整个库读进内存；解密失败时删掉写了一半的明文。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, rm } from "node:fs/promises";

export const BACKUP_MAGIC = Buffer.from("GBBK0001", "ascii");
export const BACKUP_EXTENSION = ".gbbk";
const PREFIX_BYTES = BACKUP_MAGIC.length + 4;
const TAG_BYTES = 16;
const IV_BYTES = 12;
const MAX_HEADER_BYTES = 1024 * 1024;

export const BACKUP_KINDS = Object.freeze(["daily", "weekly", "pre_deploy", "pre_migration", "manual"] as const);
export type BackupKind = (typeof BACKUP_KINDS)[number];

export interface BackupHeader {
  readonly format: 1;
  readonly cipher: "aes-256-gcm";
  /** IV 的 base64。 */
  readonly iv: string;
  readonly kind: BackupKind;
  /** 备份时间（UTC 毫秒）。 */
  readonly created_at: number;
  /** 备份时库的 user_version（D）。 */
  readonly schema_version: number;
  /** 备份时库的兼容版本（K）。 */
  readonly compat_version: number;
  readonly app_version: string;
  /** 加密用的备份密钥的指纹（不是密钥本身）。 */
  readonly backup_key_id: string;
  /** 备份时各表的行数，恢复校验时核对。 */
  readonly row_counts: Readonly<Record<string, number>>;
}

/** 备份文件损坏、被改动，或者不是用这把备份密钥加密的。 */
export class BackupFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupFileError";
  }
}

export type BackupHeaderInput = Omit<BackupHeader, "format" | "cipher" | "iv">;

/** 加密一个明文库文件，写到 outPath（不能已存在，权限 0600）；返回加密后文件的 sha256 与字节数。 */
export async function encryptBackup(plainPath: string, outPath: string, key: Buffer, input: BackupHeaderInput): Promise<{ sha256: string; bytes: number; header: BackupHeader }> {
  const iv = randomBytes(IV_BYTES);
  const header: BackupHeader = { format: 1, cipher: "aes-256-gcm", iv: iv.toString("base64"), ...input };
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(headerBytes.length);
  const prefix = Buffer.concat([BACKUP_MAGIC, length, headerBytes]);

  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(prefix);
  const hash = createHash("sha256");
  const out = await open(outPath, "wx", 0o600);
  let bytes = 0;
  const write = async (chunk: Buffer) => {
    if (chunk.length === 0) return;
    hash.update(chunk);
    bytes += chunk.length;
    await out.write(chunk);
  };
  try {
    await write(prefix);
    for await (const chunk of createReadStream(plainPath)) await write(cipher.update(chunk as Buffer));
    await write(cipher.final());
    await write(cipher.getAuthTag());
    await out.sync();
  } catch (error) {
    await out.close();
    await rm(outPath, { force: true });
    throw error;
  }
  await out.close();
  return { sha256: hash.digest("hex"), bytes, header };
}

function parseHeader(json: string): BackupHeader {
  let header: unknown;
  try {
    header = JSON.parse(json);
  } catch {
    throw new BackupFileError("备份文件的头部不是合法的 JSON");
  }
  const h = header as Partial<BackupHeader>;
  const counts = h.row_counts;
  const valid =
    h &&
    typeof h === "object" &&
    h.format === 1 &&
    h.cipher === "aes-256-gcm" &&
    typeof h.iv === "string" &&
    Buffer.from(h.iv, "base64").length === IV_BYTES &&
    typeof h.kind === "string" &&
    (BACKUP_KINDS as readonly string[]).includes(h.kind) &&
    Number.isSafeInteger(h.created_at) &&
    Number.isSafeInteger(h.schema_version) &&
    Number.isSafeInteger(h.compat_version) &&
    typeof h.app_version === "string" &&
    typeof h.backup_key_id === "string" &&
    counts !== null &&
    typeof counts === "object" &&
    Object.values(counts).every(value => Number.isSafeInteger(value) && value >= 0);
  if (!valid) throw new BackupFileError("备份文件的头部缺字段或字段不合法");
  return Object.freeze(h as BackupHeader);
}

export interface BackupFileInfo {
  readonly header: BackupHeader;
  /** 魔数、长度与头部（也就是 AAD）。 */
  readonly prefix: Buffer;
  readonly size: number;
}

/** 读备份文件的头部（没有解密，头部是否被改动要等解密时由认证标签判定）。 */
export async function readBackupHeader(path: string): Promise<BackupFileInfo> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    if (size < PREFIX_BYTES + TAG_BYTES) throw new BackupFileError("备份文件太短，不是 geek_bot 的加密备份");
    const start = Buffer.alloc(PREFIX_BYTES);
    await handle.read(start, 0, PREFIX_BYTES, 0);
    if (!start.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) throw new BackupFileError("不是 geek_bot 的加密备份（魔数不对）");
    const headerLength = start.readUInt32BE(BACKUP_MAGIC.length);
    if (headerLength > MAX_HEADER_BYTES || PREFIX_BYTES + headerLength + TAG_BYTES > size) throw new BackupFileError("备份文件的头部长度不合法");
    const headerBytes = Buffer.alloc(headerLength);
    await handle.read(headerBytes, 0, headerLength, PREFIX_BYTES);
    const header = parseHeader(headerBytes.toString("utf8"));
    return { header, prefix: Buffer.concat([start, headerBytes]), size };
  } finally {
    await handle.close();
  }
}

/**
 * 解密到 outPath（不能已存在，权限 0600）。认证不通过（内容或头部被改、密钥不对）时删掉 outPath 并抛 BackupFileError。
 */
export async function decryptBackup(path: string, key: Buffer, outPath: string): Promise<BackupHeader> {
  const { header, prefix, size } = await readBackupHeader(path);
  const tag = Buffer.alloc(TAG_BYTES);
  const handle = await open(path, "r");
  try {
    await handle.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
  } finally {
    await handle.close();
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(header.iv, "base64"));
  decipher.setAAD(prefix);
  decipher.setAuthTag(tag);
  const out = await open(outPath, "wx", 0o600);
  try {
    const end = size - TAG_BYTES - 1;
    if (end >= prefix.length) {
      for await (const chunk of createReadStream(path, { start: prefix.length, end })) await out.write(decipher.update(chunk as Buffer));
    }
    try {
      await out.write(decipher.final());
    } catch {
      throw new BackupFileError("备份文件解密校验失败：内容或头部被改动过，或者不是用这把备份密钥加密的");
    }
    await out.sync();
  } catch (error) {
    await out.close();
    await rm(outPath, { force: true });
    throw error;
  }
  await out.close();
  return header;
}

/** 文件的 sha256（十六进制）。 */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
