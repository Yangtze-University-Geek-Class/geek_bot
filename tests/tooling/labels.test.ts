import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { labelCommands, main, parseArgs, parseLabels, readLabels, shellQuote } from "../../scripts/labels.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const script = join(root, "scripts", "labels.mjs");
const templateDir = join(root, ".github", "ISSUE_TEMPLATE");

type Label = { name: string; color: string; description: string };

/** issue 模板「端」下拉的取值，同时也是同名标签（docs/conventions/ISSUES.md §2） */
const SITES = ["control", "console", "node", "runner", "protocol", "deploy", "docs", "tooling"];
/** 本仓库必须声明的全部标签：优先级、类型、端、机器人 */
const EXPECTED_LABELS = ["P0", "P1", "P2", "bug", "enhancement", ...SITES, "bot:manual", "bot:blocked"];

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 在临时目录里放一份 .github/labels.yml，返回这个目录（给 --root 用） */
function fixtureRoot(labelsYml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "labels-"));
  tempDirs.push(dir);
  mkdirSync(join(dir, ".github"));
  writeFileSync(join(dir, ".github", "labels.yml"), labelsYml);
  return dir;
}

function runCli(args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });
}

/** 用 POSIX sh 真实解析一条命令，返回 gh 之后的参数，证明引号拼得对 */
function shellArgs(command: string): string[] {
  expect(command.startsWith("gh ")).toBe(true);
  const result = spawnSync("sh", ["-c", `printf '%s\\0' ${command.slice("gh ".length)}`], { encoding: "utf8" });
  expect(result.status).toBe(0);
  return result.stdout.split("\0").slice(0, -1);
}

/** issue 表单（不含选择器配置 config.yml） */
function issueForms(): { file: string; text: string }[] {
  return readdirSync(templateDir)
    .filter((file) => file.endsWith(".yml") && file !== "config.yml")
    .sort()
    .map((file) => ({ file, text: readFileSync(join(templateDir, file), "utf8") }));
}

/** 表单顶层 `labels: ["a", "b"]` 引用的标签 */
function formLabels(text: string): string[] {
  const match = /^labels:[ \t]*(\[.*\])[ \t]*$/m.exec(text);
  if (!match) return [];
  return JSON.parse(match[1]) as string[];
}

/** 表单里 `id: site`（「端」下拉）的选项 */
function siteOptions(text: string): string[] | null {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^\s+id: site\s*$/.test(line));
  if (start < 0) return null;
  const optionsAt = lines.findIndex((line, index) => index > start && /^\s+options:\s*$/.test(line));
  const options: string[] = [];
  for (const line of lines.slice(optionsAt + 1)) {
    const option = /^\s+- (\S+)\s*$/.exec(line);
    if (!option) break;
    options.push(option[1]);
  }
  return options;
}

