/**
 * 心跳里的主机健康数据与本机自我隔离（self_cordon）。只读 /proc、/sys 与 statfs，不调用外部命令。
 * 必需项（采集不到即抛错，worker 把节点设为自我隔离，不编值）：disk_free_percent、disk_free_mib（数据目录 statfs）、
 * mem_available_mib（/proc/meminfo 的 MemAvailable；不是 Linux 时取 os.freemem）。
 * 可选项（采集不到就不填，不报默认值）：
 *   - max_temp_c：至少有一个可读的 thermal_zone 或 hwmon 温度传感器时才填（云 VM 与容器常没有）；
 *   - on_battery：/sys/class/power_supply 下有交流电源或电池设备时才填（服务器与虚机常没有）。
 * 越线判定与回滞与 control 的门控一致：已知温度 ≥95°C、磁盘 <8% 或 <4096 MiB、已知电池供电时自我隔离；
 * 已知温度 <85°C 且磁盘 ≥12% 且 ≥6144 MiB 且不在电池供电后才解除。未知的可选项不触发也不阻止解除。
 */
import { readdirSync, readFileSync, statfsSync } from "node:fs";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import type { JsonValue } from "@geek-bot/protocol";

export const HEALTH_LIMITS = Object.freeze({
  tempTripC: 95,
  tempClearC: 85,
  diskTripPercent: 8,
  diskTripMib: 4096,
  diskClearPercent: 12,
  diskClearMib: 6144,
});

export interface HostHealth {
  /** 温度传感器的最高读数；没有可读传感器时为 null。 */
  readonly maxTempC: number | null;
  readonly tempSensors: number;
  readonly diskFreePercent: number;
  readonly diskFreeMib: number;
  readonly memAvailableMib: number;
  readonly memTotalMib: number;
  /** 是否电池供电；没有任何电源设备可读时为 null。 */
  readonly onBattery: boolean | null;
  readonly batteryPercent: number | null;
  readonly load: readonly number[];
  readonly cpuThreads: number;
}

function memAvailableMib(): number {
  try {
    const line = readFileSync("/proc/meminfo", "utf8").split("\n").find(entry => entry.startsWith("MemAvailable:"));
    const kib = line ? Number(line.replace(/\D+/g, "")) : Number.NaN;
    if (Number.isFinite(kib)) return Math.floor(kib / 1024);
  } catch {
    // 不是 Linux：退回 os.freemem。
  }
  return Math.floor(freemem() / 1024 / 1024);
}

/** 全部 thermal_zone 与 hwmon 温度传感器的读数（摄氏度）。 */
function temperaturesC(): number[] {
  const readings: number[] = [];
  const readMilli = (path: string): void => {
    try {
      const milli = Number(readFileSync(path, "utf8").trim());
      // 传感器偶尔报 -273 或明显错误的值，丢掉。
      if (Number.isFinite(milli) && milli > -50_000 && milli < 200_000) readings.push(Math.round(milli / 100) / 10);
    } catch {
      // 这个传感器读不出。
    }
  };
  try {
    for (const zone of readdirSync("/sys/class/thermal")) if (zone.startsWith("thermal_zone")) readMilli(`/sys/class/thermal/${zone}/temp`);
  } catch {
    // 没有 thermal 子系统。
  }
  try {
    for (const hwmon of readdirSync("/sys/class/hwmon")) {
      for (const file of readdirSync(`/sys/class/hwmon/${hwmon}`)) if (/^temp\d+_input$/.test(file)) readMilli(`/sys/class/hwmon/${hwmon}/${file}`);
    }
  } catch {
    // 没有 hwmon。
  }
  return readings;
}

/** 电源：有接通的交流电源时不算电池供电；只有电池且在放电时算电池供电。没有任何可读的电源设备时返回 null。 */
function power(): { onBattery: boolean | null; batteryPercent: number | null } {
  let supplies: string[];
  try {
    supplies = readdirSync("/sys/class/power_supply");
  } catch {
    return { onBattery: null, batteryPercent: null };
  }
  let known = false;
  let acOnline = false;
  let discharging = false;
  let batteryPercent: number | null = null;
  for (const name of supplies) {
    const read = (file: string): string | null => {
      try {
        return readFileSync(`/sys/class/power_supply/${name}/${file}`, "utf8").trim();
      } catch {
        return null;
      }
    };
    const type = read("type");
    if (type === "Mains" || type === "USB") {
      const online = read("online");
      if (online === "1" || online === "0") known = true;
      if (online === "1") acOnline = true;
    } else if (type === "Battery") {
      const status = read("status");
      if (status !== null) known = true;
      if (status === "Discharging") discharging = true;
      const capacity = Number(read("capacity"));
      if (Number.isFinite(capacity)) batteryPercent = batteryPercent === null ? capacity : Math.min(batteryPercent, capacity);
    }
  }
  return { onBattery: known ? !acOnline && discharging : null, batteryPercent };
}

