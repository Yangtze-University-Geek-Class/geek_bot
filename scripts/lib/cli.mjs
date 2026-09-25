// 各门禁脚本共用的命令行工具：入口判定、参数解析、统一的出错与退出码。
//
// 入口判定必须比较 realpath：脚本经符号链接路径启动时（例如 macOS 上 /tmp 指向 /private/tmp），
// process.argv[1] 是链接路径，而 import.meta.url 是真实路径。直接比较两者会不相等，
// 脚本就会静默不执行却以 0 退出，门禁看起来「通过」了。所有 CLI 都用 isDirectRun 判断。
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * 当前模块是否是 `node <脚本>` 直接运行的那个文件。
 * @param {string} importMetaUrl 调用方的 import.meta.url
 * @param {string | undefined} [argv1] 默认取 process.argv[1]；测试可以注入
 */
export function isDirectRun(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return pathToFileURL(realpathSync(resolve(argv1))).href === importMetaUrl;
  } catch {
    return false;
  }
}

/** 参数错误：runCli 会把消息和用法一起打印到 stderr，并以 2 退出。 */
export class UsageError extends Error {}

/**
 * 解析 `--flag` 与 `--name <value>` 两种参数，其余当作位置参数。
 * 不认识的 `-` 开头参数、缺值的参数、重复的取值参数、超出上限的位置参数都抛 UsageError。
 * @param {string[]} argv
 * @param {{ flags?: string[], values?: string[], positionals?: number }} [spec]
 * @returns {{ flags: Set<string>, values: Record<string, string>, positionals: string[] }}
 */
export function parseFlags(argv, { flags = [], values = [], positionals = 0 } = {}) {
  const result = { flags: new Set(), values: {}, positionals: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg.startsWith("-") && arg !== "-") {
      if (flags.includes(arg)) {
        result.flags.add(arg);
        continue;
      }
      if (values.includes(arg)) {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("--")) throw new UsageError(`${arg} 需要取值`);
        if (Object.hasOwn(result.values, arg)) throw new UsageError(`${arg} 只能给一次`);
        result.values[arg] = value;
        index += 1;
        continue;
      }
      throw new UsageError(`未知参数：${arg}`);
    }
    result.positionals.push(arg);
  }
  if (result.positionals.length > positionals) {
    throw new UsageError(`多余的参数：${result.positionals.slice(positionals).join(" ")}`);
  }
  return result;
}

/**
 * 运行一个 CLI 的 main(argv)。UsageError → 消息与用法写 stderr、退出码 2；其它错误 → 消息写 stderr、退出码 1。
 * main 自己设置的 process.exitCode 保持不变。
 * @param {(argv: string[]) => unknown} main
 * @param {string} usage
 */
export function runCli(main, usage) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      console.error(usage);
      process.exitCode = 2;
      return;
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
