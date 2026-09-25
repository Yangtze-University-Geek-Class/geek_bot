// 密钥门禁（scripts/check-secrets.mjs）的反例与正例。
//
// 形似真实密钥的字面量一律在运行时拼出来：本文件自己也在被扫描的范围里，
// 直接写出来会让仓库的 pnpm check:secrets 命中本测试。
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SECRET_KEY_RE, TEMPLATE_ENV_RE, auditRepository, contentKind, fileViolation, listFiles, parseAssignments, scanText, templateViolation } from "../../scripts/check-secrets.mjs";

const script = fileURLToPath(new URL("../../scripts/check-secrets.mjs", import.meta.url));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** OpenAI 兼容形态的假密钥：sk- 加 24 位字母数字。 */
const fakeModelKey = () => ["sk", "Ab1".repeat(8)].join("-");
/** GitHub 令牌形态的假值。 */
const fakeGithubToken = () => ["ghp", "A1".repeat(18)].join("_");

/** 私钥材料开头一行的假值：在运行时拼出。 */
const fakePrivateKeyHeader = () => `-----BEGIN OPENSSH ${"PRIVATE KEY-----"}`;
/** SQLite 3 文件头加几字节假数据。 */
const sqliteBytes = () => Buffer.concat([Buffer.from("SQLite format 3\0", "latin1"), Buffer.from([0x10, 0x00, 0x01, 0x01])]);

