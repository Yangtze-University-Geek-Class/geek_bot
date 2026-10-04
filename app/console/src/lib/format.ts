/**
 * 后台展示用的格式化函数。本目录不导入 Vue，可以直接在 Node 里测试。
 */

const UNITS = [
  { label: "天", ms: 86_400_000 },
  { label: "小时", ms: 3_600_000 },
  { label: "分钟", ms: 60_000 },
  { label: "秒", ms: 1_000 },
] as const;

/**
 * 把毫秒格式化成中文时长，最多显示相邻的两级单位，零头向下取整。
 * 例：45000 → 「45 秒」；180000 → 「3 分钟」；7500000 → 「2 小时 5 分钟」；
 * 0 → 「0 秒」；1 到 999 → 「不到 1 秒」。负数、NaN、无穷大抛 RangeError。
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`时长必须是非负的有限数，当前值：${ms}`);
  if (ms === 0) return "0 秒";
  if (ms < 1_000) return "不到 1 秒";
  let rest = Math.floor(ms);
  const counts = UNITS.map(unit => {
    const count = Math.floor(rest / unit.ms);
    rest -= count * unit.ms;
    return count;
  });
  const first = counts.findIndex(count => count > 0);
  const parts = [`${counts[first]} ${UNITS[first].label}`];
  const next = first + 1;
  if (next < UNITS.length && counts[next] > 0) parts.push(`${counts[next]} ${UNITS[next].label}`);
  return parts.join(" ");
}

const TIME_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** ISO 时间格式化成本地时间；null 写「从未」，解析不了的原样返回。 */
export function formatTime(iso: string | null): string {
  if (iso === null) return "从未";
  const time = Date.parse(iso);
  return Number.isNaN(time) ? iso : TIME_FORMAT.format(time);
}

/** MiB 写成人看的内存大小：不足 1 GiB 写 MiB，否则保留一位小数的 GiB。 */
export function formatMemory(mib: number): string {
  return mib < 1024 ? `${mib} MiB` : `${(mib / 1024).toFixed(mib % 1024 === 0 ? 0 : 1)} GiB`;
}
