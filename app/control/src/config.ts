/**
 * control 的产品默认值，以及从环境变量读取并校验这些值。
 * 这里只做纯计算：调用方传入环境变量表，本文件不读 process.env，也不读文件。
 */

export type Env = Readonly<Record<string, string | undefined>>;

export interface ControlConfig {
  /** 轮询已监控仓库的间隔（秒）。 */
  readonly pollIntervalSeconds: number;
  /** 静默窗口（秒）：最后一次非机器人变动之后等这么久才入队。 */
  readonly quietWindowSeconds: number;
  /** 等回复的第几天发提醒。 */
  readonly remindAfterDays: number;
  /** 等回复的第几天关闭 issue，必须晚于提醒。 */
  readonly closeAfterDays: number;
  /** 同一个 issue 最多追问几轮。 */
  readonly maxFollowUpRounds: number;
  /** PR 通道每台临时 VM 的 vCPU 数。 */
  readonly vmVcpus: number;
  /** PR 通道每台临时 VM 的内存（MiB）。 */
  readonly vmMemoryMiB: number;
}

type ControlKey = keyof ControlConfig;

/** 产品默认值：轮询 60 秒、静默窗口 300 秒、第 5 天提醒、第 7 天关闭、最多追问 2 轮、每台 VM 1 vCPU / 2 GiB。 */
export const CONTROL_DEFAULTS: ControlConfig = Object.freeze({
  pollIntervalSeconds: 60,
  quietWindowSeconds: 300,
  remindAfterDays: 5,
  closeAfterDays: 7,
  maxFollowUpRounds: 2,
  vmVcpus: 1,
  vmMemoryMiB: 2048,
});

/** 每个配置项对应的环境变量名。部署模板里的字段名必须与这里一致。 */
export const CONTROL_ENV: Readonly<Record<ControlKey, string>> = Object.freeze({
  pollIntervalSeconds: "GEEK_BOT_POLL_INTERVAL_SECONDS",
  quietWindowSeconds: "GEEK_BOT_QUIET_WINDOW_SECONDS",
  remindAfterDays: "GEEK_BOT_REMIND_AFTER_DAYS",
  closeAfterDays: "GEEK_BOT_CLOSE_AFTER_DAYS",
  maxFollowUpRounds: "GEEK_BOT_MAX_FOLLOWUP_ROUNDS",
  vmVcpus: "GEEK_BOT_VM_VCPUS",
  vmMemoryMiB: "GEEK_BOT_VM_MEMORY_MIB",
});

/**
 * 每个配置项允许的最小值。静默窗口和追问轮数可以是 0（不等待、不追问）。
 * VM 内存下限 512 MiB，用来拦下把 GiB 误写成 MiB 的情况。
 */
const MINIMUM: Readonly<Record<ControlKey, number>> = Object.freeze({
  pollIntervalSeconds: 1,
  quietWindowSeconds: 0,
  remindAfterDays: 1,
  closeAfterDays: 1,
  maxFollowUpRounds: 0,
  vmVcpus: 1,
  vmMemoryMiB: 512,
});

/** 配置不合法时抛出；problems 逐条列出每个问题，message 是它们按行拼起来的结果。 */
export class ControlConfigError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`control 配置不合法：\n${problems.join("\n")}`);
    this.name = "ControlConfigError";
    this.problems = Object.freeze([...problems]);
  }
}

/** 读一个整数项：未设置或留空时用默认值；不合法时记下问题并返回 undefined。 */
function readInteger(env: Env, key: ControlKey, problems: string[]): number | undefined {
  const name = CONTROL_ENV[key];
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return CONTROL_DEFAULTS[key];
  const text = raw.trim();
  const minimum = MINIMUM[key];
  const value = /^[0-9]+$/.test(text) ? Number(text) : Number.NaN;
  if (Number.isSafeInteger(value) && value >= minimum) return value;
  const expected = minimum === 0 ? "非负整数" : `不小于 ${minimum} 的整数`;
  problems.push(`${name} 必须是${expected}，当前值：${JSON.stringify(raw)}`);
  return undefined;
}

/** 按默认值加环境变量覆盖生成 control 配置；任一项不合法时抛出 ControlConfigError，列出全部问题。 */
export function createControlConfig(env: Env = {}): ControlConfig {
  const problems: string[] = [];
  const values = {} as Record<ControlKey, number | undefined>;
  for (const key of Object.keys(CONTROL_ENV) as ControlKey[]) values[key] = readInteger(env, key, problems);

  const { remindAfterDays, closeAfterDays } = values;
  // 两项都合法时才比较先后，避免把单项错误再报成一条误导的比较错误。
  if (remindAfterDays !== undefined && closeAfterDays !== undefined && closeAfterDays <= remindAfterDays) {
    problems.push(
      `关闭天数必须大于提醒天数：${CONTROL_ENV.closeAfterDays}=${closeAfterDays}，${CONTROL_ENV.remindAfterDays}=${remindAfterDays}`,
    );
  }
  if (problems.length > 0) throw new ControlConfigError(problems);
  return Object.freeze(values as Record<ControlKey, number>);
}
