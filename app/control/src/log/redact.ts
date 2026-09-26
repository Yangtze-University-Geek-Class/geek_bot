/**
 * 按密钥形态和已知密钥的原值打码（SECURITY S-16）。日志、审计、告警在写出之前都经过这里。
 *
 * 形态：GitHub 令牌（ghp_、gho_、ghu_、ghs_、ghr_、github_pat_）、节点令牌 gbn_、每任务模型令牌 gbt_、
 * OpenAI 兼容密钥 sk-、`Bearer <令牌>`、私钥块。另按已知密钥的原值打码（#3 起是 master key 与备份加密密钥的文件内容，
 * 以后的机器人令牌、网关密钥、节点令牌由对应模块在读到时登记）。
 * 对象按键名兜底：authorization、cookie、*_token、*_secret、*_password、*_key 这类键的值整体打码。
 */

export const REDACTED = "[REDACTED]";

interface SecretShape {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replacement: string;
}

/** 密钥形态。前面不许紧挨字母或数字，避免把普通单词的一部分当成前缀；下划线可以紧挨（`MY_ghp_…` 也要打码）。 */
export const SECRET_SHAPES: readonly SecretShape[] = Object.freeze([
  {
    name: "private_key",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    replacement: `[REDACTED:private_key]`,
  },
  // Bearer 排在各令牌形态之前：整段凭据一次替换，不会先被令牌形态切成两半。
  { name: "bearer", pattern: /(?<![A-Za-z0-9])(bearer)(\s+)[\w.~+/=-]+/gi, replacement: `$1$2${REDACTED}` },
  { name: "github_pat", pattern: /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{8,}/g, replacement: `github_pat_${REDACTED}` },
  { name: "github_token", pattern: /(?<![A-Za-z0-9])(gh[pousr])_[A-Za-z0-9]{8,}/g, replacement: `$1_${REDACTED}` },
  { name: "geek_bot_token", pattern: /(?<![A-Za-z0-9])(gb[nt])_[A-Za-z0-9_-]{8,}/g, replacement: `$1_${REDACTED}` },
  { name: "sk_key", pattern: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{8,}/g, replacement: `sk-${REDACTED}` },
]);

/** 值一律打码的键名：HTTP 认证头与 cookie，以及以 token、secret、password、key 结尾的字段。 */
const SENSITIVE_KEY_RE = /^(?:authorization|proxy-authorization|cookie|set-cookie)$|(?:^|[_-])(?:token|secret|password|passwd|api[_-]?key|private[_-]?key|master[_-]?key|backup[_-]?key)$/i;

/** 已知密钥原值的最短长度：更短的值打码会误伤普通文本，而且本来就不该是密钥。 */
const MIN_KNOWN_SECRET_LENGTH = 8;
const MAX_DEPTH = 8;

export interface Redactor {
  /** 把一段文本里的密钥形态和已知密钥替换掉。 */
  redactText(text: string): string;
  /** 深拷贝一个值并打码：字符串逐个替换，敏感键整体替换，Error 取类型、信息、代码和堆栈。 */
  redactValue(value: unknown): unknown;
  /** 登记一个已知密钥的原值（例如读到的密钥文件内容）；之后出现在任何文本里都会被替换。 */
  addKnownSecret(secret: string): void;
}

export function createRedactor(): Redactor {
  const known = new Set<string>();
  let ordered: string[] = [];

  function redactText(text: string): string {
    let result = text;
    for (const secret of ordered) if (result.includes(secret)) result = result.split(secret).join(REDACTED);
    for (const shape of SECRET_SHAPES) result = result.replace(shape.pattern, shape.replacement);
    return result;
  }

  function redactValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
    if (typeof value === "string") return redactText(value);
    if (value === null || typeof value !== "object") {
      if (typeof value === "bigint") return value.toString();
      if (typeof value === "function" || typeof value === "symbol") return undefined;
      return value;
    }
    if (seen.has(value)) return "[Circular]";
    if (depth >= MAX_DEPTH) return "[Truncated]";
    seen.add(value);
    if (value instanceof Error) {
      const error = value as Error & { code?: unknown; statusCode?: unknown };
      const out: Record<string, unknown> = { type: error.name, message: redactText(error.message) };
      if (typeof error.code === "string" || typeof error.code === "number") out.code = error.code;
      if (typeof error.statusCode === "number") out.status_code = error.statusCode;
      if (typeof error.stack === "string") out.stack = redactText(error.stack);
      if (error.cause !== undefined) out.cause = redactValue(error.cause, depth + 1, seen);
      return out;
    }
    if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return `[${value.byteLength} bytes]`;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
    if (Array.isArray(value)) return value.map(item => redactValue(item, depth + 1, seen));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY_RE.test(key) && item !== null && item !== undefined && item !== "" ? REDACTED : redactValue(item, depth + 1, seen);
    }
    return out;
  }

  return {
    redactText,
    redactValue: value => redactValue(value),
    addKnownSecret(secret: string) {
      for (const candidate of [secret, secret.trim()]) {
        if (candidate.length >= MIN_KNOWN_SECRET_LENGTH) known.add(candidate);
      }
      // 长的先替换，避免短的密钥是长密钥的一部分时只替换掉一半。
      ordered = [...known].sort((a, b) => b.length - a.length);
    },
  };
}
