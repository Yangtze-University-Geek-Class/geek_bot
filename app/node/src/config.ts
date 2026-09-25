/**
 * node 从环境变量读取并校验自己的配置：control 地址、节点名、各执行器的槽位上限。
 * 这里只做纯计算：调用方传入环境变量表，本文件不读 process.env，也不读令牌文件。
 */
import { EXECUTORS } from "@geek-bot/protocol";
import type { Executor } from "@geek-bot/protocol";

export type Env = Readonly<Record<string, string | undefined>>;

export interface NodeConfig {
  /** control 的地址，只允许 http 或 https；不带末尾斜杠。 */
  readonly controlUrl: string;
  /** 节点名，与后台「节点 → 添加」时填写的名称一致。 */
  readonly name: string;
  /** 本节点在本地声明的槽位上限，按执行器分：sandbox 给 issue 通道，vm 给 pr 通道。 */
  readonly slots: Readonly<Record<Executor, number>>;
}

/** 环境变量名。部署模板里的字段名必须与这里一致。 */
export const NODE_CONFIG_ENV = Object.freeze({
  controlUrl: "GEEK_BOT_NODE_CONTROL_URL",
  name: "GEEK_BOT_NODE_NAME",
});

/** 各执行器槽位数对应的环境变量名。 */
export const NODE_SLOT_ENV: Readonly<Record<Executor, string>> = Object.freeze({
  sandbox: "GEEK_BOT_NODE_SANDBOX_SLOTS",
  vm: "GEEK_BOT_NODE_VM_SLOTS",
});

/**
 * 槽位默认值：sandbox 1 个，vm 0 个。
 * VM 需要 /dev/kvm，并且要等一次性 VM 的实测（#12）通过，所以默认不开，由部署者显式打开。
 */
export const NODE_SLOT_DEFAULTS: Readonly<Record<Executor, number>> = Object.freeze({
  sandbox: 1,
  vm: 0,
});

/** 节点名：小写字母、数字和连字符，1 到 63 个字符，首尾不能是连字符。 */
export const NODE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** 配置不合法时抛出；problems 逐条列出每个问题，message 是它们按行拼起来的结果。 */
export class NodeConfigError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`node 配置不合法：\n${problems.join("\n")}`);
    this.name = "NodeConfigError";
    this.problems = Object.freeze([...problems]);
  }
}

function readRequired(env: Env, name: string, problems: string[]): string | undefined {
  const value = env[name]?.trim();
  if (value) return value;
  problems.push(`缺少环境变量 ${name}`);
  return undefined;
}

function readControlUrl(env: Env, problems: string[]): string {
  const name = NODE_CONFIG_ENV.controlUrl;
  const raw = readRequired(env, name, problems);
  if (raw === undefined) return "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    problems.push(`${name} 不是合法的 URL，当前值：${JSON.stringify(raw)}`);
    return "";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    problems.push(`${name} 只允许 http 或 https，当前协议：${url.protocol.replace(/:$/, "")}`);
    return "";
  }
  // 节点令牌只从文件读取，地址里不许夹带账号密码；查询串和片段对节点 API 没有意义。
  if (url.username || url.password) problems.push(`${name} 不能包含用户名或密码`);
  if (url.search || url.hash) problems.push(`${name} 不能包含查询串或片段`);
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function readName(env: Env, problems: string[]): string {
  const name = NODE_CONFIG_ENV.name;
  const raw = readRequired(env, name, problems);
  if (raw === undefined) return "";
  if (!NODE_NAME_PATTERN.test(raw)) {
    problems.push(`${name} 只能包含小写字母、数字和连字符（1 到 63 个字符，首尾不能是连字符），当前值：${JSON.stringify(raw)}`);
  }
  return raw;
}

function readSlots(env: Env, executor: Executor, problems: string[]): number {
  const name = NODE_SLOT_ENV[executor];
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return NODE_SLOT_DEFAULTS[executor];
  const text = raw.trim();
  const value = /^[0-9]+$/.test(text) ? Number(text) : Number.NaN;
  if (Number.isSafeInteger(value)) return value;
  problems.push(`${name} 必须是非负整数，当前值：${JSON.stringify(raw)}`);
  return NODE_SLOT_DEFAULTS[executor];
}

/** 从环境变量生成 node 配置；任一项不合法时抛出 NodeConfigError，列出全部问题。 */
export function createNodeConfig(env: Env): NodeConfig {
  const problems: string[] = [];
  const controlUrl = readControlUrl(env, problems);
  const name = readName(env, problems);
  const slots = {} as Record<Executor, number>;
  for (const executor of EXECUTORS) slots[executor] = readSlots(env, executor, problems);
  if (problems.length > 0) throw new NodeConfigError(problems);
  return Object.freeze({ controlUrl, name, slots: Object.freeze(slots) });
}
