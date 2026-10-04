/**
 * 实时事件总线（API.md「SSE」）：实例内单调递增的事件 id，内存环形缓冲保留最近 10 分钟，供 Last-Event-ID 补发。
 * 事件只带公共记录（records.ts 序列化后的值），写入前经过打码。
 */
import type { Redactor } from "../log/redact.js";

export const STREAM_TOPICS_FIXED = Object.freeze(["overview", "queue", "nodes", "repos", "alerts", "connections", "projects", "demands", "machines"] as const);
const BUFFER_MS = 10 * 60_000;
const BUFFER_MAX = 5000;

export interface BusEvent {
  readonly id: number;
  readonly at: number;
  readonly type: string;
  readonly topics: readonly string[];
  readonly data: string;
}

export type BusListener = (event: BusEvent) => void;

export interface EventBus {
  publish(type: string, topics: readonly string[], data: unknown): void;
  /** 订阅；返回取消函数。 */
  subscribe(listener: BusListener): () => void;
  /** Last-Event-ID 之后的事件；超出缓冲范围返回 null（需要发 reset）。 */
  since(lastId: number): BusEvent[] | null;
}

export function createEventBus(redactor: Redactor, clock: () => number): EventBus {
  let nextId = 1;
  const buffer: BusEvent[] = [];
  const listeners = new Set<BusListener>();
  const prune = (now: number) => {
    while (buffer.length > 0 && (buffer.length > BUFFER_MAX || now - (buffer[0] as BusEvent).at > BUFFER_MS)) buffer.shift();
  };
  return {
    publish(type, topics, data) {
      const now = clock();
      const event: BusEvent = Object.freeze({ id: nextId++, at: now, type, topics: Object.freeze([...topics]), data: JSON.stringify(redactor.redactValue(data)) });
      buffer.push(event);
      prune(now);
      for (const listener of listeners) listener(event);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    since(lastId) {
      prune(clock());
      if (lastId >= nextId) return null;
      const first = buffer[0];
      if (lastId + 1 < nextId && (first === undefined || first.id > lastId + 1)) return null;
      return buffer.filter(event => event.id > lastId);
    },
  };
}