describe("labels.yml 解析", () => {
  it("仓库里的 labels.yml 声明了全部必需标签，颜色与说明合规", () => {
    const labels: Label[] = readLabels(root);
    expect(labels.map((label) => label.name).sort()).toEqual([...EXPECTED_LABELS].sort());
    for (const label of labels) {
      expect(label.color).toMatch(/^[0-9a-f]{6}$/);
      expect(label.description.trim().length).toBeGreaterThan(0);
      expect([...label.description].length).toBeLessThanOrEqual(100);
    }
  });

  it("支持注释、行尾注释、转义与大写颜色", () => {
    const text = [
      "# 整行注释",
      "",
      '- name: "P0"  # 行尾注释',
      '  color: "B60205"',
      '  description: "带 \\"引号\\" 与 \\\\ 反斜杠"',
      "  # 标签内部的注释",
      '- description: "键的顺序不限"',
      '  name: "bot:manual"',
      '  color: "e4e669"',
      "",
    ].join("\n");
    expect(parseLabels(text)).toEqual([
      { name: "P0", color: "b60205", description: '带 "引号" 与 \\ 反斜杠' },
      { name: "bot:manual", color: "e4e669", description: "键的顺序不限" },
    ]);
  });

  it("不合规的写法逐条报错", () => {
    const ok = '  color: "ffffff"\n  description: "说明"\n';
    const cases: [string, RegExp][] = [
      [`- name: P0\n${ok}`, /双引号/],
      [`- name: "P0\n${ok}`, /右双引号/],
      [`- name: "P0" x\n${ok}`, /右引号之后/],
      [`- name: "P0"\n  colour: "ffffff"\n  description: "说明"\n`, /不认识的键/],
      [`- name: "P0"\n  color: "ffffff"\n`, /缺少 description/],
      [`- name: "P0"\n  color: "#ffffff"\n  description: "说明"\n`, /6 位十六进制/],
      [`- name: "P0"\n${ok}- name: "p0"\n${ok}`, /重复/],
      [`- name: "P0"\n  color: "ffffff"\n  description: "${"长".repeat(101)}"\n`, /100/],
      [`- name: "P0"\n    color: "ffffff"\n`, /缩进/],
      [`- name: "P0"\n\tcolor: "ffffff"\n`, /制表符/],
      [`- name: "P0"\n  name: "P1"\n`, /写了两次/],
      [`- name: " P0"\n${ok}`, /首尾空白/],
      [`name: "P0"\n`, /缩进/],
      [`- name: "P0"\n  description: "a \\n b"\n`, /转义/],
    ];
    for (const [text, error] of cases) expect(() => parseLabels(text), text).toThrow(error);
  });
});

describe("issue 模板与标签一致", () => {
  it("每个 issue 表单都声明了 labels，引用的标签都在 labels.yml 里", () => {
    const declared = new Set(readLabels(root).map((label: Label) => label.name));
    const forms = issueForms();
    expect(forms.map((form) => form.file)).toEqual(["bug.yml", "chore.yml", "feature.yml"]);
    for (const { file, text } of forms) {
      const used = formLabels(text);
      expect(used.length, `${file} 没有 labels`).toBeGreaterThan(0);
      for (const name of used) expect(declared.has(name), `${file} 引用了未声明的标签 ${name}`).toBe(true);
    }
  });

  it("「端」下拉的取值就是八个端，且都是已声明的标签", () => {
    const declared = new Set(readLabels(root).map((label: Label) => label.name));
    const withSite = issueForms().filter(({ text }) => siteOptions(text) !== null);
    expect(withSite.map((form) => form.file)).toEqual(["bug.yml", "feature.yml"]);
    for (const { file, text } of withSite) {
      expect(siteOptions(text), file).toEqual(SITES);
      for (const site of SITES) expect(declared.has(site), `标签 ${site} 未声明`).toBe(true);
    }
  });

  it("config.yml 只是选择器配置：关闭空白 issue，不含表单", () => {
    const config = readFileSync(join(templateDir, "config.yml"), "utf8");
    expect(config).toMatch(/^blank_issues_enabled: false$/m);
    expect(config).not.toMatch(/^(?:name|body|labels):/m);
  });
});

