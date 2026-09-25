#!/usr/bin/env node
/**
 * 模块边界门禁（docs/conventions/MODULAR-DEVELOPMENT.md「允许的依赖方向」）。
 *
 *   node scripts/check-boundaries.mjs [--root <仓库根目录>]
 *
 * 规则：
 *   1. 五个包互不导入实现：app/control、app/console、app/node、app/runner 任何一个都不得导入另一个的文件
 *      （包名导入、相对路径、tsconfig 别名都算）；
 *   2. 每个 app 都可以导入 @geek-bot/protocol（或指向 packages/protocol 的相对路径）；
 *   3. packages/protocol 不导入任何 app；
 *   4. app/runner/src 只用 Node 标准库：不许导入任何 npm 包，唯一例外是对 @geek-bot/protocol 的 type 导入；
 *   5. app/ 与 packages/ 下出现没登记的目录时失败：新增包要先在 PACKAGES 里划定边界。
 *
 * 用 TypeScript AST 解析静态 import、动态 import、re-export、import-type 与 require；Vue 单文件组件只解析 <script>；
 * 按各包 tsconfig 解析 .js → .ts 与路径别名，按解析后的真实文件路径判断所属包，不以导入名称判断。
 * 本地导入（相对路径、已声明别名、@geek-bot/ 作用域）解析不了就失败，不忽略；非字面量的动态导入也失败。
 *
 * 扫描范围：各包目录下全部源文件（含 .d.ts 声明文件：type 导入同样受规则 1–4 约束），跳过 node_modules、dist、
 * coverage 与点开头的目录（构建缓存）。被扫描文件导入到的包内文件不论在哪个目录（包括点开头的目录）都会接着扫描，
 * 经转手 re-export 绕不过边界。
 */
import ts from "typescript";
import { builtinModules } from "node:module";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectRun, parseFlags, runCli } from "./lib/cli.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** 工作区包：目录 → 边界名。新增包必须在这里登记，否则 rule 5 失败。 */
export const PACKAGES = Object.freeze({
  "app/control": "control",
  "app/console": "console",
  "app/node": "node",
  "app/runner": "runner",
  "packages/protocol": "protocol",
});
/** 放包的顶层目录。 */
const PACKAGE_PARENTS = Object.freeze(["app", "packages"]);
/** 所有包共享的契约包：任何 app 都可以导入它。 */
const SHARED = "protocol";
/** 工作区包名的作用域：这个作用域下的导入一律按本地代码对待，解析不了就失败。 */
const SCOPE = "@geek-bot/";
const BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

const USAGE = [
  "用法：node scripts/check-boundaries.mjs [--root <仓库根目录>]",
  "  五个包互不导入实现；都可以导入 @geek-bot/protocol；protocol 不导入任何 app；runner 只用 Node 标准库。",
].join("\n");

const toPosix = (path) => path.split(sep).join("/");

/** 不当作源码扫描的目录：依赖、构建产物与覆盖率报告。 */
const SKIPPED_DIRS = Object.freeze(["node_modules", "dist", "coverage"]);
/** 源文件：TS/JS（含 .d.ts 声明文件）与 Vue 单文件组件。 */
const SOURCE_FILE_RE = /\.(?:[cm]?tsx?|[cm]?js|vue)$/;

export function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".") || SKIPPED_DIRS.includes(entry.name)) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : SOURCE_FILE_RE.test(entry.name) ? [path] : [];
  });
}

/** Vue 单文件组件只解析 <script> 块；非脚本部分替换成等长空白，行号保持与源文件一致。 */
export function scriptSource(source, filename) {
  if (!filename.endsWith(".vue")) return source;
  let out = source.replace(/[^\n]/g, " ");
  for (const match of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    const start = match.index + match[0].indexOf(">") + 1;
    out = out.slice(0, start) + match[1] + out.slice(start + match[1].length);
  }
  return out;
}

/**
 * 列出一个源文件的全部模块依赖：{ spec, line, typeOnly }。spec 为 null 表示非字面量的动态导入。
 * typeOnly 只在整条声明是 `import type` / `export type` 或 `import("x").T` 类型位置时为 true
 * （verbatimModuleSyntax 下 `import { type A }` 仍保留运行时导入，不算 type 导入）。
 */
