/**
 * 自检的判定规则（S-12、节点协议「自检」）：只认真实采集的证据，不认「文件存在」。
 *   - sandbox 槽位：runner 报到时交出的证据——omp --version 成功、uid 非 0、CapEff 全 0、NoNewPrivs=1、seccomp filter、
 *     根文件系统只读、除回环外没有网卡；
 *   - VM：一次真实起停的探针 VM——QMP 可用、来宾里 omp --version 成功、经 guestfwd 的模型端点连得上、
 *     直连宿主与外部地址全部连不上，并在规定时间内关机；
 *   - node 进程自身：CapEff 全 0、NoNewPrivs=1（VM 槽位的前提，ADR-0011 用容器兜底 qemu 的 -sandbox）；
 *   - 模型中继：control 的受限探针端点报告网关可达。
 * passed 只在全部启用的执行器与模型中继都通过时为真。
 */
import { readFileSync } from "node:fs";
import type { JsonValue } from "@geek-bot/protocol";

export interface IsolationEvidence {
  readonly uid: number | null;
  readonly cap_eff: string | null;
  readonly no_new_privs: number | null;
  readonly seccomp: number | null;
  readonly root_read_only: boolean | null;
  readonly interfaces: readonly string[];
}

export interface ProbeEvidence {
  readonly runner_version: string;
  readonly omp_version: string | null;
  readonly omp_error: string | null;
  readonly isolation: IsolationEvidence;
}

export interface CheckResult {
  readonly ok: boolean;
  readonly error: string | null;
  readonly checked_at: string | null;
}

export const NOT_CHECKED: CheckResult = Object.freeze({ ok: false, error: "尚未检查", checked_at: null });

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/** 把来自 sandbox 或 VM 的证据整理成固定形状；不合格字段记 null。 */
export function parseProbeEvidence(value: unknown): ProbeEvidence | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const isolation = typeof record.isolation === "object" && record.isolation !== null ? (record.isolation as Record<string, unknown>) : {};
  return {
    runner_version: str(record.runner_version) ?? "",
    omp_version: str(record.omp_version),
    omp_error: str(record.omp_error),
    isolation: {
      uid: int(isolation.uid),
      cap_eff: str(isolation.cap_eff),
      no_new_privs: int(isolation.no_new_privs),
      seccomp: int(isolation.seccomp),
      root_read_only: typeof isolation.root_read_only === "boolean" ? isolation.root_read_only : null,
      interfaces: Array.isArray(isolation.interfaces) ? isolation.interfaces.filter((item): item is string => typeof item === "string").slice(0, 32) : [],
    },
  };
}

function zeroCaps(capEff: string | null): boolean {
  return capEff !== null && /^0+$/.test(capEff);
}

/** sandbox 槽位证据的判定：返回不通过的原因（空数组表示通过）。 */
export function sandboxEvidenceProblems(evidence: ProbeEvidence, expectedOmpVersion: string | null): string[] {
  const problems: string[] = [];
  const { isolation } = evidence;
  if (!evidence.omp_version) problems.push(`omp 不可用：${evidence.omp_error ?? "没有版本输出"}`);
  else if (expectedOmpVersion && evidence.omp_version !== expectedOmpVersion) problems.push(`omp 版本 ${evidence.omp_version} 与节点期望的 ${expectedOmpVersion} 不一致`);
  if (isolation.uid === null || isolation.uid === 0) problems.push("sandbox 以 root 运行或读不到 uid");
  if (!zeroCaps(isolation.cap_eff)) problems.push(`sandbox 仍有 capability（CapEff=${isolation.cap_eff ?? "未知"}）`);
  if (isolation.no_new_privs !== 1) problems.push("sandbox 没有 no-new-privileges");
  if (!/^\d+\.\d+\.\d+$/.test(evidence.runner_version)) problems.push("runner 没有报出版本");
  if (isolation.seccomp !== 2) problems.push(`sandbox 没有 seccomp 过滤（Seccomp=${isolation.seccomp ?? "未知"}）`);
  if (isolation.root_read_only !== true) problems.push("sandbox 的根文件系统不是只读");
  if (isolation.interfaces.length > 0) problems.push(`sandbox 有网卡：${isolation.interfaces.join(",")}`);
  return problems;
}

/** node 进程自身的隔离（VM 槽位的前提）：读 /proc/self/status。 */
export function nodeProcessProblems(): string[] {
  let status: string;
  try {
    status = readFileSync("/proc/self/status", "utf8");
  } catch {
    return ["读不到 /proc/self/status（不是 Linux）"];
  }
  const field = (name: string): string | null => status.split("\n").find(line => line.startsWith(`${name}:`))?.slice(name.length + 1).trim() ?? null;
  const problems: string[] = [];
  if (!zeroCaps(field("CapEff"))) problems.push(`node 容器仍有 capability（CapEff=${field("CapEff") ?? "未知"}），VM 不能依赖它兜底 qemu`);
  if (field("NoNewPrivs") !== "1") problems.push("node 容器没有 no-new-privileges");
  if (field("Seccomp") !== "2") problems.push("node 容器没有 seccomp 过滤");
  return problems;
}

/** 心跳里 health.self_check 的固定形状，加上细节对象。 */
export function selfCheckReport(input: {
  readonly ompVersion: string | null;
  readonly sandboxEnabled: boolean;
  readonly sandbox: CheckResult;
  readonly vmEnabled: boolean;
  readonly vm: CheckResult;
  readonly model: CheckResult;
}): { self_check: { [key: string]: JsonValue }; detail: { [key: string]: JsonValue } } {
  const errors: string[] = [];
  if (input.sandboxEnabled && !input.sandbox.ok) errors.push(`sandbox：${input.sandbox.error ?? "未通过"}`);
  if (input.vmEnabled && !input.vm.ok) errors.push(`vm：${input.vm.error ?? "未通过"}`);
  if (!input.model.ok) errors.push(`模型中继：${input.model.error ?? "未通过"}`);
  const anyExecutor = input.sandboxEnabled || input.vmEnabled;
  if (!anyExecutor) errors.push("没有启用任何执行器");
  const selfCheck: { [key: string]: JsonValue } = {
    passed: errors.length === 0,
    omp_version: input.ompVersion,
    sandbox_ready: input.sandboxEnabled && input.sandbox.ok,
    vm_ready: input.vmEnabled && input.vm.ok,
    model_ready: input.model.ok,
  };
  if (errors.length > 0) selfCheck.error = errors.join("；").slice(0, 2_000);
  const view = (result: CheckResult): { [key: string]: JsonValue } => ({ ok: result.ok, error: result.error, checked_at: result.checked_at });
  return {
    self_check: selfCheck,
    detail: { sandbox: { enabled: input.sandboxEnabled, ...view(input.sandbox) }, vm: { enabled: input.vmEnabled, ...view(input.vm) }, model: view(input.model) },
  };
}
