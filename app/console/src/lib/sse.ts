/**
 * 实时推送客户端（docs/architecture/API.md「SSE」，A-56 `GET /api/v1/stream`）。本目录不导入 Vue。
 *
 * - 用浏览器的 EventSource 连接；断线重连时浏览器自己带 Last-Event-ID，control 从环形缓冲补发。
 * - 连接出错后退回每 5 秒轮询一次（由调用方提供 poll，调对应的 GET 端点），重新连上后停止轮询。
 * - 收到 `reset` 表示补发不了，调用方要重新拉取当前页的数据；收到 `session_expired` 关闭连接、不再重连。
 * - 事件里的文本已由 control 打码，渲染时仍按纯文本处理（S-05）。
 *
 * 服务端的 SSE 由 #14 实现；在那之前外壳不建立连接，本模块由单测覆盖。EventSource 与定时器都可注入。
 */
import type { StreamTopic } from "@geek-bot/protocol";

/** 断线后轮询对应 GET 端点的间隔（API.md「SSE」）。 */
export const POLL_INTERVAL_MS = 5_000;
/** 每个连接最多订阅的 topic 数（A-56）。 */
export const MAX_TOPICS = 20;
/** 连接上要监听的事件类型（API.md「SSE」事件表）。 */
export const STREAM_EVENT_TYPES = Object.freeze([
  "overview.stats",
  "task.created",
  "task.updated",
  "task.event",
  "task.attempt",
  "publish.updated",
  "node.updated",
  "node.health",
  "repo.updated",
  "bot.status",
  "alert.raised",
  "alert.resolved",
  "settings.updated",
] as const);
export type StreamEventType = (typeof STREAM_EVENT_TYPES)[number];

/** connecting：正在建立连接；live：实时推送正常；polling：断线，正在轮询；closed：会话过期或已停止。 */
export type StreamStatus = "connecting" | "live" | "polling" | "closed";

export interface StreamEvent {
  readonly type: StreamEventType;
  /** 服务端的事件 id（实例内单调递增的整数，按字符串保存）。 */
  readonly id: string;
  readonly data: unknown;
}

/** 事件里本模块读取的字段（浏览器的 MessageEvent 满足它）。 */
export interface StreamMessage {
  readonly data: string;
  readonly lastEventId: string;
}

/**
 * EventSource 里本模块用到的部分，测试注入假实现。
 * onopen、onerror 的事件参数不读取：浏览器与 Node 的类型声明对它的类型写法不同，用 never 让两者都能赋值。
 */
export interface EventSourceLike {
  onopen: ((event: never) => void) | null;
  onerror: ((event: never) => void) | null;
  addEventListener(type: string, listener: (event: StreamMessage) => void): void;
  close(): void;
}

export interface StreamOptions {
  readonly topics: readonly StreamTopic[];
  readonly onEvent: (event: StreamEvent) => void;
  readonly onStatus: (status: StreamStatus) => void;
  /** 收到 `reset`：重新拉取当前页的数据。 */
  readonly onReset: () => void;
  /** 断线期间每 5 秒调用一次。 */
  readonly poll: () => void;
  readonly createEventSource?: (url: string) => EventSourceLike;
  readonly setInterval?: (handler: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}

export interface StreamHandle {
  readonly url: string;
  close(): void;
}

export function streamUrl(topics: readonly StreamTopic[]): string {
  if (topics.length === 0) throw new RangeError("至少要订阅一个 topic");
  if (topics.length > MAX_TOPICS) throw new RangeError(`每个连接最多订阅 ${MAX_TOPICS} 个 topic，当前 ${topics.length} 个`);
  return `/api/v1/stream?topics=${topics.map(encodeURIComponent).join(",")}`;
}

export function openStream(options: StreamOptions): StreamHandle {
  const url = streamUrl(options.topics);
  const create: (target: string) => EventSourceLike = options.createEventSource ?? (target => new EventSource(target, { withCredentials: true }));
  const startTimer = options.setInterval ?? ((handler, ms) => globalThis.setInterval(handler, ms));
  const stopTimer = options.clearInterval ?? (handle => globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>));

  let status: StreamStatus | null = null;
  let pollTimer: unknown = null;
  const setStatus = (next: StreamStatus) => {
    if (next === status) return;
    status = next;
    options.onStatus(next);
  };
  const stopPolling = () => {
    if (pollTimer === null) return;
    stopTimer(pollTimer);
    pollTimer = null;
  };
  const startPolling = () => {
    if (pollTimer !== null) return;
    pollTimer = startTimer(options.poll, POLL_INTERVAL_MS);
  };

  setStatus("connecting");
  const source = create(url);
  const close = () => {
    stopPolling();
    source.close();
    setStatus("closed");
  };

  source.onopen = () => {
    if (status === "closed") return;
    stopPolling();
    setStatus("live");
  };
  // EventSource 出错后会自己重连；重连成功前退回轮询，页面顶部只显示一条提示，不换成错误页。
  source.onerror = () => {
    if (status === "closed") return;
    startPolling();
    setStatus("polling");
  };
  for (const type of STREAM_EVENT_TYPES) {
    source.addEventListener(type, event => {
      if (status === "closed") return;
      options.onEvent({ type, id: event.lastEventId, data: parseData(event.data) });
    });
  }
  source.addEventListener("reset", () => {
    if (status !== "closed") options.onReset();
  });
  source.addEventListener("session_expired", () => close());

  return { url, close };
}

/** data 是一行 JSON；解析不了时保留原文，不抛错打断整条连接。 */
function parseData(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