/** 采集一次；必需项采集不到时抛错。 */
export function collectHostHealth(dataDir: string): HostHealth {
  const stat = statfsSync(dataDir);
  const totalBytes = stat.blocks * stat.bsize;
  const freeBytes = stat.bavail * stat.bsize;
  if (!(totalBytes > 0)) throw new Error("数据目录所在文件系统的总大小为 0");
  const memAvailable = memAvailableMib();
  if (!Number.isFinite(memAvailable) || memAvailable < 0) throw new Error("读不出可用内存");
  const temps = temperaturesC();
  const supply = power();
  const [load1, load5, load15] = loadavg();
  return {
    maxTempC: temps.length > 0 ? Math.max(...temps) : null,
    tempSensors: temps.length,
    diskFreePercent: Math.round((freeBytes / totalBytes) * 1000) / 10,
    diskFreeMib: Math.floor(freeBytes / 1024 / 1024),
    memAvailableMib: memAvailable,
    memTotalMib: Math.floor(totalmem() / 1024 / 1024),
    onBattery: supply.onBattery,
    batteryPercent: supply.batteryPercent,
    load: [Math.round(load1 * 100) / 100, Math.round(load5 * 100) / 100, Math.round(load15 * 100) / 100],
    cpuThreads: cpus().length,
  };
}

/** 心跳 health 里的健康字段（control 要求的键名）；未知的可选项不填。 */
export function healthFields(health: HostHealth, kvmAvailable: boolean): { [key: string]: JsonValue } {
  const fields: { [key: string]: JsonValue } = {
    temp_sensors: health.tempSensors,
    disk_free_percent: health.diskFreePercent,
    disk_free_mib: health.diskFreeMib,
    mem_available_mib: health.memAvailableMib,
    mem_total_mib: health.memTotalMib,
    load: [...health.load],
    cpu_threads: health.cpuThreads,
    kvm_available: kvmAvailable,
  };
  if (health.maxTempC !== null) fields.max_temp_c = health.maxTempC;
  if (health.onBattery !== null) fields.on_battery = health.onBattery;
  if (health.batteryPercent !== null) fields.battery_percent = health.batteryPercent;
  return fields;
}

/**
 * 自我隔离的回滞判定：当前已隔离时只有全部回到解除线以内才解除；未隔离时任一越过触发线就隔离。
 * 返回新的隔离原因（null 表示不隔离）。
 */
export function nextSelfCordon(current: string | null, health: HostHealth): string | null {
  const limits = HEALTH_LIMITS;
  const trips: string[] = [];
  if (health.maxTempC !== null && health.maxTempC >= limits.tempTripC) trips.push(`温度 ${health.maxTempC}°C ≥ ${limits.tempTripC}°C`);
  if (health.diskFreePercent < limits.diskTripPercent) trips.push(`磁盘剩余 ${health.diskFreePercent}% < ${limits.diskTripPercent}%`);
  if (health.diskFreeMib < limits.diskTripMib) trips.push(`磁盘剩余 ${health.diskFreeMib} MiB < ${limits.diskTripMib} MiB`);
  if (health.onBattery === true) trips.push("电池供电");
  if (trips.length > 0) return trips.join("；");
  if (current === null) return null;
  const pending: string[] = [];
  if (health.maxTempC !== null && health.maxTempC >= limits.tempClearC) pending.push(`温度 ${health.maxTempC}°C 还没降到 ${limits.tempClearC}°C 以下`);
  if (health.diskFreePercent < limits.diskClearPercent) pending.push(`磁盘剩余 ${health.diskFreePercent}% 还没回到 ${limits.diskClearPercent}%`);
  if (health.diskFreeMib < limits.diskClearMib) pending.push(`磁盘剩余 ${health.diskFreeMib} MiB 还没回到 ${limits.diskClearMib} MiB`);
  return pending.length > 0 ? `恢复中：${pending.join("；")}` : null;
}
