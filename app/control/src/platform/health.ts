/**
 * 节点自检与主机健康门（S-12、S-13；节点协议「节点状态」「主机健康字段」）。
 *
 * 心跳 health 里由节点上报（control 只当数据校验，类型不对 400）：
 *   self_check: { passed, omp_version, sandbox_ready, vm_ready, model_ready, error? }
 *   max_temp_c、disk_free_percent、disk_free_mib、mem_available_mib：数字；on_battery：布尔；采集不到的不填
 *
 * 调度必需的数据（自检、磁盘、可用内存）缺失时按不健康处理（fail closed）。温度与供电是可选传感器：
 * 云主机常常没有，缺失时只记一条提示（warnings），不当作越线，也不当作「已证明正常」；已知越线才关门。
 * 越线（已知温度 ≥ 95 °C、磁盘可用 < 8% 或 < 4 GiB、已知电池供电、自检未通过）时门打开：不派任何任务；
 * 恢复要满足回滞条件（已知温度 < 85 °C、磁盘 ≥ 12% 且 ≥ 6 GiB）才关门。
 * 槽位还要各自 ready：sandbox_ready 为假时 sandbox 槽位为 0，vm_ready 为假时 vm 槽位为 0（缺 cap_drop、
 * no-new-privileges、/dev/kvm 或内核资源由节点自检报告为 vm_ready=false）。
 */
import { PlatformError } from "./http.js";

export interface SelfCheck {
  readonly passed: boolean;
  /** 节点上 omp 的版本；探测不到时为 null，这时自检视为没通过。 */
  readonly omp_version: string | null;
  readonly sandbox_ready: boolean;
  readonly vm_ready: boolean;
  readonly model_ready: boolean;
  readonly error?: string;
}

export interface HostHealth {
  readonly self_check: SelfCheck | null;
  readonly max_temp_c: number | null;
  readonly disk_free_percent: number | null;
  readonly disk_free_mib: number | null;
  readonly mem_available_mib: number | null;
  readonly on_battery: boolean | null;
  /** 节点本地越线判定后的自行隔离原因；null 表示没有。 */
  readonly self_cordon: string | null;
}

export const GATE_LIMITS = Object.freeze({ tempC: 95, diskPercent: 8, diskMib: 4096, recoverTempC: 85, recoverDiskPercent: 12, recoverDiskMib: 6144 });
/** VM 任务要求的可用内存余量：任务内存 + 1 GiB。 */
export const VM_MEMORY_HEADROOM_MIB = 1024;

const SELF_CHECK_KEYS = new Set(["passed", "omp_version", "sandbox_ready", "vm_ready", "model_ready", "error"]);

function invalid(field: string): PlatformError {
  return new PlatformError(400, "validation_failed", `心跳的 health.${field} 不符合约定`);
}

function number(value: unknown, field: string, min: number, max: number): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw invalid(field);
  return value;
}

/** 校验并取出健康字段；类型不对 400，缺失为 null（按不健康处理）。 */
export function parseHealth(health: { readonly [key: string]: unknown }): HostHealth {
  let selfCheck: SelfCheck | null = null;
  const raw = health.self_check;
  if (raw !== undefined && raw !== null) {
    if (typeof raw !== "object" || Array.isArray(raw)) throw invalid("self_check");
    const check = raw as { readonly [key: string]: unknown };
    if (Object.keys(check).some(key => !SELF_CHECK_KEYS.has(key))) throw invalid("self_check");
    for (const key of ["passed", "sandbox_ready", "vm_ready", "model_ready"] as const) if (typeof check[key] !== "boolean") throw invalid(`self_check.${key}`);
    if (check.omp_version !== null && (typeof check.omp_version !== "string" || check.omp_version.length > 64)) throw invalid("self_check.omp_version");
    if (check.error !== undefined && (typeof check.error !== "string" || check.error.length > 1000)) throw invalid("self_check.error");
    selfCheck = {
      // 探测不到 omp 版本时不能证明执行器可用：自检按没通过处理，不信任节点自报的 passed。
      passed: (check.passed as boolean) && check.omp_version !== null,
      omp_version: check.omp_version,
      sandbox_ready: check.sandbox_ready as boolean,
      vm_ready: check.vm_ready as boolean,
      model_ready: check.model_ready as boolean,
      ...(typeof check.error === "string" ? { error: check.error } : {}),
    };
  }
  if (health.on_battery !== undefined && health.on_battery !== null && typeof health.on_battery !== "boolean") throw invalid("on_battery");
  return {
    self_check: selfCheck,
    max_temp_c: number(health.max_temp_c, "max_temp_c", -50, 200),
    disk_free_percent: number(health.disk_free_percent, "disk_free_percent", 0, 100),
    disk_free_mib: number(health.disk_free_mib, "disk_free_mib", 0, 1e12),
    mem_available_mib: number(health.mem_available_mib, "mem_available_mib", 0, 1e9),
    on_battery: typeof health.on_battery === "boolean" ? health.on_battery : null,
    self_cordon: (() => {
      const value = health.self_cordon;
      if (value === undefined || value === null) return null;
      if (typeof value !== "string" || value.length > 1000) throw invalid("self_cordon");
      return value;
    })(),
  };
}

/**
 * 健康门的原因列表；空表示可以派任务。wasOpen 为真时按恢复阈值判断（回滞），避免在阈值附近来回切换。
 */
export function gateReasons(health: HostHealth, wasOpen: boolean): string[] {
  const reasons: string[] = [];
  const check = health.self_check;
  if (check === null) reasons.push("没有自检结果");
  else if (!check.passed || !check.model_ready) reasons.push(`自检未通过${check.error ? `：${check.error.slice(0, 200)}` : ""}`);
  const tempLimit = wasOpen ? GATE_LIMITS.recoverTempC : GATE_LIMITS.tempC;
  if (health.max_temp_c !== null && health.max_temp_c >= tempLimit) reasons.push(`温度 ${health.max_temp_c}°C 越线`);
  const percentLimit = wasOpen ? GATE_LIMITS.recoverDiskPercent : GATE_LIMITS.diskPercent;
  const mibLimit = wasOpen ? GATE_LIMITS.recoverDiskMib : GATE_LIMITS.diskMib;
  if (health.disk_free_percent === null || health.disk_free_mib === null) reasons.push("磁盘可用空间未知");
  else if (health.disk_free_percent < percentLimit || health.disk_free_mib < mibLimit) reasons.push("磁盘可用空间不足");
  if (health.on_battery === true) reasons.push("电池供电");
  if (health.mem_available_mib === null) reasons.push("可用内存未知");
  if (health.self_cordon !== null) reasons.push(`节点自行隔离：${health.self_cordon.slice(0, 200)}`);
  return reasons;
}

/** 采集不到的可选传感器：只用于展示与审计，不影响派发。 */
export function healthWarnings(health: HostHealth): string[] {
  const warnings: string[] = [];
  if (health.max_temp_c === null) warnings.push("没有温度读数");
  if (health.on_battery === null) warnings.push("没有供电状态");
  return warnings;
}

/** 按自检把声明的槽位收紧：对应执行器没就绪时为 0。 */
export function readySlots(health: HostHealth, slots: { sandbox: number; vm: number }): { sandbox: number; vm: number } {
  const check = health.self_check;
  return { sandbox: check?.sandbox_ready === true ? slots.sandbox : 0, vm: check?.vm_ready === true ? slots.vm : 0 };
}
