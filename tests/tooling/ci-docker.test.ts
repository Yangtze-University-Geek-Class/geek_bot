import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// ci.yml 的 docker job（#3）：断言基础镜像按 digest 钉死、control 镜像非 root、带 HEALTHCHECK，起一次容器后
// /readyz 200、SIGTERM 后以 0 退出且日志里有 checkpoint 完成的一行，并纳入 verify 的汇总。
// 步骤脚本按 GitHub 的 bash 参数真实执行；docker、curl、sudo、sleep 换成本测试的桩（按环境变量回答），不需要 Docker。
const root = resolve(import.meta.dirname, "..", "..");
const ci = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
const lines = ci.split("\n");

function jobLines(job: string): string[] {
  const start = lines.indexOf(`  ${job}:`);
  expect(start, `ci.yml 里没有 job ${job}`).toBeGreaterThan(0);
  const end = lines.findIndex((line, index) => index > start && /^ {2}\S/.test(line));
  return lines.slice(start, end < 0 ? undefined : end);
}

/** 某个步骤的 `run: |` 块（去掉 10 格缩进）。 */
function stepScript(job: string, name: string): string {
  const body = jobLines(job);
  const at = body.findIndex(line => line === `      - name: ${name}`);
  expect(at, `docker job 里没有步骤：${name}`).toBeGreaterThan(0);
  const run = body.findIndex((line, index) => index > at && /^ {8}run: \|\s*$/.test(line));
  const script: string[] = [];
  for (const line of body.slice(run + 1)) {
    if (line.trim() !== "" && !line.startsWith(" ".repeat(10))) break;
    script.push(line.slice(10));
  }
  return `${script.join("\n").trim()}\n`;
}

const stubDir = mkdtempSync(join(tmpdir(), "geek-bot-docker-stub-"));
afterAll(() => rmSync(stubDir, { recursive: true, force: true }));
function stub(name: string, lines: string[]): void {
  writeFileSync(join(stubDir, name), ["#!/usr/bin/env bash", ...lines, ""].join("\n"));
  chmodSync(join(stubDir, name), 0o755);
}
stub("docker", [
  'if [ "$1 $2" = "image inspect" ]; then',
  '  case "$4" in *Config.User*) printf "%s\\n" "$STUB_USER" ;; *) printf "%s\\n" "$STUB_HEALTHCHECK" ;; esac',
  'elif [ "$1" = "run" ]; then',
  '  printf "%s\\n" "$STUB_UID"',
  'elif [ "$1" = "stop" ]; then',
  '  printf "%s\\n" "$2"',
  'elif [ "$1" = "inspect" ]; then',
  '  printf "%s\\n" "$STUB_EXIT"',
  'elif [ "$1" = "logs" ]; then',
  '  printf "%s\\n" "$STUB_LOGS"',
  "else",
  '  echo "unexpected docker call: $*" >&2; exit 99',
  "fi",
]);
stub("curl", ['if [ "$STUB_READY" = "yes" ]; then printf "%s" \'{"status":"ready"}\'; exit 0; fi', "exit 7"]);
stub("sleep", ["exit 0"]);
// CI 上的 sudo chown 把密钥交给容器里的 uid 1000；桩里跳过 chown，其余照常执行。
stub("sudo", ['if [ "$1" = "chown" ]; then exit 0; fi', 'exec "$@"']);

function runStep(name: string, env: Record<string, string>, cwd = root) {
  return spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", stepScript("docker", name)], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}`, ...env },
  });
}

const HEALTHCHECK = '{"Test":["CMD","node","/app/app/control/dist/healthcheck.js"],"Interval":15000000000}';

function assertImage(answer: { user: string; healthcheck: string; uid: string }) {
  return runStep("断言镜像以非 root 运行、带 HEALTHCHECK", { STUB_USER: answer.user, STUB_HEALTHCHECK: answer.healthcheck, STUB_UID: answer.uid });
}

const PIN = `sha256:${"0123456789abcdef".repeat(4)}`;

