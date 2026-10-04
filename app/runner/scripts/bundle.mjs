#!/usr/bin/env node
/**
 * 把 tsc 编译出的 runner 模块（dist/*.js）合成单文件 dist/runner.mjs（不引入打包依赖，只用根工作区已有的 typescript 解析）。
 *
 *   node app/runner/scripts/bundle.mjs [--dist <dir>] [--entry main.js] [--out runner.mjs]
 *
 * 做法：从入口出发收集相对导入的模块图，按依赖先后把每个模块包进一个立即执行函数，模块的导出变成返回的冻结对象；
 * node: 内置模块的导入提到文件顶部（每个内置模块一个命名空间导入），模块内再解构。
 * 只接受 runner 自己用到的写法，其余一律报错退出（不静默放过）：
 *   - 相对导入与 node: 内置模块之外的导入（runner 不许依赖 npm 包）；
 *   - 默认导出、默认导入相对模块、副作用导入、动态 import()、import.meta 以外的元属性；
 *   - 模块之间的循环依赖。
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILTINS = new Set(builtinModules);

function fail(message) {
  process.stderr.write(`bundle：${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { dist: resolve(HERE, "..", "dist"), entry: "main.js", out: "runner.mjs" };
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (value === undefined) fail(`参数缺值：${flag}`);
    if (flag === "--dist") options.dist = resolve(value);
    else if (flag === "--entry") options.entry = value;
    else if (flag === "--out") options.out = value;
    else fail(`不认识的参数：${flag}`);
  }
  return options;
}

function builtinName(specifier) {
  const name = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  return BUILTINS.has(name) || BUILTINS.has(name.split("/")[0]) ? name : null;
}

function hasModifier(node, kind) {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some(modifier => modifier.kind === kind);
}

function declaredNames(statement) {
  if (ts.isVariableStatement(statement)) {
    const names = [];
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) fail("导出的变量不能用解构写法");
      names.push(declaration.name.text);
    }
    return names;
  }
  if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) return [statement.name.text];
  fail(`不支持的导出语句：${ts.SyntaxKind[statement.kind]}`);
  return [];
}

/** 解析一个模块：返回依赖、内置模块导入、改写后的正文与导出表。 */
function analyze(file, text, builtinAliases) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const dependencies = [];
  const exports = new Map();
  const replacements = [];
  const visitForbidden = node => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) fail(`${file} 里有动态 import()`);
    ts.forEachChild(node, visitForbidden);
  };
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const specifier = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (!clause) fail(`${file} 有副作用导入 ${specifier}`);
      const builtin = builtinName(specifier);
      let target;
      if (builtin) {
        if (!builtinAliases.has(builtin)) builtinAliases.set(builtin, `__node_${builtin.replace(/[^A-Za-z0-9]/g, "_")}`);
        target = builtinAliases.get(builtin);
      } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
        const resolved = resolve(dirname(file), specifier);
        if (!existsSync(resolved)) fail(`${file} 导入的 ${specifier} 不存在`);
        dependencies.push(resolved);
        target = { module: resolved };
      } else {
        fail(`${file} 导入了 npm 包 ${specifier}；runner 只能用 Node 标准库`);
      }
      const lines = [];
      const ref = typeof target === "string" ? target : null;
      const moduleRef = ref ?? `__MODULE__${dependencies.length - 1}__`;
      if (clause.name) {
        if (!ref) fail(`${file} 默认导入了本地模块 ${specifier}`);
        lines.push(`const ${clause.name.text} = ${ref}.default ?? ${ref};`);
      }
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) lines.push(`const ${bindings.name.text} = ${moduleRef};`);
      if (bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0) {
        const parts = bindings.elements.map(element => (element.propertyName ? `${element.propertyName.text}: ${element.name.text}` : element.name.text));
        lines.push(`const { ${parts.join(", ")} } = ${moduleRef};`);
      }
      replacements.push({ start: statement.getStart(source), end: statement.getEnd(), text: lines.join("\n") });
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) fail(`${file} 有 export * 写法`);
      if (statement.moduleSpecifier) {
        const specifier = statement.moduleSpecifier.text;
        if (!specifier.startsWith("./")) fail(`${file} 从 ${specifier} 转导出`);
        const resolved = resolve(dirname(file), specifier);
        dependencies.push(resolved);
        const moduleRef = `__MODULE__${dependencies.length - 1}__`;
        for (const element of statement.exportClause.elements) exports.set(element.name.text, `${moduleRef}.${(element.propertyName ?? element.name).text}`);
      } else {
        for (const element of statement.exportClause.elements) exports.set(element.name.text, (element.propertyName ?? element.name).text);
      }
      replacements.push({ start: statement.getStart(source), end: statement.getEnd(), text: "" });
      continue;
    }
    if (ts.isExportAssignment(statement) || hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) fail(`${file} 有默认导出`);
    if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      for (const name of declaredNames(statement)) exports.set(name, name);
      const modifier = ts.getModifiers(statement).find(item => item.kind === ts.SyntaxKind.ExportKeyword);
      replacements.push({ start: modifier.getStart(source), end: modifier.getEnd(), text: "" });
    }
    visitForbidden(statement);
  }
  let body = text;
  for (const item of replacements.sort((a, b) => b.start - a.start)) body = body.slice(0, item.start) + item.text + body.slice(item.end);
  return { dependencies, exports, body };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const entry = join(options.dist, options.entry);
  if (!existsSync(entry)) fail(`找不到入口 ${entry}（先运行 tsc）`);
  const builtinAliases = new Map();
  const modules = new Map();
  const order = [];
  const visiting = new Set();
  const visit = file => {
    if (modules.has(file)) return;
    if (visiting.has(file)) fail(`模块循环依赖：${relative(options.dist, file)}`);
    visiting.add(file);
    const analyzed = analyze(file, readFileSync(file, "utf8").replace(/^\/\/# sourceMappingURL=.*$/m, ""), builtinAliases);
    for (const dependency of analyzed.dependencies) visit(dependency);
    visiting.delete(file);
    modules.set(file, { ...analyzed, id: `__mod_${order.length}` });
    order.push(file);
  };
  visit(entry);

  const chunks = [
    "#!/usr/bin/env node",
    "// geek_bot runner：由 app/runner/scripts/bundle.mjs 从 tsc 输出生成的单文件程序，只依赖 Node 标准库。不要手工修改。",
  ];
  for (const [name, alias] of [...builtinAliases].sort()) chunks.push(`import * as ${alias} from "node:${name}";`);
  for (const file of order) {
    const module = modules.get(file);
    let body = module.body;
    module.dependencies.forEach((dependency, index) => {
      body = body.replaceAll(`__MODULE__${index}__`, modules.get(dependency).id);
    });
    const exported = [...module.exports].map(([name, local]) => {
      const value = local.replace(/^__MODULE__(\d+)__/, (_, index) => modules.get(module.dependencies[Number(index)]).id);
      return `  ${JSON.stringify(name)}: ${value},`;
    });
    chunks.push(
      `// ---- ${relative(options.dist, file)} ----`,
      `const ${module.id} = (() => {`,
      body.trim(),
      `return Object.freeze({\n${exported.join("\n")}\n});`,
      "})();",
    );
  }
  const out = join(options.dist, options.out);
  writeFileSync(out, `${chunks.join("\n")}\n`);
  chmodSync(out, 0o755);
  process.stdout.write(`bundle：${relative(process.cwd(), out)}（${order.length} 个模块）\n`);
}

main();