/** 在临时目录建一个 Git 仓库（不提交），按路径写入文件。 */
function repo(files: Record<string, string | Buffer>) {
  const root = mkdtempSync(join(tmpdir(), "geek-bot-secrets-"));
  roots.push(root);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const findings = (file: string, text: string) => (scanText(file, text) as string[]).join("\n");

describe("env 模板：密钥项只能留空或写 *_FILE 路径", () => {
  it("只有根 .env.example 与 deploy/env/.env.<环境> 算模板", () => {
    for (const file of [".env.example", "deploy/env/.env.preview", "deploy/env/.env.production", "deploy/env/.env.node"]) {
      expect(TEMPLATE_ENV_RE.test(file), file).toBe(true);
    }
    for (const file of ["app/control/.env.example", ".env", ".env.local", "deploy/.env.preview", "deploy/env/.env.preview.local"]) {
      expect(TEMPLATE_ENV_RE.test(file), file).toBe(false);
    }
  });

  it("密钥名覆盖 API_KEY、SETUP_KEY、JOIN_KEY 等；CLIENT_ID、MAX_TOKENS 这类不是密钥", () => {
    for (const key of ["MODEL_GATEWAY_API_KEY", "NODE_SETUP_KEY", "NODE_JOIN_KEY", "GEEK_BOT_MASTER_KEY", "SESSION_SECRET", "GITHUB_TOKEN", "DB_PASSWORD", "TOKEN_ENCRYPTION_KEY", "DEPLOY_SSH_KEY", "APP_PRIVATE_KEY", "MODEL_GATEWAY_API_KEY_FILE"]) {
      expect(SECRET_KEY_RE.test(key), key).toBe(true);
    }
    for (const key of ["GITHUB_OAUTH_CLIENT_ID", "MODEL_MAX_TOKENS", "GEEK_BOT_PUBLIC_ORIGIN", "MODEL_GATEWAY_BASE_URL", "KEYBOARD_LAYOUT"]) {
      expect(SECRET_KEY_RE.test(key), key).toBe(false);
    }
  });

  it("模板里 MODEL_GATEWAY_API_KEY 有值：失败，且不回显值", () => {
    const value = fakeModelKey();
    for (const file of [".env.example", "deploy/env/.env.production"]) {
      const text = findings(file, `MODEL_GATEWAY_BASE_URL=https://gateway.example.com/v1\nMODEL_GATEWAY_API_KEY=${value}\n`);
      expect(text).toContain(`${file}:2: MODEL_GATEWAY_API_KEY 在模板 env 里必须留空`);
      expect(text).not.toContain(value);
    }
    // 不像密钥的普通值同样失败：模板里密钥项一律不许有值
    expect(findings(".env.example", "MODEL_GATEWAY_API_KEY=placeholder")).toContain("MODEL_GATEWAY_API_KEY");
    expect(findings(".env.example", 'export MODEL_GATEWAY_API_KEY="placeholder"')).toContain("MODEL_GATEWAY_API_KEY");
  });

  it("SETUP_KEY、JOIN_KEY、MASTER_KEY 有值：失败", () => {
    const text = findings("deploy/env/.env.preview", "NODE_SETUP_KEY=abc\nNODE_JOIN_KEY='abc'\nGEEK_BOT_MASTER_KEY=abc\n");
    expect(text).toContain(":1: NODE_SETUP_KEY");
    expect(text).toContain(":2: NODE_JOIN_KEY");
    expect(text).toContain(":3: GEEK_BOT_MASTER_KEY");
  });

  it("*_FILE 只能是文件路径；留空、占位默认值与行尾注释都通过", () => {
    expect(findings(".env.example", [
      "# 模板注释 MODEL_GATEWAY_API_KEY=不算赋值",
      "GEEK_BOT_PUBLIC_ORIGIN=http://localhost:8080",
      "GITHUB_OAUTH_CLIENT_ID=",
      "MODEL_GATEWAY_API_KEY=",
      "MODEL_GATEWAY_API_KEY_FILE=/run/secrets/model_gateway_api_key",
      "GEEK_BOT_MASTER_KEY_FILE=./secrets/master.key",
      "NODE_JOIN_KEY= # 由 control 签发",
      'SESSION_SECRET=""',
    ].join("\n"))).toBe("");
    expect(findings(".env.example", "MODEL_GATEWAY_API_KEY_FILE=not a path")).toContain("值只能是文件路径");
    expect(findings(".env.example", `MODEL_GATEWAY_API_KEY_FILE=${fakeModelKey()}`)).toContain("值只能是文件路径");
    // 紧贴等号的 # 是值，不是注释
    expect(findings(".env.example", "SESSION_SECRET=#abc")).toContain("SESSION_SECRET");
  });

  it("非模板文件里的 KEY=VALUE 不按模板规则判（例如测试里的反例文本）", () => {
    expect(findings("tests/tooling/example.test.ts", "MODEL_GATEWAY_API_KEY=placeholder")).toBe("");
    expect(templateViolation({ key: "GITHUB_OAUTH_CLIENT_ID", value: "Iv1.0000" })).toBeNull();
  });

  it("解析 export、引号与行尾注释", () => {
    expect(parseAssignments('export A=1\nB="x # y"\nC=z # note\n# D=1\nE=')).toEqual([
      { line: 1, key: "A", value: "1" },
      { line: 2, key: "B", value: "x # y" },
      { line: 3, key: "C", value: "z" },
      { line: 5, key: "E", value: "" },
    ]);
  });
});

describe("任何文本里的密钥形态", () => {
  it("OpenAI 兼容密钥（sk- 开头的长串）：失败，不回显", () => {
    const key = fakeModelKey();
    const text = findings("app/control/src/relay.ts", `const key = "${key}";`);
    expect(text).toContain("app/control/src/relay.ts:1: OpenAI-compatible API key");
    expect(text).not.toContain(key);
  });

  it("sk- 形态的误报排除：前面紧挨字母、太短、没有数字的 kebab 名字都不算", () => {
    expect(findings("docs/x.md", "risk-assessment-for-long-queue-items-2026")).toBe("");
    expect(findings("docs/x.md", "sk-short1")).toBe("");
    expect(findings("docs/x.md", "sk-review-queue-dedupe-by-head-sha")).toBe("");
  });

  it("GitHub 令牌、私钥材料、sshpass 内联口令：失败", () => {
    expect(findings("scripts/x.mjs", `const token = "${fakeGithubToken()}";`)).toContain("GitHub token");
    expect(findings("deploy/x.conf", `-----BEGIN OPENSSH ${"PRIVATE KEY-----"}`)).toContain("private key material");
    expect(findings("deploy/x.sh", `sshpass -p ${"'x'"} ssh host`)).toContain("inline SSH password");
  });
});

describe("入库文件", () => {
  it("私有 env 与数据库文件：失败；两类模板允许", () => {
    for (const file of [".env", ".env.local", "deploy/env/.env.preview.local", "app/control/.env", "app/control/.env.example", ".env.staging"]) {
      expect(fileViolation(file), file).not.toBeNull();
    }
    for (const file of ["data/geek-bot.db", "x.db-wal", "x.db-shm", "x.db-journal", "x.sqlite3", "data/geek-bot.db.bak", "geek-bot.db.1", "x.sqlite-wal", "x.sqlite3-shm", "X.DB"]) {
      expect(fileViolation(file), file).toContain("数据库文件");
    }
    for (const file of [".env.example", "deploy/env/.env.preview", "deploy/env/.env.production", "app/control/src/config.ts", "app/control/src/db.ts", "app/control/src/repo.db.ts", "docs/schema.dbml"]) {
      expect(fileViolation(file), file).toBeNull();
    }
  });

  it("私钥与密钥库文件：按文件名直接失败，不看内容；公钥不算", () => {
    for (const file of ["keys/deploy.pem", "keys/id_ed25519", "id_rsa", "deploy/tls/server.key", "certs/client.p12", "certs/client.pfx", "x.ppk", "android.jks", "release.keystore"]) {
      expect(fileViolation(file), file).toContain("私钥");
    }
    for (const file of ["keys/id_ed25519.pub", "docs/keyboard.md", "app/control/src/key.ts", "app/control/src/keys.ts"]) {
      expect(fileViolation(file), file).toBeNull();
    }
  });

  it("内容判定：SQLite 文件头是数据库，前 8 KB 有 NUL 是二进制，其它都是文本", () => {
    expect(contentKind(sqliteBytes())).toBe("database");
    expect(contentKind(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]))).toBe("binary");
    expect(contentKind(Buffer.from("FROM node:22\n"))).toBe("text");
  });

  it("不论扩展名：没有扩展名的钩子、Dockerfile、.npmrc、.py 里的密钥形态都被扫描到", () => {
    const root = repo({
      ".githooks/pre-push": `#!/bin/sh\nexport GH_TOKEN=${fakeGithubToken()}\n`,
      Dockerfile: `FROM node:22\nENV MODEL_KEY=${fakeModelKey()}\n`,
      ".npmrc": `//npm.pkg.github.com/:_authToken=${fakeGithubToken()}\n`,
      "tools/app.py": `KEY = "${fakeModelKey()}"\n`,
      "notes/deploy-key": `${fakePrivateKeyHeader()}\n`,
    });
    const text = auditRepository({ repoRoot: root }).findings.join("\n");
    expect(text).toContain(".githooks/pre-push:2: GitHub token");
    expect(text).toContain("Dockerfile:2: OpenAI-compatible API key");
    expect(text).toContain(".npmrc:1: GitHub token");
    expect(text).toContain("tools/app.py:1: OpenAI-compatible API key");
    expect(text).toContain("notes/deploy-key:1: private key material");
  });

  it("私钥文件、改了名的库文件、附属与备份库文件：失败；符号链接只按文件名判定", () => {
    const root = repo({
      ".gitignore": "",
      "keys/deploy.pem": `${fakePrivateKeyHeader()}\n`,
      "keys/id_ed25519": `${fakePrivateKeyHeader()}\n`,
      "backup/state.bin": sqliteBytes(),
      "data/geek-bot.db.bak": sqliteBytes(),
      "x.sqlite-wal": Buffer.from([0x37, 0x7f, 0x06, 0x82, 0x00]),
      "docs/ok.md": "nothing here\n",
    });
    symlinkSync("../docs/ok.md", join(root, "keys", "server.key"));
    const report = auditRepository({ repoRoot: root });
    expect(report.ok).toBe(false);
    const text = report.findings.join("\n");
    expect(text).toContain("keys/deploy.pem: 私钥或密钥库文件禁止入库");
    expect(text).toContain("keys/id_ed25519: 私钥或密钥库文件禁止入库");
    expect(text).toContain("keys/server.key: 私钥或密钥库文件禁止入库");
    expect(text).toContain("backup/state.bin: 数据库文件禁止入库（SQLite 文件头）");
    expect(text).toContain("data/geek-bot.db.bak: 数据库文件禁止入库");
    expect(text).toContain("x.sqlite-wal: 数据库文件禁止入库");
    expect(text).not.toContain("docs/ok.md");
  });

  it("仓库夹具：未忽略的 .env.local、数据库文件、模板里有值的 API 密钥都被拦下", () => {
    const root = repo({
      ".env.local": "SESSION_SECRET=local-only\n",
      "data.db": "",
      ".env.example": "MODEL_GATEWAY_API_KEY=placeholder\n",
      "deploy/env/.env.preview": "NODE_JOIN_KEY=placeholder\n",
      "app/control/src/relay.ts": `export const key = "${fakeModelKey()}";\n`,
    });
    const report = auditRepository({ repoRoot: root });
    expect(report.ok).toBe(false);
    const text = report.findings.join("\n");
    expect(text).toContain(".env.local: 私有 env 文件禁止入库");
    expect(text).toContain("data.db: 数据库文件禁止入库");
    expect(text).toContain(".env.example:1: MODEL_GATEWAY_API_KEY");
    expect(text).toContain("deploy/env/.env.preview:1: NODE_JOIN_KEY");
    expect(text).toContain("app/control/src/relay.ts:1: OpenAI-compatible API key");
  });

  it("被 .gitignore 忽略的本机文件不扫描；干净的夹具通过", () => {
    const root = repo({
      ".gitignore": ".env\n.env.*\n!.env.example\n",
      ".env": `MODEL_GATEWAY_API_KEY=${fakeModelKey()}\n`,
      ".env.local": "SESSION_SECRET=local-only\n",
      ".env.example": "MODEL_GATEWAY_API_KEY=\nMODEL_GATEWAY_API_KEY_FILE=/run/secrets/model_gateway_api_key\n",
    });
    const report = auditRepository({ repoRoot: root });
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("仓库的 .gitignore 只忽略确切的库文件名：名字里带 .db 的源码与文档不被静默忽略，没列到的库文件名由本门禁报出", () => {
    const gitignore = readFileSync(new URL("../../.gitignore", import.meta.url), "utf8");
    const ignored = ["data.db", "data.db-wal", "data.db-shm", "data.db-journal", "data.db.bak", "data.db.1", "x.sqlite", "x.sqlite3", "x.sqlite-wal", "x.sqlite3-shm", "x.sqlite.bak"];
    const kept = ["app/control/src/repo.db.ts", "docs/schema.dbml", "docs/db.md"];
    const root = repo({ ".gitignore": gitignore, "app.db.orig": "", ...Object.fromEntries([...ignored, ...kept].map((file) => [file, ""])) });
    const listed = listFiles(root) as string[];
    for (const file of ignored) expect(listed, file).not.toContain(file);
    for (const file of [...kept, "app.db.orig"]) expect(listed, file).toContain(file);
    const report = auditRepository({ repoRoot: root });
    expect(report.findings).toEqual(["app.db.orig: 数据库文件禁止入库"]);
  });

  it("命令行 --root：违规以 1 退出且不回显值；不认识的参数打印用法并以非 0 退出", () => {
    const key = fakeModelKey();
    const root = repo({ ".env.example": `MODEL_GATEWAY_API_KEY=${key}\n` });
    const failed = spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("MODEL_GATEWAY_API_KEY");
    expect(`${failed.stdout}${failed.stderr}`).not.toContain(key);
    const unknown = spawnSync(process.execPath, [script, "--no-such-flag"], { encoding: "utf8" });
    expect(unknown.status).not.toBe(0);
    expect(unknown.stderr).toContain("用法：node scripts/check-secrets.mjs");
  });

  it("本仓库当前的文件通过", () => {
    const report = auditRepository();
    expect(report.findings).toEqual([]);
    expect(report.checked).toBeGreaterThan(50);
  });
});