describe("issue 表单与 PR 模板的内容", () => {
  /** markdown 链接 `[文字](目标)` 里不是 http(s) 绝对地址的目标 */
  function relativeLinks(text: string): string[] {
    return [...text.matchAll(/\]\(([^)\s]*)\)/g)].map((match) => match[1]).filter((target) => !/^https?:\/\//.test(target));
  }

  it("不写相对链接：GitHub 不改写它，浏览器按新建 issue / PR 页面的地址解析，会指到仓库外面", () => {
    const templates = [
      ...issueForms(),
      { file: "pull_request_template.md", text: readFileSync(join(root, ".github", "pull_request_template.md"), "utf8") },
    ];
    for (const { file, text } of templates) expect(relativeLinks(text), file).toEqual([]);
    // 反例：写成相对链接就会被找出来
    expect(relativeLinks("按 [ISSUES](../../docs/conventions/ISSUES.md) §1")).toEqual(["../../docs/conventions/ISSUES.md"]);
    expect(relativeLinks("![](https://github.com/.../assets/...)")).toEqual([]);
  });

  it("每个表单都有可选的「实施」段，放在提交前确认之前（ISSUES §1、TRACKING §2）", () => {
    for (const { file, text } of issueForms()) {
      const lines = text.split("\n");
      const at = lines.findIndex((line) => /^\s+id: implementation\s*$/.test(line));
      expect(at, `${file} 没有 id: implementation`).toBeGreaterThan(0);
      expect(lines[at - 1], file).toMatch(/^\s+- type: textarea\s*$/);
      const next = lines.findIndex((line, index) => index > at && /^\s+- type: /.test(line));
      expect(next, `${file} 的「实施」段后面应当还有提交前确认`).toBeGreaterThan(at);
      const block = lines.slice(at, next).join("\n");
      expect(block, file).toMatch(/^\s+label: 实施\s*$/m);
      expect(block, file).toMatch(/^\s+required: false\s*$/m);
      expect(lines[next + 1], file).toMatch(/^\s+id: checklist\s*$/);
    }
  });
});

describe("ci.yml：PR 只能指向 stage（PULL-REQUESTS「目标分支」）", () => {
  const ci = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");

  /** 顶层 jobs 下某个 job 的全部行，到下一个同级键或同级注释为止 */
  function jobLines(job: string): string[] {
    const lines = ci.split("\n");
    const start = lines.indexOf(`  ${job}:`);
    expect(start, `ci.yml 里没有 job ${job}`).toBeGreaterThan(0);
    const end = lines.findIndex((line, index) => index > start && /^ {2}\S/.test(line));
    return lines.slice(start, end < 0 ? undefined : end);
  }

  /** job 里的步骤（`      - name: ...` 开头），每个带上自己的全部行 */
  function steps(lines: string[]): { name: string; lines: string[] }[] {
    const result: { name: string; lines: string[] }[] = [];
    for (const line of lines) {
      const step = /^ {6}- name: (.+)$/.exec(line);
      if (step) result.push({ name: step[1], lines: [line] });
      else result.at(-1)?.lines.push(line);
    }
    return result;
  }

  /** 步骤里 `run: |` 块的 shell 文本（去掉 10 格缩进） */
  function runBlock(lines: string[]): string {
    const at = lines.findIndex((line) => /^ {8}run: \|\s*$/.test(line));
    expect(at, "步骤没有 run: | 块").toBeGreaterThan(0);
    const body: string[] = [];
    for (const line of lines.slice(at + 1)) {
      if (line.trim() !== "" && !line.startsWith(" ".repeat(10))) break;
      body.push(line.slice(10));
    }
    return `${body.join("\n").trim()}\n`;
  }

  it("PR → main 仍触发 CI，branch-guard 第一步只在 PR 事件上核对 github.base_ref，排在不变量判定之前", () => {
    const guard = steps(jobLines("branch-guard"));
    const gate = guard[0];
    // 去掉 main 的话，误开的 PR → main 一个检查都没有，看起来和全绿一样能合并
    expect(ci).toMatch(/^ {2}pull_request:\n {4}branches: \[main, stage\]$/m);
    expect(gate.name).toContain("PR 目标分支");
    expect(gate.lines).toContain("        if: github.event_name == 'pull_request'");
    expect(gate.lines).toContain("          BASE_REF: ${{ github.base_ref }}");
    const invariants = guard.findIndex((step) => step.name === "判定分支不变量");
    expect(invariants).toBeGreaterThan(0);
    // verify 汇总 branch-guard，这一步失败会让唯一的汇总 check 变红
    expect(ci).toMatch(/^ {4}needs: \[branch-guard, core, lint-workflows\]$/m);
  });

  it("按 GitHub 的 bash 参数真实执行：stage 通过；main 与其它分支退出 1 并打出 ::error", () => {
    const script = runBlock(steps(jobLines("branch-guard"))[0].lines);
    const run = (base: string) =>
      spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
        encoding: "utf8",
        env: { ...process.env, BASE_REF: base },
      });
    const ok = run("stage");
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).not.toContain("::error");
    for (const base of ["main", "dev/alice", "task/12/review_queue", "stage2", ""]) {
      const result = run(base);
      expect(result.status, base).toBe(1);
      expect(result.stdout, base).toContain("::error title=PR 目标分支::PR 只能指向 stage");
    }
  });
});

