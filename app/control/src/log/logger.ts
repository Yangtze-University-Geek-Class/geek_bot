/**
 * 结构化日志：每条一行 JSON（time、level、msg 加上下文字段），写出之前整条打码（src/log/redact.ts）。
 * 同一个实现给 Fastify 当 loggerInstance、给启动流程和 CLI 用；只用 Node 标准库。
 *
 * 形状兼容 Fastify 要求的 logger 接口：info、error、debug、fatal、warn、trace、silent、child、level。
 * Fastify 把它自己的 req、res、err 序列化函数经 child(bindings, { serializers }) 传进来，这里照用。
 */
import { format } from "node:util";
import type { Redactor } from "./redact.js";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

const LEVEL_VALUE: Readonly<Record<LogLevel | "silent", number>> = Object.freeze({
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Number.POSITIVE_INFINITY,
});

export interface LogSink {
  write(line: string): void;
}

type Serializer = (value: unknown) => unknown;

export interface LoggerOptions {
  readonly level: LogLevel | "silent";
  readonly redactor: Redactor;
  /** 输出位置，默认标准输出。 */
  readonly sink?: LogSink;
  /** 时间来源（毫秒），测试注入。 */
  readonly clock?: () => number;
}

interface LoggerState {
  readonly options: Required<LoggerOptions>;
  readonly bindings: Readonly<Record<string, unknown>>;
  readonly serializers: Readonly<Record<string, Serializer>>;
}

export const stdoutSink: LogSink = { write: line => void process.stdout.write(line) };

export class Logger {
  level: string;
  readonly #state: LoggerState;

  constructor(options: LoggerOptions, bindings: Record<string, unknown> = {}, serializers: Record<string, Serializer> = {}) {
    const full: Required<LoggerOptions> = { sink: stdoutSink, clock: Date.now, ...options };
    this.#state = { options: full, bindings: Object.freeze({ ...bindings }), serializers: Object.freeze({ ...serializers }) };
    this.level = options.level;
  }

  trace(first?: unknown, message?: string, ...args: unknown[]): void {
    this.#write("trace", first, message, args);
  }
  debug(first?: unknown, message?: string, ...args: unknown[]): void {
    this.#write("debug", first, message, args);
  }
  info(first?: unknown, message?: string, ...args: unknown[]): void {
    this.#write("info", first, message, args);
  }
  warn(first?: unknown, message?: string, ...args: unknown[]): void {
    this.#write("warn", first, message, args);
  }
  error(first?: unknown, message?: string, ...args: unknown[]): void {
    this.#write("error", first, message, args);
  }
  fatal(first?: unknown, message?: string, ...args: unknown[]): void {
    this.#write("fatal", first, message, args);
  }
  silent(): void {}

  /** 子日志：继承级别、输出与打码，加上固定字段；options.serializers 与已有的合并。 */
  child(bindings: Record<string, unknown>, options?: { level?: string; serializers?: Record<string, Serializer> }): Logger {
    const { options: base } = this.#state;
    const level = options?.level && options.level in LEVEL_VALUE ? (options.level as LogLevel) : (this.level as LogLevel);
    return new Logger({ ...base, level }, { ...this.#state.bindings, ...bindings }, { ...this.#state.serializers, ...options?.serializers });
  }

  #enabled(level: LogLevel): boolean {
    const threshold = LEVEL_VALUE[this.level as LogLevel] ?? LEVEL_VALUE.info;
    return LEVEL_VALUE[level] >= threshold;
  }

  #write(level: LogLevel, first: unknown, message: string | undefined, args: unknown[]): void {
    if (!this.#enabled(level)) return;
    const { options, bindings, serializers } = this.#state;
    const fields: Record<string, unknown> = {};
    let msg: string;
    if (typeof first === "string") {
      msg = format(first, ...(message === undefined ? [] : [message]), ...args);
    } else {
      if (first instanceof Error) fields.err = first;
      else if (first !== null && typeof first === "object") Object.assign(fields, first);
      msg = message === undefined ? (first instanceof Error ? first.message : "") : format(message, ...args);
    }
    for (const [key, value] of Object.entries(fields)) {
      const serializer = serializers[key];
      if (serializer && value !== undefined) fields[key] = serializer(value);
    }
    const record = options.redactor.redactValue({
      time: new Date(options.clock()).toISOString(),
      level,
      ...bindings,
      ...fields,
      msg,
    });
    options.sink.write(`${JSON.stringify(record)}\n`);
  }
}

export function createLogger(options: LoggerOptions): Logger {
  return new Logger(options);
}