export function specifiers(source, filename = "source.ts") {
  const ast = ts.createSourceFile(filename.replace(/\.vue$/, ".vue.ts"), scriptSource(source, filename), ts.ScriptTarget.Latest, true);
  const result = [];
  const add = (node, typeOnly = false) => {
    if (!node) return;
    const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
    result.push({ spec: ts.isStringLiteralLike(node) ? node.text : null, line, typeOnly });
  };
  function visit(node) {
    // TypeScript 5.9 起 `import type` 记在 ImportClause.phaseModifier（isTypeOnly 已弃用）；`import defer` 不是 type 导入。
    if (ts.isImportDeclaration(node)) add(node.moduleSpecifier, node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword);
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) add(node.moduleSpecifier, node.isTypeOnly);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression, node.isTypeOnly);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal, true);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      add(node.arguments[0] ?? node);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return result;
}

/**
 * 路径属于哪个包：{ dir: "app/control", name: "control" }；不在任何包里返回 null。
 * @param {string} path 绝对路径
 */
export function packageOf(path, root = ROOT) {
  const name = toPosix(relative(root, path));
  for (const [dir, pkg] of Object.entries(PACKAGES)) if (name === dir || name.startsWith(`${dir}/`)) return { dir, name: pkg };
  return null;
}

/** app/ 与 packages/ 下没有在 PACKAGES 里登记的目录。 */
export function unregisteredPackages(root = ROOT) {
  return PACKAGE_PARENTS.flatMap((parent) => {
    const dir = join(root, parent);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => `${parent}/${entry.name}`)
      .filter((path) => !Object.hasOwn(PACKAGES, path));
  });
}

/** 各包 package.json 里的包名 → 包目录（不依赖 node_modules，未安装依赖时也能判定包名导入）。 */
export function workspaceNames(root = ROOT) {
  const names = new Map();
  for (const dir of Object.keys(PACKAGES)) {
    const manifest = join(root, dir, "package.json");
    if (!existsSync(manifest)) continue;
    const name = JSON.parse(readFileSync(manifest, "utf8")).name;
    if (typeof name === "string") names.set(name, dir);
  }
  return names;
}

function compilerOptions(file, root) {
  const pkg = packageOf(file, root);
  const configPath = pkg ? join(root, pkg.dir, "tsconfig.json") : null;
  if (!configPath || !existsSync(configPath)) return { moduleResolution: ts.ModuleResolutionKind.Bundler };
  const source = ts.readConfigFile(configPath, ts.sys.readFile);
  if (source.error) throw new Error(`读不了模块配置：${relative(root, configPath)}`);
  const parsed = ts.parseJsonConfigFileContent(source.config, ts.sys, dirname(configPath));
  // 合成的测试工作区里没有输入文件（18003）不算配置错误。
  if (parsed.errors.some((error) => error.code !== 18003)) throw new Error(`模块配置不合法：${relative(root, configPath)}`);
  return parsed.options;
}

function isAliasSpecifier(spec, options) {
  return Object.keys(options.paths ?? {}).some((pattern) => {
    const star = pattern.indexOf("*");
    return star === -1 ? spec === pattern : spec.startsWith(pattern.slice(0, star)) && spec.endsWith(pattern.slice(star + 1));
  });
}

/** 本地代码的导入：相对/绝对路径、tsconfig 别名、@geek-bot/ 作用域。解析不了就失败。 */
export function isLocalSpecifier(spec, options = {}) {
  return spec.startsWith(".") || spec.startsWith("/") || spec.startsWith(SCOPE) || isAliasSpecifier(spec, options);
}

