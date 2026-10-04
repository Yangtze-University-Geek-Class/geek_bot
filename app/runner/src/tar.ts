/**
 * VM 的输入盘与输出盘是原始块设备上的 ustar 归档。这里只实现本程序需要的最小子集：
 * 只写普通文件；读取时只认普通文件，其它类型（目录、链接、设备）一律跳过，从不按归档里的路径写盘。
 * 读取按块顺序进行（块设备的 fstat 大小为 0，不能整盘读入内存），遇到全零块即停止。
 */
import { closeSync, fsyncSync, openSync, readSync, writeSync } from "node:fs";

const BLOCK = 512;

export interface TarEntry {
  readonly name: string;
  readonly data: Buffer;
}

export interface TarReadLimits {
  /** 最多读取的普通文件数。 */
  readonly maxEntries: number;
  /** 单个文件的字节上限。 */
  readonly maxFileBytes: number;
  /** 全部文件的字节上限。 */
  readonly maxTotalBytes: number;
}

export class TarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TarError";
  }
}

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, "0");
  if (text.length > length - 1) throw new TarError(`数值超出 tar 字段长度：${value}`);
  header.write(`${text}\0`, offset, length, "ascii");
}

function readOctal(header: Buffer, offset: number, length: number): number {
  const text = header.subarray(offset, offset + length).toString("ascii").replace(/\0.*$/s, "").trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new TarError("tar 头里的数值字段不是八进制");
  return Number.parseInt(text, 8);
}

function checksum(header: Buffer): number {
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) sum += index >= 148 && index < 156 ? 32 : header[index];
  return sum;
}

/** 名字只能是不带目录穿越的相对路径，最长 100 字节（本程序只用短名字）。 */
function assertEntryName(name: string): void {
  if (name === "" || Buffer.byteLength(name) > 100) throw new TarError(`tar 文件名长度不合法：${JSON.stringify(name)}`);
  if (name.startsWith("/") || name.includes("\0") || name.split("/").some(part => part === ".." || part === "." || part === "")) {
    throw new TarError(`tar 文件名不合法：${JSON.stringify(name)}`);
  }
}

/** 把普通文件打成 ustar 归档（结尾带两个全零块）。 */
export function writeTar(entries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    assertEntryName(entry.name);
    const header = Buffer.alloc(BLOCK);
    header.write(entry.name, 0, 100, "utf8");
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, entry.data.length);
    writeOctal(header, 136, 12, 0);
    header.write("0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    writeOctal(header, 148, 8, checksum(header));
    parts.push(header, entry.data);
    const pad = (BLOCK - (entry.data.length % BLOCK)) % BLOCK;
    if (pad > 0) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

function readExact(fd: number, length: number, position: number): Buffer {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const read = readSync(fd, buffer, done, length - done, position + done);
    if (read === 0) throw new TarError("tar 归档在文件中途结束");
    done += read;
  }
  return buffer;
}

/** 从文件或块设备读取 ustar 归档里的普通文件。 */
export function readTarFile(path: string, limits: TarReadLimits): Map<string, Buffer> {
  const fd = openSync(path, "r");
  try {
    const files = new Map<string, Buffer>();
    let position = 0;
    let total = 0;
    for (;;) {
      const header = readExact(fd, BLOCK, position);
      position += BLOCK;
      if (header.every(byte => byte === 0)) return files;
      if (readOctal(header, 148, 8) !== checksum(header)) throw new TarError("tar 头校验和不符");
      const size = readOctal(header, 124, 12);
      const type = String.fromCharCode(header[156] || 48);
      const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "");
      const base = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
      const name = (prefix ? `${prefix}/${base}` : base).replace(/^\.\//, "");
      const padded = Math.ceil(size / BLOCK) * BLOCK;
      if (type === "0") {
        assertEntryName(name);
        if (files.size >= limits.maxEntries) throw new TarError("tar 归档里的文件数超过上限");
        if (size > limits.maxFileBytes) throw new TarError(`tar 文件 ${name} 超过单个文件上限`);
        total += size;
        if (total > limits.maxTotalBytes) throw new TarError("tar 归档总大小超过上限");
        if (files.has(name)) throw new TarError(`tar 归档里有重名文件 ${name}`);
        files.set(name, readExact(fd, size, position));
      }
      position += padded;
    }
  } finally {
    closeSync(fd);
  }
}

/** 把归档从头写进文件或块设备，并落盘。 */
export function writeTarFile(path: string, entries: readonly TarEntry[]): void {
  const data = writeTar(entries);
  const fd = openSync(path, "r+");
  try {
    let done = 0;
    while (done < data.length) done += writeSync(fd, data, done, data.length - done, done);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