describe("生成的 gh 命令", () => {
  it("每条命令是 gh label create <name> --color <c> --description <d> --force，sh 解析后参数原样", () => {
    const labels: Label[] = readLabels(root);
    const commands: string[] = labelCommands(labels);
    expect(commands).toHaveLength(labels.length);
    commands.forEach((command, index) => {
      const { name, color, description } = labels[index];
      expect(command).toMatch(/^gh label create \S+ --color [0-9a-f]{6} --description .+ --force$/);
      expect(shellArgs(command)).toEqual(["label", "create", name, "--color", color, "--description", description, "--force"]);
    });
  });

  it("--repo 原样透传到每条命令末尾；格式不对的仓库名被拒", () => {
    const commands: string[] = labelCommands(readLabels(root), { repo: "owner/repo" });
    for (const command of commands) expect(command.endsWith(" --force --repo owner/repo")).toBe(true);
    expect(() => labelCommands([], { repo: "owner" })).toThrow(/owner/);
    expect(() => labelCommands([], { repo: "owner/repo; rm -rf ~" })).toThrow();
  });

  it("引号能防住空格、单引号、$ 与反引号", () => {
    const tricky = { name: "needs review", color: "ffffff", description: "it's $HOME `id` \"x\"" };
    const [command] = labelCommands([tricky]);
    expect(shellArgs(command)).toEqual(["label", "create", tricky.name, "--color", "ffffff", "--description", tricky.description, "--force"]);
    expect(shellQuote("bot:manual")).toBe("bot:manual");
    expect(shellQuote("")).toBe("''");
  });
});

describe("命令行", () => {
  it("不带参数：每个标签打印一条命令，退出 0，只打印不执行", () => {
    const result = runCli([]);
    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines).toHaveLength(EXPECTED_LABELS.length);
    for (const line of lines) expect(line.startsWith("gh label create ")).toBe(true);
    expect(result.stderr).toContain("未执行");
  });

  it("--root 读取指定目录下的 labels.yml；文件不合规时退出 1", () => {
    const good = fixtureRoot('- name: "P0"\n  color: "b60205"\n  description: "阻断"\n');
    const result = runCli(["--root", good, "--repo", "owner/repo"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("gh label create P0 --color b60205 --description '阻断' --force --repo owner/repo");

    const bad = fixtureRoot('- name: "P0"\n  color: "red"\n  description: "阻断"\n');
    const failed = runCli(["--root", bad]);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("6 位十六进制");
  });

  it("不认识的参数、缺值的参数：打印用法并以非 0 退出", () => {
    for (const args of [["--bogus"], ["apply"], ["--repo"], ["--repo", "--force"], ["--repo", "no_slash"]]) {
      const result = runCli(args);
      expect(result.status, args.join(" ")).not.toBe(0);
      expect(result.stderr, args.join(" ")).toContain("用法");
      expect(result.stdout, args.join(" ")).toBe("");
    }
    expect(parseArgs(["--bogus"]).error).toContain("--bogus");
    expect(parseArgs(["--repo", "owner/repo"]).options?.repo).toBe("owner/repo");
  });

  it("--help 打印用法并退出 0", () => {
    const result = runCli(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("用法");
  });

  it("main 对不认识的参数返回非 0，不抛异常", () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...parts: unknown[]) => void errors.push(parts.join(" "));
    try {
      expect(main(["--nope"])).not.toBe(0);
    } finally {
      console.error = original;
    }
    expect(errors.join("\n")).toContain("用法");
  });
});