/** npm 包名（去掉子路径）：@scope/name/x → @scope/name，name/x → name。 */
function bareName(spec) {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/**
 * 把导入解析成真实文件路径；解析不了返回 null。
 * 先按 tsconfig 解析；@geek-bot/<包> 在没装依赖时退回到 package.json 登记的包目录。
 */
export function resolveSpec(file, spec, root = ROOT, options = compilerOptions(file, root), names = workspaceNames(root)) {
  const resolved = ts.resolveModuleName(spec, file, options, ts.sys).resolvedModule?.resolvedFileName;
  if (resolved) return realpathSync(resolve(resolved));
  if (spec.startsWith(SCOPE)) {
    const dir = names.get(bareName(spec));
    return dir ? join(root, dir) : null;
  }
  const base = spec.startsWith(".") ? resolve(dirname(file), spec) : null;
  if (!base) return null;
  const clean = base.split("?")[0];
  const candidates = [clean, clean.replace(/\.js$/, ".ts"), clean.replace(/\.js$/, ".tsx"), `${clean}.ts`, `${clean}.tsx`, join(clean, "index.ts"), join(clean, "index.tsx")];
  const found = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
  return found ? realpathSync(found) : null;
}

/**
 * 检查一个仓库根目录（纯读取，不打印）。返回 { files, imports, violations }。
 * @param {string} [root]
 */
export function checkProject(root = ROOT) {
  root = realpathSync(root);
  const violations = unregisteredPackages(root).map(
    (dir) => `${dir}：没有登记边界的新包，先在 scripts/check-boundaries.mjs 的 PACKAGES 里登记，并补 docs/services/<name>/README.md`,
  );
  const names = workspaceNames(root);
  // 待扫描队列：先是各包目录下的源文件，扫描中再追加被导入、但 walk 没收进来的包内文件（例如点开头目录里的转手 re-export）。
  const files = Object.keys(PACKAGES).flatMap((dir) => walk(join(root, dir)));
  const queued = new Set(files);
  const follow = (target) => {
    if (queued.has(target) || !SOURCE_FILE_RE.test(target) || !statSync(target).isFile()) return;
    if (toPosix(relative(root, target)).split("/").some((part) => SKIPPED_DIRS.includes(part))) return;
    queued.add(target);
    files.push(target);
  };
  let imports = 0;
  for (const file of files) {
    const from = packageOf(file, root);
    if (!from) continue;
    const runnerProgram = from.name === "runner" && toPosix(relative(root, file)).startsWith("app/runner/src/");
    const options = compilerOptions(file, root);
    for (const item of specifiers(readFileSync(file, "utf8"), file)) {
      imports++;
      const at = `${toPosix(relative(root, file))}:${item.line}`;
      if (item.spec === null) {
        violations.push(`${at}: 非字面量的模块导入无法静态判定边界，改成字面量路径或静态映射表`);
        continue;
      }
      if (item.spec.startsWith("node:") || BUILTINS.has(item.spec)) continue; // Node 标准库
      const local = isLocalSpecifier(item.spec, options);
      const target = resolveSpec(file, item.spec, root, options, names);
      if (!target) {
        if (local) violations.push(`${at}: 本地导入解析不了 ${item.spec}`);
        else if (runnerProgram) violations.push(`${at}: runner 只能用 Node 标准库，不能导入 npm 包 ${bareName(item.spec)}`);
        continue;
      }
      const targetName = toPosix(relative(root, target));
      if (targetName.startsWith("..")) {
        if (local) violations.push(`${at}: 本地导入跑到了仓库外 ${item.spec}`);
        else if (runnerProgram) violations.push(`${at}: runner 只能用 Node 标准库，不能导入 npm 包 ${bareName(item.spec)}`);
        continue;
      }
      if (targetName.split("/").includes("node_modules")) {
        if (runnerProgram) violations.push(`${at}: runner 只能用 Node 标准库，不能导入 npm 包 ${bareName(item.spec)}`);
        continue;
      }
      const to = packageOf(target, root);
      if (!to) {
        if (local) violations.push(`${at}: 导入了工作区包以外的仓库文件 ${targetName}`);
        continue;
      }
      follow(target);
      if (from.name === to.name) continue;
      if (from.name === SHARED) {
        violations.push(`${at}: protocol 不能导入任何 app（protocol -> ${to.name}）`);
        continue;
      }
      if (to.name !== SHARED) {
        violations.push(`${at}: 包之间不许互相导入实现（${from.name} -> ${to.name}），跨包只经 @geek-bot/protocol`);
        continue;
      }
      if (runnerProgram && !item.typeOnly) {
        violations.push(`${at}: runner 只能 type 导入 @geek-bot/protocol（写成 import type），运行时只用 Node 标准库`);
      }
    }
  }
  return { files: files.length, imports, violations };
}

function main(argv) {
  const { flags, values } = parseFlags(argv, { flags: ["--help", "-h"], values: ["--root"] });
  if (flags.has("--help") || flags.has("-h")) {
    console.log(USAGE);
    return;
  }
  const report = checkProject(values["--root"] ? resolve(values["--root"]) : ROOT);
  if (report.violations.length) {
    console.error(report.violations.join("\n"));
    console.error(`模块边界检查未通过（${report.violations.length} 项）。`);
    process.exitCode = 1;
    return;
  }
  console.log(`模块边界检查通过：${report.files} 个文件，${report.imports} 处导入（静态、动态、re-export、import-type、require）。`);
}

// 入口判定走 isDirectRun（比较 realpath）：经符号链接路径启动时不会静默退出 0 而让门禁假绿。
if (isDirectRun(import.meta.url)) runCli(main, USAGE);
