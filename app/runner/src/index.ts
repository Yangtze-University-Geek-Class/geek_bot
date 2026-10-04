/**
 * @geek-bot/runner 的库入口（给测试与类型使用）；可执行程序是 main.ts 打包出的单文件 dist/runner.mjs。
 * 导入本文件不会启动任何东西。
 */
export { OMP_THINKING_LEVELS, READ_ONLY_TOOLS, RELAY_PROVIDER_ID, VM_TOOLS, allowedTools, buildOmpArgs } from "./omp-args.js";
export type { OmpArgsInput } from "./omp-args.js";
export { BUNDLE_LIMITS, BundleError, extractBundleFiles, isForbiddenRepoPath, isSafeRelativePath, parseBundle } from "./bundle.js";
export type { ValidatedBundle } from "./bundle.js";
export { OMP_DISCOVERY_PROVIDERS, RELAY_KEY_ENV, writeOmpHome } from "./home.js";
export type { OmpHomeInput, OmpHomePaths } from "./home.js";
export { createAttemptState, mapOmpLine } from "./events.js";
export type { AttemptState, RunnerEvent } from "./events.js";
export { RESULT_LIMITS, ResultError, buildTaskResult, extractJsonObject } from "./result.js";
export { PatchError, buildWorkspacePatch } from "./diff.js";
export { startModelForwarder } from "./forwarder.js";
export type { ModelForwarder, Upstream } from "./forwarder.js";
export { classifyAttempt, runTask, validateRunnerTask } from "./run.js";
export type { AttemptOutcome, FailureCode, RunOptions, RunOutcome, RunnerTask } from "./run.js";
export { TarError, readTarFile, writeTar, writeTarFile } from "./tar.js";
export { RUNNER_VERSION, collectIsolation, collectProbe, ompVersion } from "./probe.js";
export type { IsolationEvidence, ProbeEvidence } from "./probe.js";
export type { TarEntry, TarReadLimits } from "./tar.js";
