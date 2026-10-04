import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskEvent } from "../../packages/protocol/src/index.js";
import { TaskSpool, SpoolCorruptError, SpoolFullError, type SpoolLease, type SpooledOutcome } from "../../app/node/src/spool.js";

const AT = new Date(Date.UTC(2031, 3, 5, 12)).toISOString();
const synthetic = () => randomBytes(16).toString("hex");
const event = (kind: TaskEvent["kind"], text: string): Omit<TaskEvent, "seq"> => ({ at: AT, kind, text });
const lineBytes = (value: TaskEvent): number => Buffer.byteLength(`${JSON.stringify(value)}\n`);

 describe("TaskSpool durable recovery", () => {
  let dataDir: string;
  let root: string;
  let lease: SpoolLease;
  let handles: TaskSpool[];

  beforeEach(() => {
    handles = [];
    dataDir = mkdtempSync(join(tmpdir(), "geek-bot-spool-"));
    root = TaskSpool.ensureRoot(dataDir);
    lease = { task_id: `task_${synthetic()}`, lease_id: synthetic(), epoch: 7,
      boot_id: synthetic(), created_at: AT };
  });

  afterEach(() => {
    try {
      for (const spool of handles) spool.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  function create(maxBytes = 32 * 1024 * 1024): TaskSpool {
    const spool = TaskSpool.create(root, lease, maxBytes);
    handles.push(spool);
    return spool;
  }

  function reopen(spool: TaskSpool, maxBytes = 32 * 1024 * 1024): TaskSpool {
    spool.close();
    const recovered = TaskSpool.open(spool.dir, maxBytes);
    handles.push(recovered);
    return recovered;
  }

  function replay(spool: TaskSpool): TaskEvent[] {
    return spool.batch(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  }

  it("replays synced events and a saved failure after losing the original handle", () => {
    const spool = create();
    const inputs = [event("text", `日志 ${synthetic()} 🚀`), event("tool", synthetic()), event("error", synthetic())];
    inputs.forEach(input => spool.append(input));
    spool.sync();
    const outcome: SpooledOutcome = { kind: "failure", code: "infra_failure", message: synthetic() };
    spool.saveOutcome(outcome);

    const recovered = reopen(spool);
    expect(replay(recovered)).toEqual(inputs.map((input, index) => ({ ...input, seq: index + 1 })));
    expect(recovered.outcome()).toEqual(outcome);
    recovered.append(event("retry", "recovery attempt"));
    const again = reopen(recovered);
    expect(replay(again)).toEqual([
      ...inputs.map((input, index) => ({ ...input, seq: index + 1 })),
      { ...event("retry", "recovery attempt"), seq: 4 },
    ]);
    expect(again.outcome()).toEqual(outcome);
  });

  it("persists acknowledgements without replaying their prefix or losing later appends", () => {
    const spool = create();
    const inputs = [event("text", "first"), event("tool", "second"), event("model", "third")];
    inputs.forEach(input => spool.append(input));
    spool.ack(2);
    spool.append(event("error", "after acknowledgement"));

    const recovered = reopen(spool);
    expect(replay(recovered)).toEqual([
      { ...inputs[2]!, seq: 3 }, { ...event("error", "after acknowledgement"), seq: 4 },
    ]);
    recovered.ack(1);
    recovered.ack(4);
    const empty = reopen(recovered);
    expect(replay(empty)).toEqual([]);
    empty.append(event("retry", "next attempt"));
    expect(replay(reopen(empty))).toEqual([{ ...event("retry", "next attempt"), seq: 5 }]);
  });

  it("keeps the unacknowledged suffix and sequence watermark through physical prefix compaction", () => {
    const spool = create();
    spool.append(event("text", "x".repeat(8 * 1024 * 1024 + 1)));
    const survivor = event("tool", synthetic());
    spool.append(survivor);
    spool.ack(1);
    const recovered = reopen(spool);
    expect(replay(recovered)).toEqual([{ ...survivor, seq: 2 }]);
    expect(statSync(join(recovered.dir, "events.jsonl")).size).toBe(lineBytes({ ...survivor, seq: 2 }));
    recovered.append(event("model", "after compaction"));
    expect(replay(reopen(recovered))).toEqual([
      { ...survivor, seq: 2 }, { ...event("model", "after compaction"), seq: 3 },
    ]);
  });

  it("evicts the oldest text first while retaining tool, error, retry and model events across recovery", () => {
    const inputs = [
      event("text", "a".repeat(4096)),
      event("tool", "tool retained"), event("error", "error retained"),
      event("retry", "retry retained"), event("model", "model retained"),
      event("text", "b".repeat(4096)),
    ];
    const expected = inputs.map((input, index) => ({ ...input, seq: index + 1 }));
    // The first five fit. The sixth exceeds the cap; evicting only the
    // oldest text leaves enough room even for the 90% relief target.
    const cap = expected.slice(0, 5).reduce((sum, value) => sum + lineBytes(value), 0) + 1024;
    const spool = create(cap);
    inputs.forEach(input => spool.append(input));
    const recovered = reopen(spool, cap);
    expect(replay(recovered)).toEqual(expected.slice(1));
    recovered.append(event("tool", "next sequence"));
    expect(replay(reopen(recovered, cap))).toEqual([
      ...expected.slice(1), { ...event("tool", "next sequence"), seq: 7 },
    ]);
  });

  it("surfaces essential-only overflow without silently discarding the event that triggered it", () => {
    const first = event("tool", synthetic());
    const second = event("error", synthetic());
    const cap = lineBytes({ ...first, seq: 1 });
    const spool = create(cap);
    spool.append(first);
    expect(() => spool.append(second)).toThrow(SpoolFullError);
    const recovered = reopen(spool, cap);
    expect(replay(recovered)).toEqual([{ ...first, seq: 1 }, { ...second, seq: 2 }]);
    recovered.ack(2);
    recovered.append(event("retry", "resumed"));
    expect(replay(reopen(recovered, cap))).toEqual([{ ...event("retry", "resumed"), seq: 3 }]);
  });

  it("recovers a crash-truncated tail, preserves complete records and appends a parseable continuation", () => {
    const spool = create();
    const complete = event("model", synthetic());
    spool.append(complete);
    spool.sync();
    spool.close();
    const tail = JSON.stringify({ ...event("text", synthetic()), seq: 2 });
    appendFileSync(join(spool.dir, "events.jsonl"), tail.slice(0, Math.floor(tail.length / 2)));

    const recovered = reopen(spool);
    expect(replay(recovered)).toEqual([{ ...complete, seq: 1 }]);
    expect(statSync(join(recovered.dir, "events.jsonl")).size).toBe(lineBytes({ ...complete, seq: 1 }));
    recovered.append(event("tool", "after truncated tail"));
    expect(replay(reopen(recovered))).toEqual([
      { ...complete, seq: 1 }, { ...event("tool", "after truncated tail"), seq: 2 },
    ]);
  });

  it("rejects a corrupt complete event record instead of treating it as a recoverable tail", () => {
    const spool = create();
    spool.append(event("tool", synthetic()));
    spool.close();
    appendFileSync(join(spool.dir, "events.jsonl"), "{broken}\n");
    expect(() => TaskSpool.open(spool.dir, 1024 * 1024)).toThrow(SpoolCorruptError);
  });

  it.each([
    { name: "invalid JSON", corrupt: () => "{" },
    { name: "missing lease identity", corrupt: (value: SpoolLease) => JSON.stringify({ ...value, lease_id: "" }) },
    { name: "non-integral epoch", corrupt: (value: SpoolLease) => JSON.stringify({ ...value, epoch: 1.5 }) },
    { name: "unsafe task path", corrupt: (value: SpoolLease) => JSON.stringify({ ...value, task_id: "../escape" }) },
  ])("surfaces $name in a persisted lease", ({ corrupt }) => {
    const spool = create();
    spool.close();
    writeFileSync(join(spool.dir, "lease.json"), corrupt(lease));
    expect(() => TaskSpool.open(spool.dir, 1024 * 1024)).toThrow(SpoolCorruptError);
  });

  it.each(["../escape", "nested/task", "nested\\task", ""])("refuses unsafe task id %j before creating spool files", task_id => {
    const before = readdirSync(root);
    expect(() => TaskSpool.create(root, { ...lease, task_id }, 1024)).toThrow(SpoolCorruptError);
    expect(readdirSync(root)).toEqual(before);
    expect(readdirSync(dataDir)).toEqual(["spool"]);
  });

  it.each([
    { name: "invalid JSON", raw: "{" },
    { name: "invalid failure shape", raw: JSON.stringify({ kind: "failure", code: "infra_failure", message: 7 }) },
  ])("surfaces $name in a durable outcome", ({ raw }) => {
    const spool = create();
    spool.saveOutcome({ kind: "failure", code: "timeout", message: synthetic() });
    spool.close();
    writeFileSync(join(spool.dir, "outcome.json"), raw);
    const recovered = reopen(spool);
    expect(() => recovered.outcome()).toThrow(SpoolCorruptError);
  });

  it.skipIf(process.platform === "win32")("keeps recovery files private through atomic replacements and event compaction", () => {
    chmodSync(root, 0o755);
    TaskSpool.ensureRoot(dataDir);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    const spool = create();
    spool.append(event("text", "x".repeat(8 * 1024 * 1024 + 1)));
    spool.append(event("error", synthetic()));
    spool.ack(1);
    spool.saveOutcome({ kind: "failure", code: "infra_failure", message: synthetic() });
    spool.saveOutcome({ kind: "failure", code: "timeout", message: synthetic() });
    const recovered = reopen(spool);
    expect(statSync(recovered.dir).mode & 0o777).toBe(0o700);
    for (const name of ["lease.json", "events.jsonl", "ack", "outcome.json"]) {
      expect(statSync(join(recovered.dir, name)).mode & 0o777, name).toBe(0o600);
    }
  });
});
