/**
 * 事件离开节点之前的打码（docs/services/node/protocol.md「事件打码」）：密钥形态正则加上本节点令牌与本任务模型令牌的原值。
 * control 收到后会按自己的规则再扫一遍，这里不假设下游会兜底。
 */
const PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgb[nt]_[A-Za-z0-9_-]{16,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];

export const REDACTED = "[已打码]";

/** 打码函数：secrets 返回当前要按原值替换的密钥（节点令牌、任务模型令牌）。 */
export function createRedactor(secrets: () => Iterable<string>): (text: string) => string {
  return text => {
    let out = text;
    for (const secret of secrets()) if (secret.length >= 8) out = out.split(secret).join(REDACTED);
    for (const pattern of PATTERNS) out = out.replace(pattern, match => (/^(Bearer|Basic)\s/i.test(match) ? `${match.split(/\s+/)[0]} ${REDACTED}` : REDACTED));
    return out;
  };
}
