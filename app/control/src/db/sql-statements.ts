/**
 * 迁移文件的词法检查：找出顶层的事务控制语句（BEGIN、COMMIT、END、ROLLBACK、SAVEPOINT、RELEASE）。
 *
 * 迁移器给每个文件开事务并在执行前后核对结构，文件自己提交或回滚事务会让这些保证失效，所以加载时就拒绝。
 * 只看每条语句的第一个词：注释、字符串、带引号的标识符都跳过；CREATE TRIGGER 的 BEGIN … END 语句体整体属于那一条语句，
 * 语句体里的 RAISE(ROLLBACK, …)、CASE … END 不算。这是加载时的第一道防线；执行时迁移器另用保存点核对文件没有结束事务。
 */

const CONTROL_KEYWORDS = new Set(["BEGIN", "COMMIT", "END", "ROLLBACK", "SAVEPOINT", "RELEASE"]);

interface Token {
  /** 词（转成大写）、单个标点，或者字符串与带引号标识符的占位。 */
  readonly text: string;
  readonly line: number;
}

const QUOTED = "\u0000quoted";
const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-￿]/;

function* tokens(sql: string): Generator<Token> {
  let at = 0;
  let line = 1;
  const skipTo = (end: number) => {
    for (let i = at; i < end && i < sql.length; i += 1) if (sql[i] === "\n") line += 1;
    at = Math.min(end, sql.length);
  };
  while (at < sql.length) {
    const char = sql[at] as string;
    if (/\s/.test(char)) {
      skipTo(at + 1);
    } else if (sql.startsWith("--", at)) {
      const end = sql.indexOf("\n", at);
      skipTo(end < 0 ? sql.length : end);
    } else if (sql.startsWith("/*", at)) {
      const end = sql.indexOf("*/", at + 2);
      skipTo(end < 0 ? sql.length : end + 2);
    } else if (char === "'" || char === '"' || char === "`" || char === "[") {
      // 字符串与带引号的标识符：引号成对出现表示转义（[] 没有转义）。
      const close = char === "[" ? "]" : char;
      const start = line;
      let end = at + 1;
      for (;;) {
        const next = sql.indexOf(close, end);
        if (next < 0) {
          end = sql.length;
          break;
        }
        if (close !== "]" && sql[next + 1] === close) {
          end = next + 2;
          continue;
        }
        end = next + 1;
        break;
      }
      skipTo(end);
      yield { text: QUOTED, line: start };
    } else if (WORD_START.test(char)) {
      let end = at + 1;
      while (end < sql.length && WORD_PART.test(sql[end] as string)) end += 1;
      const text = sql.slice(at, end).toUpperCase();
      const start = line;
      skipTo(end);
      yield { text, line: start };
    } else {
      const start = line;
      skipTo(at + 1);
      yield { text: char, line: start };
    }
  }
}

export interface ControlStatement {
  readonly keyword: string;
  readonly line: number;
}

/** 顶层的事务控制语句，按出现的顺序；没有时返回空数组。 */
export function transactionControlStatements(sql: string): ControlStatement[] {
  const found: ControlStatement[] = [];
  let first: string[] = [];
  let atStart = true;
  // 0：普通语句；1：CREATE TRIGGER 的头部（还没到 BEGIN）；2：触发器语句体里。
  let trigger: 0 | 1 | 2 = 0;
  let bodyStatementStart = false;
  for (const token of tokens(sql)) {
    if (trigger === 2) {
      // 语句体里只找「某条语句开头的 END」，它结束语句体；CASE … END 的 END 不会出现在语句开头。
      if (token.text === ";") bodyStatementStart = true;
      else if (bodyStatementStart && token.text === "END") trigger = 0;
      else bodyStatementStart = false;
      continue;
    }
    if (token.text === ";") {
      atStart = true;
      first = [];
      trigger = 0;
      continue;
    }
    if (atStart) {
      atStart = false;
      if (CONTROL_KEYWORDS.has(token.text)) found.push({ keyword: token.text, line: token.line });
    }
    if (first.length < 3) {
      // 语句的前几个词是 CREATE [TEMP|TEMPORARY] TRIGGER 时进入触发器头部。
      first.push(token.text);
      if (first[0] === "CREATE" && token.text === "TRIGGER" && (first.length === 2 || first[1] === "TEMP" || first[1] === "TEMPORARY")) trigger = 1;
    } else if (trigger === 1 && token.text === "BEGIN") {
      trigger = 2;
      bodyStatementStart = true;
    }
  }
  return found;
}
