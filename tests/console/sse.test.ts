import { describe, expect, it, vi } from "vitest";
import { MAX_TOPICS, POLL_INTERVAL_MS, RECONNECT_BASE_MS, RECONNECT_MAX_MS, openStream, streamUrl, type EventSourceLike, type StreamMessage, type StreamStatus } from "../../app/console/src/lib/sse.js";

class FakeEventSource implements EventSourceLike {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  readonly listeners = new Map<string, ((event: StreamMessage) => void)[]>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (event: StreamMessage) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  /** 浏览器放弃重连：响应不是 200 时 EventSource 进入 CLOSED 再触发 error。 */
  failHard() {
    this.readyState = 2;
    this.onerror?.(new Event("error"));
  }
  emit(type: string, data: string, lastEventId = "1") {
    for (const listener of this.listeners.get(type) ?? []) listener({ data, lastEventId });
  }
}

function setup() {
  const sources: FakeEventSource[] = [];
  const statuses: StreamStatus[] = [];
  const events: unknown[] = [];
  const timers = new Map<number, () => void>();
  const timeouts = new Map<number, { handler: () => void; ms: number }>();
  let nextTimer = 0;
  const options = {
    topics: ["overview", "queue"] as const,
    onEvent: vi.fn((event: unknown) => events.push(event)),
    onStatus: (status: StreamStatus) => statuses.push(status),
    onReset: vi.fn(),
    poll: vi.fn(),
    createEventSource: (url: string) => {
      const source = new FakeEventSource(url);
      sources.push(source);
      return source;
    },
    setInterval: vi.fn((handler: () => void, ms: number) => {
      expect(ms).toBe(POLL_INTERVAL_MS);
      timers.set(++nextTimer, handler);
      return nextTimer;
    }),
    clearInterval: vi.fn((handle: unknown) => timers.delete(handle as number)),
    setTimeout: vi.fn((handler: () => void, ms: number) => {
      timeouts.set(++nextTimer, { handler, ms });
      return nextTimer;
    }),
    clearTimeout: vi.fn((handle: unknown) => timeouts.delete(handle as number)),
  };
  const handle = openStream(options);
  /** 触发下一个待执行的重连定时器，返回它的延迟。 */
  const fireReconnect = () => {
    const [id, timeout] = [...timeouts.entries()][0];
    timeouts.delete(id);
    timeout.handler();
    return timeout.ms;
  };
  return { handle, options, sources, source: sources[0], statuses, events, timers, timeouts, fireReconnect };
}

describe("streamUrl", () => {
  it("topic 用逗号连接，逐个编码", () => {
    expect(streamUrl(["overview", "task:t 1"])).toBe("/api/v1/stream?topics=overview,task%3At%201");
  });

  it("没有 topic 或超过上限时拒绝", () => {
    expect(() => streamUrl([])).toThrow(RangeError);
    expect(() => streamUrl(Array.from({ length: MAX_TOPICS + 1 }, (_, i) => `task:${i}` as const))).toThrow(RangeError);
  });
});