/** 在临时目录里放一个 app/control/Dockerfile，跑「基础镜像按 digest 钉死」这一步。 */
function assertPinned(dockerfile: string) {
  const dir = mkdtempSync(join(tmpdir(), "geek-bot-dockerfile-"));
  try {
    mkdirSync(join(dir, "app", "control"), { recursive: true });
    writeFileSync(join(dir, "app", "control", "Dockerfile"), dockerfile);
    return runStep("断言基础镜像按 digest 钉死", {}, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CHECKPOINT_LINE = '{"time":"2026-09-26T03:00:00.000Z","level":"info","busy":0,"log":4,"checkpointed":4,"msg":"WAL 已 checkpoint，库已关闭"}';

function runContainer(answer: { ready: boolean; exit: string; logs: string }) {
  return runStep("起一次容器：/readyz 返回 200，SIGTERM 后以 0 退出并 checkpoint", {
    STUB_READY: answer.ready ? "yes" : "no",
    STUB_EXIT: answer.exit,
    STUB_LOGS: answer.logs,
    STUB_UID: "container-id",
  });
}

describe("ci.yml 的 docker job", () => {
  it("只构建、不推送：用仓库根作上下文构建 app/control/Dockerfile，不登录镜像仓库、不 push", () => {
    const body = jobLines("docker").join("\n");
    expect(body).toContain("run: docker build -f app/control/Dockerfile -t geek-bot-control:ci .");
    expect(body).not.toMatch(/docker (?:push|login)|buildx .*--push|packages: write|secrets\./);
    expect(body).toContain("persist-credentials: false");
  });

  it("镜像以非 root 用户运行、带 CMD 形式的 HEALTHCHECK 时断言通过", () => {
    const result = assertImage({ user: "node", healthcheck: HEALTHCHECK, uid: "1000" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Config.User=node");
  });

  it("反例：Config.User 为空、root、0、0:0，容器 uid 为 0，没有 HEALTHCHECK 或是 NONE，都以非 0 退出", () => {
    const cases = [
      { user: "", healthcheck: HEALTHCHECK, uid: "1000", message: "非 root" },
      { user: "root", healthcheck: HEALTHCHECK, uid: "0", message: "非 root" },
      { user: "0", healthcheck: HEALTHCHECK, uid: "0", message: "非 root" },
      { user: "0:0", healthcheck: HEALTHCHECK, uid: "0", message: "非 root" },
      { user: "node", healthcheck: HEALTHCHECK, uid: "0", message: "以 root 运行" },
      { user: "node", healthcheck: "null", uid: "1000", message: "HEALTHCHECK" },
      { user: "node", healthcheck: '{"Test":["NONE"]}', uid: "1000", message: "HEALTHCHECK" },
    ];
    for (const stub of cases) {
      const result = assertImage(stub);
      expect(result.status, JSON.stringify(stub)).not.toBe(0);
      expect(result.stderr, JSON.stringify(stub)).toContain(stub.message);
    }
  });

  it("基础镜像按 digest 钉死：仓库里的 Dockerfile 通过；阶段名、--platform、经 ARG 默认值给出的镜像都能识别", () => {
    const real = runStep("断言基础镜像按 digest 钉死", {});
    expect(real.status, real.stderr).toBe(0);
    expect(real.stdout.match(/FROM 已钉死：/g)).toHaveLength(4);
    const ok = assertPinned([`ARG IMAGE="node:22-bookworm-slim@${PIN}"`, "FROM ${IMAGE} AS base", "from base as build", `FROM --platform=linux/amd64 node@${PIN}`, ""].join("\n"));
    expect(ok.status, ok.stderr).toBe(0);
  });

  it("反例：FROM 不带 digest、ARG 默认值不带 digest、digest 不是 64 位、引用没定义的阶段、没有 FROM，都以非 0 退出", () => {
    const cases = [
      "FROM node:22-bookworm-slim\n",
      "ARG NODE_IMAGE=node:22-bookworm-slim\nFROM ${NODE_IMAGE} AS base\n",
      "FROM ${UNSET_IMAGE}\n",
      "FROM node@sha256:0123abcd\n",
      "FROM base AS build\n",
      `FROM node@${PIN} AS base\nFROM node:22 AS runtime\n`,
      "# 没有 FROM\n",
    ];
    for (const dockerfile of cases) {
      const result = assertPinned(dockerfile);
      expect(result.status, dockerfile).not.toBe(0);
      expect(result.stderr, dockerfile).toMatch(/没有按 digest 钉死|里没有 FROM/);
    }
  });

  it("起一次容器：/readyz 200、退出码 0、日志里有 busy 为 0 的 checkpoint 完成行时通过", () => {
    const result = runContainer({ ready: true, exit: "0", logs: `{"msg":"control 已启动"}\n${CHECKPOINT_LINE}` });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("WAL 已 checkpoint，库已关闭");
  });

  it("反例：停机日志里没有 checkpoint 完成行、busy 不为 0、退出码不是 0、/readyz 一直不是 200，都以非 0 退出", () => {
    const cases = [
      { ready: true, exit: "0", logs: '{"msg":"control 已启动"}', message: "WAL 已 checkpoint，库已关闭" },
      { ready: true, exit: "0", logs: CHECKPOINT_LINE.replace('"busy":0', '"busy":1'), message: "WAL 已 checkpoint，库已关闭" },
      { ready: true, exit: "143", logs: CHECKPOINT_LINE, message: "退出码是 143" },
      { ready: false, exit: "0", logs: CHECKPOINT_LINE, message: "/readyz 没有返回 200" },
    ];
    for (const answer of cases) {
      const result = runContainer(answer);
      expect(result.status, JSON.stringify(answer)).not.toBe(0);
      expect(result.stderr, JSON.stringify(answer)).toContain(answer.message);
    }
  });

  it("verify 汇总 docker 的结果：写在 needs 里，并且 docker 不是 success 时汇总失败", () => {
    const verify = jobLines("verify").join("\n");
    expect(verify).toMatch(/needs: \[[^\]]*\bdocker\b[^\]]*\]/);
    expect(verify).toContain("DOCKER_RESULT: ${{ needs.docker.result }}");
    expect(verify).toContain('[ "$DOCKER_RESULT" != "success" ]');
  });
});
