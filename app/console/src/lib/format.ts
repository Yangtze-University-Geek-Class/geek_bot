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