describe("openStream", () => {
  it("连上前是 connecting，连上后是 live，事件按类型解析 JSON", () => {
    const { source, statuses, events } = setup();
    expect(source.url).toBe("/api/v1/stream?topics=overview,queue");
    source.onopen?.(new Event("open"));
    source.emit("task.created", '{"task_id":"t1"}', "41");
    expect(statuses).toEqual(["connecting", "live"]);
    expect(events).toEqual([{ type: "task.created", id: "41", data: { task_id: "t1" } }]);
  });

  it("断线后退回每 5 秒轮询，重新连上后停止轮询", () => {
    const { source, statuses, timers, options } = setup();
    source.onopen?.(new Event("open"));
    source.onerror?.(new Event("error"));
    source.onerror?.(new Event("error"));
    expect(statuses).toEqual(["connecting", "live", "polling"]);
    expect(options.setInterval).toHaveBeenCalledTimes(1);
    for (const tick of timers.values()) tick();
    expect(options.poll).toHaveBeenCalledTimes(1);
    source.onopen?.(new Event("open"));
    expect(statuses.at(-1)).toBe("live");
    expect(timers.size).toBe(0);
  });

  it("浏览器自己重连（readyState 不是 CLOSED）时不重建连接", () => {
    const { source, sources, timeouts } = setup();
    source.onerror?.(new Event("error"));
    expect(sources).toHaveLength(1);
    expect(timeouts.size).toBe(0);
  });

  it("EventSource 进入 CLOSED 后按 5 秒起、翻倍、最长 60 秒退避重建；重建后连上会让页面重新拉取", () => {
    const { source, sources, statuses, timers, options, fireReconnect } = setup();
    source.onopen?.(new Event("open"));
    source.failHard();
    expect(source.closed).toBe(true);
    expect(statuses.at(-1)).toBe("polling");
    expect(timers.size).toBe(1);

    const delays: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      delays.push(fireReconnect());
      sources.at(-1)?.failHard();
    }
    expect(delays).toEqual([RECONNECT_BASE_MS, 10_000, 20_000, 40_000, RECONNECT_MAX_MS, RECONNECT_MAX_MS]);
    expect(sources).toHaveLength(7);
    expect(options.onReset).not.toHaveBeenCalled();

    fireReconnect();
    const rebuilt = sources.at(-1)!;
    rebuilt.onopen?.(new Event("open"));
    expect(statuses.at(-1)).toBe("live");
    expect(timers.size).toBe(0);
    expect(options.onReset).toHaveBeenCalledTimes(1);

    rebuilt.failHard();
    expect(fireReconnect()).toBe(RECONNECT_BASE_MS);
  });

  it("重建后的连接只在第一次连上时让页面重新拉取；之后浏览器自己重连不再触发", () => {
    const { source, sources, options, fireReconnect } = setup();
    source.failHard();
    fireReconnect();
    const rebuilt = sources.at(-1)!;
    rebuilt.onopen?.(new Event("open"));
    rebuilt.onerror?.(new Event("error"));
    rebuilt.onopen?.(new Event("open"));
    expect(options.onReset).toHaveBeenCalledTimes(1);
  });

  it("旧连接上迟到的事件与回调被忽略", () => {
    const { source, sources, events, statuses, fireReconnect } = setup();
    source.failHard();
    fireReconnect();
    const current = sources.at(-1)!;
    current.onopen?.(new Event("open"));
    source.emit("task.created", "{}");
    source.onerror?.(new Event("error"));
    expect(events).toEqual([]);
    expect(statuses.at(-1)).toBe("live");
  });

  it("close 取消待执行的重连", () => {
    const { handle, source, timeouts, sources } = setup();
    source.failHard();
    expect(timeouts.size).toBe(1);
    handle.close();
    expect(timeouts.size).toBe(0);
    expect(sources).toHaveLength(1);
  });

  it("收到 reset 时让调用方重新拉取", () => {
    const { source, options } = setup();
    source.emit("reset", "");
    expect(options.onReset).toHaveBeenCalledTimes(1);
  });

  it("收到 session_expired 关闭连接、停止轮询，之后的事件不再处理", () => {
    const { source, statuses, timers, options } = setup();
    source.onerror?.(new Event("error"));
    source.emit("session_expired", "");
    expect(source.closed).toBe(true);
    expect(statuses.at(-1)).toBe("closed");
    expect(timers.size).toBe(0);
    source.emit("task.updated", "{}");
    source.onerror?.(new Event("error"));
    expect(options.onEvent).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toBe("closed");
  });

  it("data 不是 JSON 时保留原文，不打断连接", () => {
    const { source, events } = setup();
    source.emit("alert.raised", "not-json", "7");
    expect(events).toEqual([{ type: "alert.raised", id: "7", data: "not-json" }]);
  });

  it("调用方 close 后关闭连接", () => {
    const { handle, source, statuses } = setup();
    handle.close();
    expect(source.closed).toBe(true);
    expect(statuses.at(-1)).toBe("closed");
  });
});
