// scripts/note.mjs：执行记录的写入、索引与核对（docs/conventions/NOTES.md，#26）。
// 全部在临时目录（需要 Git 的用临时仓库）里跑，不读本仓库的 notes/，不连网络。
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  PENDING_DIR,
  addNote,
  beijingNow,
  branchSlug,
  chainMerged,
  checkAll,
  checkChainFile,
  checkChainOrder,
  checkPullRequest,
  collectChains,
  flushPending,
  mergeEntries,
  parseIssues,
  record,
  renderIndex,
  renderSummary,
} from "../../scripts/note.mjs";

const script = fileURLToPath(new URL("../../scripts/note.mjs", import.meta.url));
const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "geek-bot-notes-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const by = "agent-claude-geek-bot-01（Claude Code，example-model）";
const base = { user: "alice", by, chain: "task/12/review_queue", issues: ["12"], did: "做了一件事", result: "有结果" };
const at = (iso: string) => new Date(iso);
const writeIndex = (root: string) => writeFileSync(join(root, "notes", "INDEX.md"), renderIndex(root));
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const cli = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, GEEK_NOTES_USER: "", GEEK_NOTES_BY: "" } });

/** 临时 Git 仓库：stage 上一个基线提交，另有 origin/stage 远端跟踪 ref 指向它，当前在 task/12/review_queue。 */
function repo() {
  const root = temp();
  git(root, "init", "-q", "-b", "stage");
  git(root, "config", "user.email", "ci@example.test");
  git(root, "config", "user.name", "CI");
  writeFileSync(join(root, "README.md"), "x\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "base");
  git(root, "update-ref", "refs/remotes/origin/stage", "HEAD");
  git(root, "checkout", "-q", "-b", "task/12/review_queue");
  return root;
}
const commitAll = (root: string, message = "notes") => {
  writeIndex(root);
  git(root, "add", ".");
  git(root, "commit", "-qm", message);
};

describe("北京时间与文件位置", () => {
  it("按 Asia/Shanghai 取日期和时刻，跨过 UTC 零点也对", () => {
    expect(beijingNow(at("2026-09-25T16:11:22Z"))).toEqual({ date: "2026-09-26", time: "00:11:22" });
    expect(beijingNow(at("2026-09-25T15:59:59Z"))).toEqual({ date: "2026-09-25", time: "23:59:59" });
  });

  it("分支名变成链路文件名；--issue 接受空格、逗号和 # 前缀", () => {
    expect(branchSlug("task/12/review_queue")).toBe("task_12_review_queue");
    expect(branchSlug("dev/alice")).toBe("dev_alice");
    expect(parseIssues("12 #7,008")).toEqual(["12", "7", "8"]);
    expect(parseIssues(undefined)).toEqual([]);
    expect(parseIssues("abc")).toEqual(["abc"]);
  });
});

describe("addNote", () => {
  it("按 日期/GitHub 用户名/分支 建文件，第一次写标题和负责人，之后往后追加", () => {
    const root = temp();
    const file = addNote(root, { ...base, stage: "开工", title: "建分支", now: at("2026-09-25T16:11:22Z") });
    expect(file).toBe(join(root, "notes/2026-09-26/alice/task_12_review_queue.md"));
    addNote(root, { ...base, stage: "提交", issues: ["12", "8"], title: "提交 abc", next: "开 PR", now: at("2026-09-25T16:20:00Z") });
    expect(readFileSync(file, "utf8")).toBe(
      [
        "# task/12/review_queue · alice · 2026-09-26",
        "",
        "负责人：alice",
        "",
        "## 00:11:22 +08:00 · 开工 · #12 · 建分支",
        "",
        `- 执行者：${by}`,
        "- 做了什么：做了一件事",
        "- 结果：有结果",
        "",
        "## 00:20:00 +08:00 · 提交 · #12 #8 · 提交 abc",
        "",
        `- 执行者：${by}`,
        "- 做了什么：做了一件事",
        "- 结果：有结果",
        "- 下一步：开 PR",
        "",
      ].join("\n"),
    );
    writeIndex(root);
    expect(checkAll(root)).toEqual([]);
  });

  it("缺身份、阶段不对、issue 不是数字、必填为空时拒绝写入，一个文件也不建", () => {
    const root = temp();
    expect(() => addNote(root, { ...base, user: "Alice Smith", stage: "开工", title: "x" })).toThrow(/GEEK_NOTES_USER/);
    expect(() => addNote(root, { ...base, user: undefined, stage: "开工", title: "x" })).toThrow(/GEEK_NOTES_USER/);
    expect(() => addNote(root, { ...base, by: "Claude", stage: "开工", title: "x" })).toThrow(/GEEK_NOTES_BY/);
    expect(() => addNote(root, { ...base, stage: "开发中", title: "x" })).toThrow(/--stage/);
    expect(() => addNote(root, { ...base, issues: ["abc"], stage: "开工", title: "x" })).toThrow(/--issue/);
    expect(() => addNote(root, { ...base, stage: "开工", title: "x", did: " " })).toThrow(/--did/);
    expect(existsSync(join(root, "notes"))).toBe(false);
  });

  it("过了北京时间零点写进新的日期目录，同一条链路跨两个文件", () => {
    const root = temp();
    addNote(root, { ...base, stage: "开工", title: "a", now: at("2026-09-25T15:50:00Z") });
    addNote(root, { ...base, stage: "提交", title: "b", now: at("2026-09-25T16:10:00Z") });
    const chain = collectChains(root).get("alice/task_12_review_queue");
    expect(chain.files.map((file: { date: string }) => file.date)).toEqual(["2026-09-25", "2026-09-26"]);
    expect(checkChainOrder(chain)).toEqual([]);
  });
});

describe("核对", () => {
  const rel = "notes/2026-09-26/alice/task_12_review_queue.md";
  const good = `# task/12/review_queue · alice · 2026-09-26\n\n负责人：alice\n\n## 09:00:00 +08:00 · 开工 · #12 · 建分支\n\n- 执行者：${by}\n- 做了什么：x\n- 结果：y\n`;

  it("格式对的文件没有问题；human- 执行者也认", () => {
    expect(checkChainFile(rel, good)).toEqual([]);
    expect(checkChainFile(rel, good.replace(by, "human-alice"))).toEqual([]);
  });

  it("位置、标题、负责人、执行者写错都报出来", () => {
    expect(checkChainFile("notes/2026-09-26/task_12.md", good)[0]).toMatch(/只能放在/);
    expect(checkChainFile("notes/2026-02-30/alice/task_12_review_queue.md", good).join()).toMatch(/不是有效日期/);
    expect(checkChainFile("notes/2026-09-26/Alice/task_12_review_queue.md", good).join()).toMatch(/GitHub 用户名/);
    expect(checkChainFile(rel, good.replace("task/12/review_queue ·", "task/8/poll_etag ·")).join()).toMatch(/分支/);
    expect(checkChainFile(rel, good.replace("负责人：alice\n", "")).join()).toMatch(/负责人/);
    expect(checkChainFile(rel, good.replace(by, "Claude")).join()).toMatch(/执行者要写成/);
  });

  it("记录标题不是北京时间或阶段不认识、缺字段、时间倒退都报出来", () => {
    expect(checkChainFile(rel, good.replace("09:00:00 +08:00", "09:00 UTC")).join()).toMatch(/HH:MM:SS \+08:00/);
    expect(checkChainFile(rel, good.replace("· 开工 ·", "· 写代码 ·")).join()).toMatch(/阶段是/);
    expect(checkChainFile(rel, good.replace("- 结果：y\n", "")).join()).toMatch(/缺少「- 结果：」/);
    expect(checkChainFile(rel, good.replace("- 结果：y", "- 结果：")).join()).toMatch(/不能是空的/);
    expect(checkChainFile(rel, good.replace("09:00:00", "24:00:00")).join()).toMatch(/不存在/);
    expect(checkChainFile(rel, `${good}\n## 08:00:00 +08:00 · 提交 · #12 · 补\n\n- 执行者：${by}\n- 做了什么：x\n- 结果：y\n`).join()).toMatch(/早于上一条/);
  });

  it("链路第一条不是开工、收尾之后还有记录、索引过期都报出来", () => {
    const root = temp();
    addNote(root, { ...base, stage: "开发", title: "没开工就写", now: at("2026-09-25T16:00:00Z") });
    writeIndex(root);
    expect(checkAll(root).join()).toMatch(/第一条必须是「开工」/);

    const closed = temp();
    addNote(closed, { ...base, stage: "开工", title: "a", now: at("2026-09-25T16:00:00Z") });
    addNote(closed, { ...base, stage: "收尾", title: "b", now: at("2026-09-25T16:05:00Z") });
    addNote(closed, { ...base, stage: "开发", title: "c", now: at("2026-09-25T16:06:00Z") });
    writeIndex(closed);
    expect(checkAll(closed).join()).toMatch(/已经收尾/);

    const stale = temp();
    addNote(stale, { ...base, stage: "开工", title: "a", now: at("2026-09-25T16:00:00Z") });
    expect(checkAll(stale).join()).toMatch(/INDEX\.md 不是最新的/);
  });

  it("notes/ 下的杂项文件和符号链接都报出来", () => {
    const root = temp();
    addNote(root, { ...base, stage: "开工", title: "a", now: at("2026-09-25T16:00:00Z") });
    writeFileSync(join(root, "notes", "draft.txt"), "x\n");
    symlinkSync("../README.md", join(root, "notes", "2026-09-26", "alice", "link.md"));
    writeIndex(root);
    const problems = checkAll(root).join("\n");
    expect(problems).toMatch(/notes\/draft\.txt：notes\/ 下只放/);
    expect(problems).toMatch(/link\.md：notes\/ 下不放符号链接/);
  });

  it("stage、main 上的发布与验收记录不要求以开工开始", () => {
    const root = temp();
    addNote(root, { ...base, chain: "stage", issues: ["8", "12"], stage: "发布", title: "打 v0.1.0-rc.1", now: at("2026-09-25T17:00:00Z") });
    addNote(root, { ...base, chain: "main", issues: [], stage: "验收", title: "正式实例验收", now: at("2026-09-25T17:30:00Z") });
    writeIndex(root);
    expect(checkAll(root)).toEqual([]);
  });
});

describe("索引与一览表", () => {
  it("INDEX.md 按日期倒序列出每个人的目录；一览表列出每条链路的执行者和最后一条", () => {
    const root = temp();
    addNote(root, { ...base, stage: "开工", title: "a", now: at("2026-09-24T02:00:00Z") });
    addNote(root, { ...base, user: "bob", chain: "task/13/other", issues: ["13"], by: "human-bob", stage: "开工", title: "b", now: at("2026-09-25T16:00:00Z") });
    addNote(root, { ...base, stage: "PR", title: "开 PR", now: at("2026-09-25T16:30:00Z") });
    const index = renderIndex(root);
    expect(index).toContain("- 2026-09-26：[alice](2026-09-26/alice/)、[bob](2026-09-26/bob/)");
    expect(index.indexOf("2026-09-26")).toBeLessThan(index.indexOf("2026-09-24："));
    expect(renderIndex(temp())).toContain("还没有记录。");
    const summary = renderSummary(root);
    expect(summary).toContain("| alice | task/12/review_queue | #12 | agent-claude-geek-bot-01 | 2 | 2026-09-24 10:00:00 | PR（2026-09-26 00:30:00） |");
    expect(summary).toContain("| bob | task/13/other | #13 | human-bob | 1 |");
  });
});

describe("暂存与并入", () => {
  it("task 分支之外写的记录暂存后并进 task worktree，按时间合并，暂存清空", () => {
    const pending = temp();
    const worktree = temp();
    addNote(worktree, { ...base, chain: "task/8/poll_etag", issues: ["8"], stage: "开工", title: "a", now: at("2026-09-25T16:00:00Z") });
    addNote(pending, { ...base, chain: "task/8/poll_etag", issues: ["8"], stage: "合并", title: "PR #9 合并", now: at("2026-09-25T16:10:00Z") });
    addNote(pending, { ...base, chain: "task/8/poll_etag", issues: ["8"], stage: "收尾", title: "清理", now: at("2026-09-25T16:11:00Z") });
    expect(flushPending(pending, worktree)).toEqual(["notes/2026-09-26/alice/task_8_poll_etag.md"]);
    expect(existsSync(join(pending, "notes"))).toBe(false);
    const chain = collectChains(worktree).get("alice/task_8_poll_etag");
    expect(chain.files[0].entries.map((entry: { stage: string }) => entry.stage)).toEqual(["开工", "合并", "收尾"]);
    writeIndex(worktree);
    expect(checkAll(worktree)).toEqual([]);
  });

  it("别的 task worktree 还在用的链路、接不上开工的 task 链路留在暂存；stage 链路照常并入", () => {
    const pending = temp();
    const worktree = temp();
    addNote(pending, { ...base, chain: "task/13/other", issues: ["13"], stage: "开工", title: "别人的", now: at("2026-09-25T16:00:00Z") });
    addNote(pending, { ...base, chain: "task/8/poll_etag", issues: ["8"], stage: "收尾", title: "只有收尾", now: at("2026-09-25T16:01:00Z") });
    addNote(pending, { ...base, chain: "stage", issues: ["8"], stage: "发布", title: "打 rc", now: at("2026-09-25T16:02:00Z") });
    expect(flushPending(pending, worktree, { skipSlugs: ["task_13_other"] })).toEqual(["notes/2026-09-26/alice/stage.md"]);
    expect(existsSync(join(pending, "notes/2026-09-26/alice/task_13_other.md"))).toBe(true);
    expect(existsSync(join(pending, "notes/2026-09-26/alice/task_8_poll_etag.md"))).toBe(true);
    expect(existsSync(join(worktree, "notes/2026-09-26/alice/task_8_poll_etag.md"))).toBe(false);
  });

  it("mergeEntries 按时间排序并去掉标题相同的重复记录", () => {
    const dir = temp();
    const file = join(dir, "notes/2026-09-26/alice/task_1_test.md");
    const meta = { date: "2026-09-26", user: "alice", chain: "task/1/test" };
    const later = "## 10:00:00 +08:00 · 开发 · #1 · 后\n\n- 执行者：human-alice\n- 做了什么：x\n- 结果：y\n";
    const earlier = "## 09:00:00 +08:00 · 开工 · #1 · 前\n\n- 执行者：human-alice\n- 做了什么：x\n- 结果：y\n";
    mergeEntries(file, meta, [later, earlier, later]);
    const text = readFileSync(file, "utf8");
    expect(text.indexOf("09:00:00")).toBeLessThan(text.indexOf("10:00:00"));
    expect(text.split("## 10:00:00").length).toBe(2);
    expect(checkChainFile("notes/2026-09-26/alice/task_1_test.md", text)).toEqual([]);
  });
});

describe("record：写进 worktree 还是暂存", () => {
  it("刚开工（HEAD 还在 origin/stage 上、链路还没入库）时写进当前 task worktree 并更新索引", () => {
    const root = repo();
    expect(chainMerged(root, "task/12/review_queue")).toBe(false);
    const { file, here } = record(root, { ...base, chain: undefined, stage: "开工", title: "补记开工" });
    expect(here).toBe(true);
    expect(file.startsWith(join(root, "notes"))).toBe(true);
    expect(readFileSync(join(root, "notes", "INDEX.md"), "utf8")).toBe(renderIndex(root));
  });

  it("给别的链路补记、合并之后的阶段、链路已经合进 origin/stage：一律暂存到主工作区", () => {
    const root = repo();
    const pending = join(root, PENDING_DIR, "notes");
    expect(record(root, { ...base, chain: "task/13/other", stage: "开发", title: "别的链路" }).here).toBe(false);
    expect(record(root, { ...base, chain: undefined, stage: "收尾", title: "收尾" }).here).toBe(false);
    expect(existsSync(pending)).toBe(true);
    expect(existsSync(join(root, "notes"))).toBe(false);

    record(root, { ...base, chain: undefined, stage: "开工", title: "开工" });
    commitAll(root);
    git(root, "update-ref", "refs/remotes/origin/stage", "HEAD"); // 模拟 PR 已合并
    expect(chainMerged(root, "task/12/review_queue")).toBe(true);
    expect(record(root, { ...base, chain: undefined, stage: "审查", title: "合并后才补" }).here).toBe(false);
  });

  it("不在 task 分支上（例如 stage）时写 stage 链路也暂存，不写进工作区", () => {
    const root = repo();
    git(root, "checkout", "-q", "stage");
    expect(record(root, { ...base, chain: undefined, stage: "阻塞", title: "等授权" }).here).toBe(false);
    expect(existsSync(join(root, "notes"))).toBe(false);
  });
});

describe("checkPullRequest", () => {
  const recordAt = (root: string, stage: string, minute: number, issues = ["12"]) =>
    addNote(root, { ...base, issues, stage, title: stage, now: at(`2026-09-25T16:${String(minute).padStart(2, "0")}:00Z`) });
  const pr = (root: string) => checkPullRequest(root, { base: "stage", head: "task/12/review_queue" }).join("\n");

  it("没有链路时失败，并说明开工会写第一条", () => {
    expect(pr(repo())).toMatch(/没有 task\/12\/review_queue 的执行链路/);
  });

  it("缺开工、提交、PR、审查中的任何一步都失败，并给出写法；四步都有就通过", () => {
    const root = repo();
    recordAt(root, "开工", 0);
    recordAt(root, "提交", 5);
    commitAll(root);
    const missing = pr(root);
    expect(missing).toMatch(/「PR」/);
    expect(missing).toMatch(/「审查」/);
    expect(missing).toContain("node scripts/note.mjs add --stage PR --issue 12");
    recordAt(root, "PR", 10);
    recordAt(root, "审查", 20);
    commitAll(root);
    expect(pr(root)).toBe("");
  });

  it("只引用别的 issue 的记录不算", () => {
    const root = repo();
    for (const [stage, minute] of [["开工", 0], ["提交", 1], ["PR", 2], ["审查", 3]] as const) recordAt(root, stage, minute, ["8"]);
    commitAll(root);
    expect(pr(root)).toMatch(/「开工」/);
  });

  it("不是 task 分支（例如 stage 进 main）时不要求", () => {
    expect(checkPullRequest(repo(), { base: "stage", head: "stage" })).toEqual([]);
  });

  it("审查模式（forReview）允许暂缺「审查」记录", () => {
    const root = repo();
    recordAt(root, "开工", 0);
    recordAt(root, "提交", 5);
    recordAt(root, "PR", 10);
    commitAll(root);
    expect(checkPullRequest(root, { base: "stage", head: "task/12/review_queue", forReview: true })).toEqual([]);
    expect(pr(root)).toMatch(/「审查」/);
  });

  it("改写或删除已经进了 base 的记录时失败（只能追加）", () => {
    const root = repo();
    for (const [stage, minute] of [["开工", 0], ["提交", 5], ["PR", 10], ["审查", 20]] as const) recordAt(root, stage, minute);
    commitAll(root);
    git(root, "checkout", "-q", "stage");
    git(root, "merge", "-q", "task/12/review_queue");
    git(root, "checkout", "-q", "task/12/review_queue");
    const chainPath = join(root, "notes/2026-09-26/alice/task_12_review_queue.md");
    writeFileSync(chainPath, readFileSync(chainPath, "utf8").replace("有结果", "篡改的结果"));
    recordAt(root, "返工", 30);
    commitAll(root);
    expect(pr(root)).toMatch(/删除或改写了已有记录的行/);

    const removed = repo();
    for (const [stage, minute] of [["开工", 0], ["提交", 5], ["PR", 10], ["审查", 20]] as const) recordAt(removed, stage, minute);
    addNote(removed, { ...base, chain: "stage", stage: "发布", title: "rc", now: at("2026-09-25T16:40:00Z") });
    commitAll(removed);
    git(removed, "checkout", "-q", "stage");
    git(removed, "merge", "-q", "task/12/review_queue");
    git(removed, "checkout", "-q", "task/12/review_queue");
    rmSync(join(removed, "notes/2026-09-26/alice/stage.md"));
    recordAt(removed, "返工", 50);
    commitAll(removed);
    expect(checkPullRequest(removed, { base: "stage", head: "task/12/review_queue" }).join("\n")).toMatch(/不能删除执行记录/);
  });

  it("base 解析不了时抛错，不当作通过", () => {
    const root = repo();
    recordAt(root, "开工", 0);
    commitAll(root);
    expect(() => checkPullRequest(root, { base: "origin/no_such_branch", head: "task/12/review_queue" })).toThrow();
  });
});

describe("命令行", () => {
  it("check --root 在临时目录里跑：格式错以 1 退出；修好后以 0 退出", () => {
    const root = temp();
    addNote(root, { ...base, stage: "开发", title: "没开工", now: at("2026-09-25T16:00:00Z") });
    writeIndex(root);
    const bad = cli("check", "--root", root);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("第一条必须是「开工」");
    const good = temp();
    addNote(good, { ...base, stage: "开工", title: "a", now: at("2026-09-25T16:00:00Z") });
    writeIndex(good);
    const ok = cli("check", "--root", good);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain("执行记录检查通过：1 条链路");
  });

  it("index --root 生成索引；--summary 只输出一览表", () => {
    const root = temp();
    addNote(root, { ...base, stage: "开工", title: "a", now: at("2026-09-25T16:00:00Z") });
    expect(cli("index", "--root", root).status).toBe(0);
    expect(readFileSync(join(root, "notes", "INDEX.md"), "utf8")).toBe(renderIndex(root));
    const summary = cli("index", "--summary", "--root", root);
    expect(summary.status).toBe(0);
    expect(summary.stdout).toBe(renderSummary(root));
  });

  it("add 缺身份时以 1 退出，不写文件；带 --user --by 时写进当前 task worktree", () => {
    const root = repo();
    const missing = cli("add", "--root", root, "--stage", "开工", "--issue", "12", "--title", "a", "--did", "b", "--result", "c");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("GEEK_NOTES_USER");
    expect(existsSync(join(root, "notes"))).toBe(false);
    const written = cli("add", "--root", root, "--user", "alice", "--by", "human-alice", "--stage", "开工", "--issue", "12", "--title", "a", "--did", "b", "--result", "c");
    expect(written.status, written.stderr).toBe(0);
    expect(written.stdout).toContain("已写入 notes/");
    expect(cli("check", "--root", root).status).toBe(0);
  });

  it("不认识的子命令、参数，以及不带 --pr 的 --base：打印用法并以 2 退出", () => {
    for (const args of [["nope"], ["check", "--no-such-flag"], ["check", "--base", "stage"], ["index", "--pr"], []]) {
      const result = cli(...args);
      expect(result.status, args.join(" ")).toBe(2);
      expect(result.stderr).toContain("用法：node scripts/note.mjs");
    }
  });

  it("flush 不在 task 分支上时拒绝", () => {
    const root = repo();
    git(root, "checkout", "-q", "stage");
    mkdirSync(join(root, PENDING_DIR), { recursive: true });
    const result = cli("flush", "--root", root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("flush 要在 task worktree 里运行");
  });
});
