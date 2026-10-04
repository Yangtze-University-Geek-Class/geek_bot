/**
 * 每个租约一份磁盘事件缓存（spool），放在 <数据目录>/spool/<task_id>@<epoch>/（目录 0700，文件 0600）：
 *   lease.json    租约身份：task_id、lease_id、epoch、领到它的 boot_id；
 *   events.jsonl  已打码、还没被 control 确认的事件（一行一个 TaskEvent，只追加）；
 *   ack           control 已确认到的 seq；
 *   outcome.json  执行器交回、还没被 control 接收的结果或失败。
 * 事件写进页缓存后才算产生；节点每次回传前 fsync，进程崩溃不丢事件，掉电最多丢最后一秒。
 * 未确认事件超过上限时先丢最早的 text 事件（tool、error、retry、model 一律保留）；只剩保留类事件仍超限时抛 SpoolFullError，
 * 由调用方让任务失败，不静默丢事件。写盘失败照常抛出，不当作成功。
 * 目录只在这些时候删除：control 接收了结果或失败、control 以 409/404 作废了租约、401（全部删除），以及内容损坏无法回放。
 * 节点重启或失联后留下的目录由 worker 用原来的租约栅栏回放：control 接受就交完再删，作废就直接删。
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeSync, chmodSync, ftruncateSync, fstatSync } from "node:fs";
import { join } from "node:path";
import type { TaskEvent, TaskResult } from "@geek-bot/protocol";
import type { FailureCode } from "./control-client.js";

export interface SpoolLease {
  readonly task_id: string;
  readonly lease_id: string;
  readonly epoch: number;
  readonly boot_id: string;
  readonly created_at: string;
}

export type SpooledOutcome =
  | { readonly kind: "result"; readonly result: TaskResult }
  | { readonly kind: "failure"; readonly code: FailureCode; readonly message: string };

export class SpoolFullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpoolFullError";
  }
}

export class SpoolCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpoolCorruptError";
  }
}

interface IndexEntry {
  readonly seq: number;
  readonly kind: TaskEvent["kind"];
  readonly offset: number;
  readonly length: number;
}

const TASK_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const DIR_RE = /^([A-Za-z0-9_-]{1,128})@([1-9][0-9]{0,9})$/;
const EVENT_KINDS: ReadonlySet<string> = new Set(["text", "tool", "error", "retry", "model"]);
/** 已确认的前缀超过这个大小时重写文件，回收空间。 */
const COMPACT_ACKED_BYTES = 8 * 1024 * 1024;

/** 写临时文件、fsync、改名：要么是旧内容，要么是完整的新内容。 */
function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    const buffer = Buffer.from(data);
    let done = 0;
    while (done < buffer.length) done += writeSync(fd, buffer, done, buffer.length - done);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

function writeAll(fd: number, buffer: Buffer): void {
  let done = 0;
  while (done < buffer.length) done += writeSync(fd, buffer, done, buffer.length - done);
}

function readAt(fd: number, offset: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const read = readSync(fd, buffer, done, length - done, offset + done);
    if (read === 0) throw new SpoolCorruptError("事件缓存文件比索引短");
    done += read;
  }
  return buffer;
}

function parseEvent(line: string): TaskEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { seq, at, kind, text } = value as Record<string, unknown>;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) return null;
  if (typeof at !== "string" || typeof kind !== "string" || !EVENT_KINDS.has(kind) || typeof text !== "string") return null;
  return { seq, at, kind: kind as TaskEvent["kind"], text };
}

function parseOutcome(value: unknown): SpooledOutcome | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.kind === "result" && typeof record.result === "object" && record.result !== null) return { kind: "result", result: record.result as TaskResult };
  if (record.kind === "failure" && typeof record.code === "string" && typeof record.message === "string") {
    return { kind: "failure", code: record.code as FailureCode, message: record.message };
  }
  return null;
}

export class TaskSpool {
  readonly dir: string;
  readonly lease: SpoolLease;
  readonly #maxBytes: number;
  #fd: number | null;
  #entries: IndexEntry[];
  #fileBytes: number;
  #pendingBytes: number;
  #ack: number;
  #nextSeq: number;
  #dirty = false;
  #removed = false;

  private constructor(dir: string, lease: SpoolLease, maxBytes: number, fd: number, entries: IndexEntry[], fileBytes: number, ack: number, nextSeq: number) {
    this.dir = dir;
    this.lease = lease;
    this.#maxBytes = maxBytes;
    this.#fd = fd;
    this.#entries = entries;
    this.#fileBytes = fileBytes;
    this.#pendingBytes = entries.reduce((sum, entry) => sum + entry.length, 0);
    this.#ack = ack;
    this.#nextSeq = nextSeq;
  }

