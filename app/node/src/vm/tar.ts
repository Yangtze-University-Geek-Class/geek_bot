/**
 * VM 输入盘与输出盘的 ustar 归档（与 runner 的 src/tar.ts 读写同一格式；两个包按边界规则不能互相导入实现）。
 * 节点只写普通文件；读来宾写回的输出盘时只把普通文件读进内存（有数量与大小上限），从不按归档里的路径落盘。
 */
import { closeSync, openSync, readSync } from "node:fs";

const BLOCK = 512;

export interface TarEntry {
  readonly name: string;
  readonly data: Buffer;
}

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, "0");
  if (text.length > length - 1) throw new Error(`数值超出 tar 字段长度：${value}`);
  header.write(`${text}\0`, offset, length, "ascii");
}

function readOctal(header: Buffer, offset: number, length: number): number {
  const text = header.subarray(offset, offset + length).toString("ascii").replace(/\0.*$/s, "").trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error("tar 头里的数值字段不是八进制");
  return Number.parseInt(text, 8);
}

function checksum(header: Buffer): number {
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) sum += index >= 148 && index < 156 ? 32 : header[index];
  return sum;
}

export function writeTar(entries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(entry.name)) throw new Error(`tar 文件名不合法：${entry.name}`);
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

/** 读输出盘：只收列在 wanted 里的普通文件，单个文件不超过 maxFileBytes；其它条目跳过。 */
export function readTarSelected(path: string, wanted: ReadonlySet<string>, maxFileBytes: number): Map<string, Buffer> {
  const fd = openSync(path, "r");
  const files = new Map<string, Buffer>();
  try {
    let position = 0;
    for (let entries = 0; entries < 64; entries += 1) {
      const header = Buffer.alloc(BLOCK);
      if (readSync(fd, header, 0, BLOCK, position) !== BLOCK) return files;
      position += BLOCK;
      if (header.every(byte => byte === 0)) return files;
      if (readOctal(header, 148, 8) !== checksum(header)) throw new Error("输出盘的 tar 头校验和不符");
      const size = readOctal(header, 124, 12);
      const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "").replace(/^\.\//, "");
      const type = String.fromCharCode(header[156] || 48);
      if (type === "0" && wanted.has(name) && !files.has(name)) {
        if (size > maxFileBytes) throw new Error(`输出盘里的 ${name} 超过上限`);
        const data = Buffer.alloc(size);
        if (readSync(fd, data, 0, size, position) !== size) throw new Error(`输出盘里的 ${name} 不完整`);
        files.set(name, data);
      }
      position += Math.ceil(size / BLOCK) * BLOCK;
    }
    return files;
  } finally {
    closeSync(fd);
  }
}
