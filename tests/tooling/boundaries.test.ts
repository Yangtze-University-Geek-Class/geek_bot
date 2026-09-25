import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkProject, specifiers, workspaceProblems } from "../../scripts/check-boundaries.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 每个包都有的两个脚本（与仓库一致）。 */
const SCRIPTS = { typecheck: "tsc -p tsconfig.json --noEmit", build: "tsc -p tsconfig.json" };
const manifest = (name: string, scripts: Record<string, string> = SCRIPTS) => JSON.stringify({ name, scripts });
/** 五个包逐行登记（与仓库的 pnpm-workspace.yaml 一致）。 */
const WORKSPACE = "packages:\n  - app/control\n  - app/console\n  - app/node\n  - app/runner\n  - packages/protocol\n";

/** 五个包的 package.json（包名与仓库一致）与工作区登记，不装依赖：包名导入按 package.json 登记的目录判定。 */
const MANIFESTS: Record<string, string> = {
  "pnpm-workspace.yaml": WORKSPACE,
  "app/control/package.json": manifest("@geek-bot/control"),
  "app/console/package.json": manifest("@geek-bot/console"),
  "app/node/package.json": manifest("@geek-bot/node"),
  "app/runner/package.json": manifest("@geek-bot/runner"),
  "packages/protocol/package.json": manifest("@geek-bot/protocol"),
  "packages/protocol/src/index.ts": "export type Channel = 'issue' | 'pr';\nexport const EXECUTORS = ['sandbox', 'vm'] as const;\n",
};

function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "geek-bot-boundary-"));
  roots.push(root);
  for (const [path, source] of Object.entries({ ...MANIFESTS, ...files })) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  return root;
}

const violations = (files: Record<string, string>) => checkProject(fixture(files)).violations as string[];

describe("AST 解析", () => {
  it("解析静态、动态、type 与 re-export 依赖，不匹配注释", () => {
    const result = specifiers(`// import './not-real';
import './static'; export { x } from './export'; const y = import('./dynamic'); type T = import('./type').T;`);
    expect(result.map((item: { spec: string }) => item.spec)).toEqual(["./static", "./export", "./dynamic", "./type"]);
  });

  it("只有整条 import type / export type 与 import() 类型位置算 type 导入", () => {
    const result = specifiers(`import type { A } from 'a'; import { type B } from 'b'; export type { C } from 'c'; type D = import('d').D; import e from 'e';`);
    expect(result.map((item: { spec: string; typeOnly: boolean }) => [item.spec, item.typeOnly])).toEqual([
      ["a", true],
      ["b", false],
      ["c", true],
      ["d", true],
      ["e", false],
    ]);
  });

  it("Vue 单文件组件只解析 <script> 块，行号与源文件一致", () => {
    const result = specifiers(`<template><div>import './not-a-module'</div></template>
<script setup lang="ts">
import A from './a.vue';
const b = import('./b');
</script>`, "x.vue");
    expect(result.map((item: { spec: string }) => item.spec)).toEqual(["./a.vue", "./b"]);
    expect(result[0].line).toBe(3);
  });
});