  /** 建好缓存根目录（0700）并返回它。 */
  static ensureRoot(dataDir: string): string {
    const root = join(dataDir, "spool");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    return root;
  }

  /** 目录名是否是一份租约缓存（task_id@epoch）。 */
  static isSpoolDir(name: string): boolean {
    return DIR_RE.test(name);
  }

  /** 为新领到的租约建缓存。同名目录（同一租约）不应存在，存在就说明状态混乱，直接报错。 */
  static create(root: string, lease: SpoolLease, maxBytes: number): TaskSpool {
    if (!TASK_ID_RE.test(lease.task_id)) throw new SpoolCorruptError(`task_id 不能作目录名：${JSON.stringify(lease.task_id).slice(0, 80)}`);
    const dir = join(root, `${lease.task_id}@${lease.epoch}`);
    mkdirSync(dir, { mode: 0o700 });
    writeAtomic(join(dir, "lease.json"), JSON.stringify(lease));
    writeAtomic(join(dir, "ack"), "0");
    const fd = openSync(join(dir, "events.jsonl"), "a+", 0o600);
    return new TaskSpool(dir, lease, maxBytes, fd, [], 0, 0, 1);
  }

  /** 打开上次留下的缓存（重启或失联后回放）。lease.json 或事件文件损坏时抛 SpoolCorruptError。 */
  static open(dir: string, maxBytes: number): TaskSpool {
    let lease: SpoolLease;
    try {
      const value: unknown = JSON.parse(readFileSync(join(dir, "lease.json"), "utf8"));
      const record = value as Record<string, unknown>;
      if (typeof record.task_id !== "string" || !TASK_ID_RE.test(record.task_id) || typeof record.lease_id !== "string" || record.lease_id === ""
        || typeof record.epoch !== "number" || !Number.isInteger(record.epoch) || record.epoch < 1 || typeof record.boot_id !== "string") {
        throw new SpoolCorruptError("lease.json 字段不全");
      }
      lease = { task_id: record.task_id, lease_id: record.lease_id, epoch: record.epoch, boot_id: record.boot_id, created_at: typeof record.created_at === "string" ? record.created_at : "" };
    } catch (error) {
      if (error instanceof SpoolCorruptError) throw error;
      throw new SpoolCorruptError(`读不出 lease.json：${error instanceof Error ? error.message : String(error)}`);
    }
    let ack = 0;
    try {
      const text = readFileSync(join(dir, "ack"), "utf8").trim();
      if (/^[0-9]+$/.test(text)) ack = Number(text);
    } catch {
      ack = 0;
    }
    const fd = openSync(join(dir, "events.jsonl"), "a+", 0o600);
    try {
      const size = fstatSync(fd).size;
      const data = size > 0 ? readAt(fd, 0, size) : Buffer.alloc(0);
      const entries: IndexEntry[] = [];
      let offset = 0;
      let lastSeq = ack;
      while (offset < data.length) {
        const newline = data.indexOf(0x0a, offset);
        if (newline === -1) {
          // 崩溃时写了半行：截掉这半行。
          ftruncateSync(fd, offset);
          break;
        }
        const event = parseEvent(data.subarray(offset, newline).toString("utf8"));
        if (!event) throw new SpoolCorruptError(`events.jsonl 在偏移 ${offset} 处损坏`);
        const length = newline + 1 - offset;
        if (event.seq > ack) entries.push({ seq: event.seq, kind: event.kind, offset, length });
        lastSeq = Math.max(lastSeq, event.seq);
        offset = newline + 1;
      }
      return new TaskSpool(dir, lease, maxBytes, fd, entries, offset, ack, lastSeq + 1);
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  /** 目录已删除（结果已交给 control，或租约已作废）。 */
  get removed(): boolean {
    return this.#removed;
  }

  get pendingCount(): number {
    return this.#entries.length;
  }

  #requireFd(): number {
    if (this.#fd === null) throw new Error(`事件缓存 ${this.dir} 已关闭`);
    return this.#fd;
  }

  /** 追加一条事件并分配 seq。超限时按规则腾空间；腾不出来抛 SpoolFullError（这条事件已写入）。 */
  append(event: Omit<TaskEvent, "seq">): TaskEvent {
    const fd = this.#requireFd();
    const entry: TaskEvent = { seq: this.#nextSeq, at: event.at, kind: event.kind, text: event.text };
    const line = Buffer.from(`${JSON.stringify(entry)}\n`);
    writeAll(fd, line);
    this.#entries.push({ seq: entry.seq, kind: entry.kind, offset: this.#fileBytes, length: line.length });
    this.#fileBytes += line.length;
    this.#pendingBytes += line.length;
    this.#nextSeq += 1;
    this.#dirty = true;
    if (this.#pendingBytes > this.#maxBytes) this.#relieve();
    return entry;
  }

  /** 先丢最早的 text 事件到上限的 90%，再重写文件；只剩保留类事件仍超限时抛 SpoolFullError。 */
  #relieve(): void {
    const target = Math.floor(this.#maxBytes * 0.9);
    const kept: IndexEntry[] = [];
    let pending = this.#pendingBytes;
    for (const entry of this.#entries) {
      if (pending > target && entry.kind === "text") {
        pending -= entry.length;
        continue;
      }
      kept.push(entry);
    }
    this.#rewrite(kept);
    if (this.#pendingBytes > this.#maxBytes) {
      throw new SpoolFullError(`未确认的事件超过 ${Math.round(this.#maxBytes / 1024 / 1024)} MiB，丢掉全部文本事件后仍然超限`);
    }
  }

  /** 把给定的未确认事件重写成新文件（临时文件 + fsync + 改名），重建偏移。 */
  #rewrite(entries: readonly IndexEntry[]): void {
    const fd = this.#requireFd();
    const path = join(this.dir, "events.jsonl");
    const tmp = `${path}.tmp`;
    const out = openSync(tmp, "w", 0o600);
    const rebuilt: IndexEntry[] = [];
    let offset = 0;
    try {
      for (const entry of entries) {
        const line = readAt(fd, entry.offset, entry.length);
        writeAll(out, line);
        rebuilt.push({ seq: entry.seq, kind: entry.kind, offset, length: entry.length });
        offset += entry.length;
      }
      fsyncSync(out);
    } finally {
      closeSync(out);
    }
    renameSync(tmp, path);
    closeSync(fd);
    this.#fd = openSync(path, "a+", 0o600);
    this.#entries = rebuilt;
    this.#fileBytes = offset;
    this.#pendingBytes = offset;
    this.#dirty = false;
  }

  /** 最早的一批未确认事件（seq 递增、连续取自队首）。 */
  batch(maxCount: number, maxBytes: number): TaskEvent[] {
    const fd = this.#requireFd();
    const events: TaskEvent[] = [];
    let bytes = 0;
    for (const entry of this.#entries) {
      if (events.length >= maxCount || (events.length > 0 && bytes + entry.length > maxBytes)) break;
      const event = parseEvent(readAt(fd, entry.offset, entry.length).toString("utf8").trimEnd());
      if (!event || event.seq !== entry.seq) throw new SpoolCorruptError(`事件 ${entry.seq} 读回来不对`);
      events.push(event);
      bytes += entry.length;
    }
    return events;
  }

  /** 把未写盘的追加落盘。 */
  sync(): void {
    if (!this.#dirty || this.#fd === null) return;
    fsyncSync(this.#fd);
    this.#dirty = false;
  }

  /** control 接收了 seq 不超过 throughSeq 的事件：持久化确认点，必要时回收已确认的前缀。 */
  ack(throughSeq: number): void {
    if (throughSeq <= this.#ack) return;
    let index = 0;
    while (index < this.#entries.length && this.#entries[index].seq <= throughSeq) {
      this.#pendingBytes -= this.#entries[index].length;
      index += 1;
    }
    this.#entries = this.#entries.slice(index);
    this.#ack = throughSeq;
    writeAtomic(join(this.dir, "ack"), String(throughSeq));
    if (this.#fileBytes - this.#pendingBytes > COMPACT_ACKED_BYTES) this.#rewrite(this.#entries);
  }

  saveOutcome(outcome: SpooledOutcome): void {
    writeAtomic(join(this.dir, "outcome.json"), JSON.stringify(outcome));
  }

  outcome(): SpooledOutcome | null {
    let raw: string;
    try {
      raw = readFileSync(join(this.dir, "outcome.json"), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new SpoolCorruptError("outcome.json 不是 JSON");
    }
    const outcome = parseOutcome(value);
    if (!outcome) throw new SpoolCorruptError("outcome.json 形状不对");
    return outcome;
  }

  close(): void {
    if (this.#fd === null) return;
    closeSync(this.#fd);
    this.#fd = null;
  }

  /** 关闭并删除整个缓存目录。 */
  remove(): void {
    if (this.#removed) return;
    this.close();
    rmSync(this.dir, { recursive: true, force: true });
    this.#removed = true;
  }
}
