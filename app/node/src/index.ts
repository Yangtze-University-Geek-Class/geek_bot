/**
 * @geek-bot/node 的库入口（给测试与类型使用）；可执行程序是 main.ts（dist/main.js）。导入本文件不会启动任何服务。
 */
export { NODE_CONFIG_ENV, NODE_NAME_PATTERN, NODE_SLOT_DEFAULTS, NODE_SLOT_ENV, NodeConfigError, createNodeConfig } from "./config.js";
export type { Env, NodeConfig } from "./config.js";
export { WORKER_CONFIG_ENV, createWorkerConfig } from "./worker-config.js";
export type { EgressConfig, HostDefaults, VmAssets, WorkerConfig } from "./worker-config.js";
export { ControlClient, ControlHttpError } from "./control-client.js";
export type { ControlClientOptions, FailureCode, RenewReply } from "./control-client.js";
export { REDACTED, createRedactor } from "./redact.js";
export {
  FORBIDDEN_IPV4,
  FORBIDDEN_IPV6,
  GITHUB_SUFFIXES,
  buildBlockList,
  chooseAddress,
  decideTarget,
  isForbiddenAddress,
  matchesSuffix,
  parseClientHelloSni,
  parseConnectLine,
  startEgressProxy,
} from "./egress-proxy.js";
export type { EgressProxy, EgressProxyOptions, EgressRecord } from "./egress-proxy.js";
export { RUNNER_FAILURE_CODES, normalizeRunnerEvent, runnerTaskOf, validateTaskResult } from "./executor.js";
export type { ExecutionHandle, ExecutionOutcome, ExecutionSink, RunnerEventInput, TaskExecutor } from "./executor.js";
export { handleModelRequest } from "./model-relay.js";
export type { RelayContext } from "./model-relay.js";
export { SandboxPool } from "./sandbox.js";
export type { SandboxPoolOptions } from "./sandbox.js";
export { VmPool } from "./vm/pool.js";
export type { VmPoolOptions, VmReadiness } from "./vm/pool.js";
export { readTarSelected, writeTar } from "./vm/tar.js";
export type { TarEntry } from "./vm/tar.js";
export { Worker, isExecutionTask } from "./worker.js";
export type { LogLevel, Logger, WorkerOptions } from "./worker.js";
export { HEALTH_LIMITS, collectHostHealth, healthFields, nextSelfCordon } from "./health.js";
export type { HostHealth } from "./health.js";
export { NOT_CHECKED, nodeProcessProblems, parseProbeEvidence, sandboxEvidenceProblems, selfCheckReport } from "./self-check.js";
export type { CheckResult, IsolationEvidence, ProbeEvidence } from "./self-check.js";
export { SpoolCorruptError, SpoolFullError, TaskSpool } from "./spool.js";
export type { SpoolLease, SpooledOutcome } from "./spool.js";
