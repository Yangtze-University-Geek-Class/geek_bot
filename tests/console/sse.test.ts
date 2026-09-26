import { describe, expect, it, vi } from "vitest";
import { MAX_TOPICS, POLL_INTERVAL_MS, openStream, streamUrl, type EventSourceLike, type StreamMessage, type StreamStatus } from "../../app/console/src/lib/sse.js";

class FakeEventSource implements EventSourceLike {
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
  };
  const handle = openStream(options);
  return { handle, options, source: sources[0], statuses, events, timers };
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