describe("五个包的边界", () => {
  it("仓库当前的五个包通过：各 app 导入 @geek-bot/protocol，runner 只 type 导入它", () => {
    expect(violations({
      "app/control/src/index.ts": `import type { Channel } from '@geek-bot/protocol'; import { EXECUTORS } from '@geek-bot/protocol'; import { readFileSync } from 'node:fs';`,
      "app/console/src/index.ts": `export type { Channel } from '@geek-bot/protocol';`,
      "app/node/src/index.ts": `import { EXECUTORS } from '../../../packages/protocol/src/index.js';`,
      "app/runner/src/index.ts": `import type { Channel } from '@geek-bot/protocol'; import { spawn } from 'node:child_process'; import path from 'path';`,
    })).toEqual([]);
  });

  it("app/control 导入 app/node：失败（相对路径、.js 指向 .ts、包名三种写法都算）", () => {
    const found = violations({
      "app/control/src/a.ts": `import { lease } from '../../node/src/lease.js';`,
      "app/control/src/b.ts": `export { lease } from '@geek-bot/node';`,
      "app/control/src/c.ts": `const mod = await import('../../node/src/lease');`,
      "app/node/src/lease.ts": `export const lease = 1;`,
    }).join("\n");
    expect(found).toContain("app/control/src/a.ts:1: 包之间不许互相导入实现（control -> node）");
    expect(found).toContain("app/control/src/b.ts:1: 包之间不许互相导入实现（control -> node）");
    expect(found).toContain("app/control/src/c.ts:1: 包之间不许互相导入实现（control -> node）");
  });

  it("console 与 control、node 与 control 互相导入：都失败", () => {
    const found = violations({
      "app/console/src/a.vue": `<template><div /></template>\n<script setup lang="ts">import { x } from '../../control/src/x';</script>`,
      "app/node/src/b.ts": `import '@geek-bot/control';`,
      "app/control/src/x.ts": `export const x = 1;`,
    }).join("\n");
    expect(found).toContain("app/console/src/a.vue:2: 包之间不许互相导入实现（console -> control）");
    expect(found).toContain("app/node/src/b.ts:1: 包之间不许互相导入实现（node -> control）");
  });

  it("protocol 导入任何 app：失败", () => {
    const found = violations({
      "packages/protocol/src/extra.ts": `import type { X } from '../../../app/control/src/x';`,
      "app/control/src/x.ts": `export type X = 1;`,
    });
    expect(found.join("\n")).toContain("packages/protocol/src/extra.ts:1: protocol 不能导入任何 app（protocol -> control）");
  });

  it("runner 导入 npm 包、或在运行时导入 protocol：失败", () => {
    const found = violations({
      "app/runner/src/a.ts": `import { z } from 'zod';`,
      "app/runner/src/b.ts": `import type { Options } from 'execa';`,
      "app/runner/src/c.ts": `import { EXECUTORS } from '@geek-bot/protocol';`,
      "app/runner/src/d.ts": `import { type Channel } from '@geek-bot/protocol';`,
    }).join("\n");
    expect(found).toContain("app/runner/src/a.ts:1: runner 只能用 Node 标准库，不能导入 npm 包 zod");
    expect(found).toContain("app/runner/src/b.ts:1: runner 只能用 Node 标准库，不能导入 npm 包 execa");
    expect(found).toContain("app/runner/src/c.ts:1: runner 只能 type 导入 @geek-bot/protocol");
    expect(found).toContain("app/runner/src/d.ts:1: runner 只能 type 导入 @geek-bot/protocol");
  });

  it("其它 app 可以导入 npm 包", () => {
    expect(violations({ "app/control/src/a.ts": `import Fastify from 'fastify';`, "app/console/src/b.ts": `import { ref } from 'vue';` })).toEqual([]);
  });

  it("解析不了的相对导入与 @geek-bot/ 作用域：失败关闭", () => {
    const found = violations({ "app/control/src/a.ts": `import './missing'; import '@geek-bot/unknown';` });
    expect(found).toHaveLength(2);
    expect(found[0]).toContain("本地导入解析不了 ./missing");
    expect(found[1]).toContain("本地导入解析不了 @geek-bot/unknown");
  });

  it("先按 tsconfig 别名解析，再按真实文件判定所属包", () => {
    const found = violations({
      "app/control/tsconfig.json": JSON.stringify({ compilerOptions: { moduleResolution: "Bundler", paths: { "@lease/*": ["../node/src/*"] } } }),
      "app/control/src/a.ts": `export { lease } from '@lease/lease';`,
      "app/node/src/lease.ts": `export const lease = 1;`,
    });
    expect(found.join("\n")).toContain("app/control/src/a.ts:1: 包之间不许互相导入实现（control -> node）");
  });

  it("已声明但解析不了的别名失败关闭，Node 内置模块不被误当成本地代码", () => {
    const found = violations({
      "app/control/tsconfig.json": JSON.stringify({ compilerOptions: { moduleResolution: "Bundler", paths: { "@domain/*": ["./src/lib/*"] } } }),
      "app/control/src/a.ts": `import fs from 'node:fs'; import os from 'os'; import { x } from '@domain/missing';`,
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("本地导入解析不了 @domain/missing");
  });

  it("非字面量的动态导入无法静态判定：失败", () => {
    const found = violations({ "app/node/src/a.ts": `const name = 'x'; await import(name);` });
    expect(found.join("\n")).toContain("非字面量的模块导入");
  });

  it(".d.ts 声明文件同样受边界约束：control 的 .d.ts 导入 node、runner 的 .d.ts 导入 npm 包，都失败", () => {
    const found = violations({
      "app/control/src/types.d.ts": `export type { Lease } from '../../node/src/lease';`,
      "app/control/src/use.ts": `import type { Lease } from './types';\nexport type Held = Lease;`,
      "app/control/src/extra.d.ts": `import type { Lease } from '@geek-bot/node';`,
      "app/node/src/lease.ts": `export type Lease = { id: string };`,
      "app/runner/src/x.d.ts": `import type { Options } from 'left-pad';`,
    }).join("\n");
    expect(found).toContain("app/control/src/types.d.ts:1: 包之间不许互相导入实现（control -> node）");
    expect(found).toContain("app/control/src/extra.d.ts:1: 包之间不许互相导入实现（control -> node）");
    expect(found).toContain("app/runner/src/x.d.ts:1: runner 只能用 Node 标准库，不能导入 npm 包 left-pad");
  });

  it(".d.ts 里只有三斜线指令与 declare module：不算导入，通过", () => {
    expect(violations({
      "app/console/src/env.d.ts": `/// <reference types="vite/client" />\ndeclare module '*.vue' { const component: unknown; export default component; }\n`,
    })).toEqual([]);
  });

  it("点开头目录里的文件被导入时照样扫描：经它转手 re-export 另一个包，失败", () => {
    const found = violations({
      "app/control/src/.gen/leak.ts": `export { lease } from '@geek-bot/node';`,
      "app/control/src/index.ts": `export * from './.gen/leak.js';`,
      "app/node/src/lease.ts": `export const lease = 1;`,
    }).join("\n");
    expect(found).toContain("app/control/src/.gen/leak.ts:1: 包之间不许互相导入实现（control -> node）");
  });

  it("app/ 下出现没登记边界的新包：失败", () => {
    const found = violations({ "app/foo/src/index.ts": `export const foo = 1;` });
    expect(found.join("\n")).toContain("app/foo：没有登记边界的新包");
  });
});

describe("工作区登记与包脚本", () => {
  it("仓库自己的 pnpm-workspace.yaml 与五个包的脚本：通过", () => {
    expect(workspaceProblems()).toEqual([]);
    expect(workspaceProblems(fixture({}))).toEqual([]);
  });

  it("包缺 typecheck 脚本（例如写成了 type-check）：失败，并说出缺哪个", () => {
    const found = violations({ "app/console/package.json": manifest("@geek-bot/console", { "type-check": "vue-tsc --noEmit", build: "vite build" }) });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("app/console/package.json：scripts 缺少 typecheck");
  });

  it("包缺 build 脚本、或脚本是空串：失败", () => {
    const found = violations({
      "app/runner/package.json": manifest("@geek-bot/runner", { typecheck: "tsc -p tsconfig.json --noEmit" }),
      "packages/protocol/package.json": manifest("@geek-bot/protocol", { typecheck: " ", build: "tsc -p tsconfig.json" }),
    }).join("\n");
    expect(found).toContain("app/runner/package.json：scripts 缺少 build");
    expect(found).toContain("packages/protocol/package.json：scripts 缺少 typecheck");
  });

  it("已登记边界的包没写进 pnpm-workspace.yaml：失败", () => {
    const found = violations({ "pnpm-workspace.yaml": WORKSPACE.replace("  - app/node\n", "") });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("app/node：没有写进 pnpm-workspace.yaml");
  });

  it("pnpm-workspace.yaml 缺失、用通配、或登记了没划定边界的目录：失败", () => {
    expect(violations({ "pnpm-workspace.yaml": "" }).join("\n")).toContain("没有 packages 列表");
    const glob = violations({ "pnpm-workspace.yaml": "packages:\n  - 'app/*'\n  - packages/protocol\n" }).join("\n");
    expect(glob).toContain("不支持通配或排除写法（app/*）");
    expect(glob).toContain("app/control：没有写进 pnpm-workspace.yaml");
    const extra = violations({ "pnpm-workspace.yaml": `${WORKSPACE}  - tools/gen\n` }).join("\n");
    expect(extra).toContain("pnpm-workspace.yaml 登记了 tools/gen，但 scripts/check-boundaries.mjs 的 PACKAGES 里没有它");
  });

  it("引号、注释与不缩进的列表项照样认", () => {
    const yaml = "# 工作区\npackages:\n- 'app/control' # 控制面\n- \"app/console\"\n- ./app/node/\n- app/runner\n- packages/protocol\n";
    expect(violations({ "pnpm-workspace.yaml": yaml })).toEqual([]);
  });
});
