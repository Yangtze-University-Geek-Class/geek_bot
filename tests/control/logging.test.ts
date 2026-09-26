import { describe, expect, it } from "vitest";
import { createLogger } from "../../app/control/src/log/logger.js";
import { createRedactor, REDACTED, SECRET_SHAPES } from "../../app/control/src/log/redact.js";
import { memorySink } from "./helpers.js";

// 令牌形态在运行时拼出来，测试文件里不留完整的令牌字面量（check-secrets 会扫描测试文件）。
const BODY = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const shaped = (prefix: string, length = 36) => `${prefix}${BODY.repeat(3).slice(0, length)}`;
const privateKeyBlock = () =>
  [["-----BEGIN", "OPENSSH PRIVATE KEY-----"].join(" "), "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ", ["-----END", "OPENSSH PRIVATE KEY-----"].join(" ")].join("\n");

/** S-16 列出的全部密钥形态，各一个样例。 */
function samples(): Record<string, string> {
  return {
    ghp: shaped("ghp_"),
    gho: shaped("gho_"),
    ghu: shaped("ghu_"),
    ghs: shaped("ghs_"),
    ghr: shaped("ghr_"),
    github_pat: shaped("github_pat_", 82),
    gbn: shaped("gbn_", 43),
    gbt: shaped("gbt_", 43),
    sk: shaped("sk-", 48),
    bearer: `Bearer ${shaped("", 40)}`,
    private_key: privateKeyBlock(),
  };
}

describe("打码（S-16）", () => {
  it("密钥形态逐一被替换：ghp_、gho_、ghu_、ghs_、ghr_、github_pat_、gbn_、gbt_、sk-、Bearer、私钥块", () => {
    const redactor = createRedactor();
    for (const [name, secret] of Object.entries(samples())) {
      const text = `before ${secret} after`;
      const out = redactor.redactText(text);
      expect(out, name).toContain("[REDACTED");
      expect(out, name).not.toContain(name === "bearer" ? secret.slice("Bearer ".length) : secret);
      expect(out, name).toMatch(/^before .* after$/);
    }
    expect(SECRET_SHAPES.map(shape => shape.name)).toEqual(["private_key", "bearer", "github_pat", "github_token", "geek_bot_token", "sk_key"]);
  });

  it("前缀紧挨下划线也打码，紧挨字母或数字的普通单词不误伤", () => {
    const redactor = createRedactor();
    expect(redactor.redactText(`MY_${shaped("ghp_")}`)).toBe(`MY_ghp_${REDACTED}`);
    expect(redactor.redactText("task-sample-12345678")).toBe("task-sample-12345678");
    expect(redactor.redactText("disk-usage-report-2026")).toBe("disk-usage-report-2026");
    expect(redactor.redactText("缺少 Bearer 令牌")).toBe("缺少 Bearer 令牌");
    expect(redactor.redactText("ghp_short")).toBe("ghp_short");
  });

  it("已知密钥的原值（例如密钥文件内容）在任何位置都被替换；短于 8 个字符的不登记", () => {
    const redactor = createRedactor();
    const secret = "q7Zr9wLm2Kx8Vt4Ns6Pb1Hc3Jd5Fg0Aa=";
    redactor.addKnownSecret(`${secret}\n`);
    redactor.addKnownSecret("short");
    expect(redactor.redactText(`key=${secret};`)).toBe(`key=${REDACTED};`);
    expect(redactor.redactText("short text")).toBe("short text");
  });

  it("对象按键名兜底：authorization、cookie、*_token、*_key 的值整体打码；深层嵌套、数组、Error 都处理，循环引用不死循环", () => {
    const redactor = createRedactor();
    const nested: Record<string, unknown> = {
      headers: { authorization: "token abcdef", cookie: "gb_session=xyz", accept: "application/json" },
      node_token: "plain-looking-value",
      backup_key_id: "0123456789abcdef",
      token_status: "valid",
      list: [shaped("gho_"), { inner: `x ${shaped("sk-", 40)}` }],
      err: new Error(`request failed: ${shaped("github_pat_", 60)}`),
    };
    nested.self = nested;
    const out = redactor.redactValue(nested) as Record<string, any>;
    expect(out.headers).toEqual({ authorization: REDACTED, cookie: REDACTED, accept: "application/json" });
    expect(out.node_token).toBe(REDACTED);
    expect(out.backup_key_id).toBe("0123456789abcdef");
    expect(out.token_status).toBe("valid");
    expect(out.list[0]).toBe(`gho_${REDACTED}`);
    expect(out.list[1].inner).toBe(`x sk-${REDACTED}`);
    expect(out.err.message).toBe(`request failed: github_pat_${REDACTED}`);
    expect(out.err.stack).not.toContain(shaped("github_pat_", 60));
    expect(out.self).toBe("[Circular]");
  });
});

describe("结构化日志", () => {
  it("每条一行 JSON：time、level、msg、上下文字段；整条打码，密钥形态出现在 msg、字段、错误里都被替换", () => {
    const sink = memorySink();
    const logger = createLogger({ level: "info", redactor: createRedactor(), sink, clock: () => Date.UTC(2026, 8, 26, 3, 0, 0) });
    const all = samples();
    logger.info({ secrets: all, err: new Error(`boom ${all.ghp}`) }, `登录失败，令牌 ${all.gho}，头 ${all.bearer}`);
    const raw = sink.text();
    for (const [name, secret] of Object.entries(all)) {
      expect(raw, name).not.toContain(name === "bearer" ? secret.slice("Bearer ".length) : secret);
    }
    const [line] = sink.lines();
    expect(line).toMatchObject({ time: "2026-09-26T03:00:00.000Z", level: "info" });
    expect(line?.msg).toBe(`登录失败，令牌 gho_${REDACTED}，头 Bearer ${REDACTED}`);
    expect((line?.err as { message: string }).message).toBe(`boom ghp_${REDACTED}`);
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.trim().split("\n")).toHaveLength(1);
  });

  it("反例：不经打码直接序列化会带出令牌（证明上一条的断言不是空转）", () => {
    const token = shaped("ghp_");
    expect(JSON.stringify({ msg: `令牌 ${token}` })).toContain(token);
    expect(createRedactor().redactText(`令牌 ${token}`)).not.toContain(token);
  });

  it("级别过滤；child 继承字段并使用传入的序列化函数；printf 风格的参数照常格式化", () => {
    const sink = memorySink();
    const logger = createLogger({ level: "warn", redactor: createRedactor(), sink, clock: () => 0 });
    logger.info("不会出现");
    logger.debug({ a: 1 }, "也不会出现");
    const child = logger.child({ reqId: "r-1" }, { serializers: { req: (value: unknown) => ({ method: (value as { method: string }).method }) } });
    child.warn({ req: { method: "GET", headers: { authorization: "x" } } }, "请求 %s 用了 %d 毫秒", "/readyz", 3);
    child.error(new Error("出错了"));
    const lines = sink.lines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ level: "warn", reqId: "r-1", req: { method: "GET" }, msg: "请求 /readyz 用了 3 毫秒" });
    expect(lines[1]).toMatchObject({ level: "error", reqId: "r-1", msg: "出错了", err: { type: "Error", message: "出错了" } });
    expect(child.level).toBe("warn");
  });
});
