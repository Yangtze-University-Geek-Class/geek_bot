/**
 * 自检证据：runner 在 sandbox 容器或 VM 里、接任何任务之前采集，交给节点判断。不含任何仓库内容。
 *   - omp 版本：真实执行 `omp --version`（干净 HOME，30 秒超时），不是查文件是否存在；
 *   - 进程隔离：/proc/self/status 的 CapEff、NoNewPrivs、Seccomp，uid；
 *   - 文件系统：/proc/self/mounts 里根挂载点是否只读；
 *   - 网络：除回环以外的网卡（sandbox 应当一个都没有）。
 * 字段如实填写，读不到的记 null，由节点按规则判为不通过。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";

/** runner 程序的版本；改 app/runner/package.json 的 version 时同步改这里。 */
export const RUNNER_VERSION = "0.1.0";

export interface IsolationEvidence {
  readonly uid: number | null;
  /** CapEff 的十六进制原文。 */
  readonly cap_eff: string | null;
  readonly no_new_privs: number | null;
  /** 0 关闭、1 strict、2 filter。 */
  readonly seccomp: number | null;
  readonly root_read_only: boolean | null;
  /** 回环以外的网卡名。 */
  readonly interfaces: readonly string[];
}

export interface ProbeEvidence {
  readonly runner_version: string;
  readonly omp_version: string | null;
  readonly omp_error: string | null;
  readonly isolation: IsolationEvidence;
}

function statusField(status: string, name: string): string | null {
  const line = status.split("\n").find(entry => entry.startsWith(`${name}:`));
  return line ? line.slice(name.length + 1).trim() : null;
}

/** 当前进程的隔离状态。 */
export function collectIsolation(): IsolationEvidence {
  let status = "";
  try {
    status = readFileSync("/proc/self/status", "utf8");
  } catch {
    status = "";
  }
  const number = (name: string): number | null => {
    const value = statusField(status, name);
    return value !== null && /^\d+$/.test(value) ? Number(value) : null;
  };
  let rootReadOnly: boolean | null = null;
  try {
    const root = readFileSync("/proc/self/mounts", "utf8").split("\n").map(line => line.split(" ")).filter(fields => fields[1] === "/").pop();
    if (root) rootReadOnly = root[3].split(",").includes("ro");
  } catch {
    rootReadOnly = null;
  }
  const uidField = statusField(status, "Uid");
  return {
    uid: uidField ? Number(uidField.split(/\s+/)[1]) : typeof process.geteuid === "function" ? process.geteuid() : null,
    cap_eff: statusField(status, "CapEff"),
    no_new_privs: number("NoNewPrivs"),
    seccomp: number("Seccomp"),
    root_read_only: rootReadOnly,
    interfaces: Object.keys(networkInterfaces()).filter(name => name !== "lo"),
  };
}

/** 真实执行 omp --version；可选降到指定用户。 */
export function ompVersion(ompPath: string, ompDataDir: string, runAs?: { uid: number; gid: number }): Promise<{ version: string | null; error: string | null }> {
  const home = mkdtempSync(join(tmpdir(), "geekbot-probe-"));
  return new Promise(resolve => {
    let stdout = "";
    let stderr = "";
    const child = spawn(ompPath, ["--version"], {
      env: { HOME: home, PATH: "/usr/local/bin:/usr/bin:/bin", XDG_DATA_HOME: ompDataDir, PI_NO_TITLE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      uid: runAs?.uid,
      gid: runAs?.gid,
      timeout: 30_000,
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const finish = (version: string | null, error: string | null): void => {
      rmSync(home, { recursive: true, force: true });
      resolve({ version, error });
    };
    child.once("error", error => finish(null, error.message));
    child.once("close", code => {
      const version = stdout.trim().split("\n")[0] ?? "";
      if (code === 0 && /^omp\/\d+\.\d+\.\d+/.test(version)) finish(version, null);
      else finish(null, `omp --version 退出码 ${code ?? "无"}：${(stderr || stdout).trim().slice(-300)}`);
    });
  });
}

export async function collectProbe(ompPath: string, ompDataDir: string, runAs?: { uid: number; gid: number }): Promise<ProbeEvidence> {
  const omp = await ompVersion(ompPath, ompDataDir, runAs);
  return { runner_version: RUNNER_VERSION, omp_version: omp.version, omp_error: omp.error, isolation: collectIsolation() };
}
