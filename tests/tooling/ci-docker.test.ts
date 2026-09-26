import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// ci.yml 的 docker job（#3）：断言 control 镜像非 root、带 HEALTHCHECK，并纳入 verify 的汇总。
// 断言脚本按 GitHub 的 bash 参数真实执行，docker 换成本测试的桩（按环境变量回答 inspect 与 id），不需要 Docker。
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
writeFileSync(
  join(stubDir, "docker"),
  [
    "#!/usr/bin/env bash",
    'if [ "$1 $2" = "image inspect" ]; then',
    '  case "$4" in *Config.User*) printf "%s\\n" "$STUB_USER" ;; *) printf "%s\\n" "$STUB_HEALTHCHECK" ;; esac',
    'elif [ "$1" = "run" ]; then',
    '  printf "%s\\n" "$STUB_UID"',
    "else",
    '  echo "unexpected docker call: $*" >&2; exit 99',
    "fi",
    "",
  ].join("\n"),
);
chmodSync(join(stubDir, "docker"), 0o755);

const HEALTHCHECK = '{"Test":["CMD","node","/app/app/control/dist/healthcheck.js"],"Interval":15000000000}';

function assertImage(stub: { user: string; healthcheck: string; uid: string }) {
  const script = stepScript("docker", "断言镜像以非 root 运行、带 HEALTHCHECK");
  return spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}`, STUB_USER: stub.user, STUB_HEALTHCHECK: stub.healthcheck, STUB_UID: stub.uid },
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

  it("verify 汇总 docker 的结果：写在 needs 里，并且 docker 不是 success 时汇总失败", () => {
    const verify = jobLines("verify").join("\n");
    expect(verify).toMatch(/needs: \[[^\]]*\bdocker\b[^\]]*\]/);
    expect(verify).toContain("DOCKER_RESULT: ${{ needs.docker.result }}");
    expect(verify).toContain('[ "$DOCKER_RESULT" != "success" ]');
  });
});
