#!/usr/bin/env node
// 文档入口、服务契约、技能链接与相对链接的校验器。
//
//   node scripts/check-docs.mjs [--root <仓库根目录>]
//
// 仓库只有一个 agent 入口（AGENTS.md）和一份技能实现（.agents/skills/），
// 不校验 CLAUDE/GEMINI/CONVENTIONS/.cursorrules/.github/copilot-instructions 等适配器，
// 也不校验模块级 AGENTS.md 指针（这些文件一律不保留）。
//
// 规则：
//   1. AGENTS.md、README.md、docs/README.md 必须存在；
//   2. 每个 app/<name> 与 packages/<name> 目录都要有 docs/services/<name>/README.md（一个服务一份契约）；
//   3. .omp/skills/code-review 与 .claude/skills/code-review 必须是指向 .agents/skills/code-review 的符号链接；
//   4. docs/ 下与入口文件里的相对链接必须指向真实存在的文件；
//   5. docs/history/ 下的文档必须带 historical 状态。
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectRun, parseFlags, runCli } from "./lib/cli.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** 放服务源码的顶层目录：其下每个子目录都是一个服务，都要有 docs/services/<name>/README.md。 */
export const SERVICE_PARENTS = Object.freeze(["app", "packages"]);
const SKILL_DIR = ".agents/skills/code-review";
const SKILL_FILE = `${SKILL_DIR}/SKILL.md`;
const SKILL_LINKS = Object.freeze([".omp/skills/code-review", ".claude/skills/code-review"]);

const USAGE = "用法：node scripts/check-docs.mjs [--root <仓库根目录>]\n  校验入口文档、每个 app/<name> 与 packages/<name> 的服务契约、技能符号链接与相对链接。";

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", ".git", ".tools", "dist", "coverage", "test-results"].includes(entry.name)) return [];
    // task worktree 是另一份完整的检出，文档归它自己的分支检查
    if (entry.name === "worktrees" && dir.endsWith(".claude")) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : /\.(?:md|mdc)$/.test(entry.name) ? [path] : [];
  });
}

/** 列出 app/ 与 packages/ 下的服务目录名，形如 { parent: "app", name: "control" }。 */
export function serviceDirectories(root = ROOT) {
  return SERVICE_PARENTS.flatMap((parent) => {
    const dir = join(root, parent);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => ({ parent, name: entry.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });
}

/**
 * 纯检查：返回 { errors, documents }，不打印、不设退出码。
 * @param {string} [root]
 */
export function checkDocs(root = ROOT) {
  const errors = [];
  const required = ["AGENTS.md", "README.md", "docs/README.md"];

  if (!existsSync(join(root, "app"))) errors.push("缺少 app/ 目录");
  const services = serviceDirectories(root);
  if (!services.some((service) => service.parent === "app")) errors.push("app/ 下没有任何服务目录");
  for (const { parent, name } of services) {
    const contract = `docs/services/${name}/README.md`;
    if (!existsSync(join(root, contract))) errors.push(`${parent}/${name} 缺少服务契约 ${contract}`);
  }

  for (const file of required) if (!existsSync(join(root, file))) errors.push(`缺少 ${file}`);

  // 技能只有一个实现放在 .agents/skills/，各 CLI 目录只允许符号链接过去，禁止复制内容。
  if (!existsSync(join(root, SKILL_FILE))) errors.push(`缺少 ${SKILL_FILE}`);
  for (const link of SKILL_LINKS) {
    const path = join(root, link);
    let stat = null;
    try {
      stat = lstatSync(path);
    } catch {
      errors.push(`缺少技能链接 ${link}`);
      continue;
    }
    if (!stat.isSymbolicLink()) errors.push(`${link}：必须是指向 ${SKILL_DIR} 的符号链接，不能是复制品`);
    else if (!existsSync(path) || !existsSync(join(root, SKILL_DIR)) || realpathSync(path) !== realpathSync(join(root, SKILL_DIR))) {
      errors.push(`${link}：符号链接必须解析到 ${SKILL_DIR}`);
    }
  }

  // 入口文件同样参与相对链接校验；docs/ 下所有文档由 walk 收集。
  const pointers = ["AGENTS.md", "README.md", "README.en.md", SKILL_FILE];
  const documents = [...walk(join(root, "docs")), ...pointers.map((file) => join(root, file)).filter(existsSync)];
  for (const file of documents) {
    const original = readFileSync(file, "utf8");
    const text = original.replace(/```[^\n]*\n[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
    for (const match of text.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1].replace(/^<|>$/g, "").split("#")[0];
      if (!target || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue;
      let decoded;
      try {
        decoded = decodeURIComponent(target);
      } catch {
        errors.push(`${relative(root, file)}：链接不是合法的 URL ${target}`);
        continue;
      }
      if (!existsSync(resolve(dirname(file), decoded))) errors.push(`${relative(root, file)}：链接目标不存在 ${target}`);
    }
    if (relative(root, file).startsWith("docs/history/") && !original.includes("historical")) {
      errors.push(`${relative(root, file)}：docs/history 下的文档必须标 historical 状态`);
    }
  }

  return { errors, documents: documents.length };
}

function main(argv) {
  const { flags, values } = parseFlags(argv, { flags: ["--help", "-h"], values: ["--root"] });
  if (flags.has("--help") || flags.has("-h")) {
    console.log(USAGE);
    return;
  }
  const root = values["--root"] ? resolve(values["--root"]) : ROOT;
  const { errors, documents } = checkDocs(root);
  if (errors.length) {
    console.error(errors.join("\n"));
    console.error(`文档检查未通过（${errors.length} 项）。`);
    process.exitCode = 1;
    return;
  }
  console.log(`文档检查通过：${documents} 篇文档的相对链接、服务契约与技能链接都有效。`);
}

if (isDirectRun(import.meta.url)) runCli(main, USAGE);
