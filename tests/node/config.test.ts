import { describe, expect, it } from "vitest";
import { NODE_SLOT_DEFAULTS, NodeConfigError, createNodeConfig } from "../../app/node/src/index.js";

const base = { GEEK_BOT_NODE_CONTROL_URL: "https://geek-bot.example.com", GEEK_BOT_NODE_NAME: "node-1" };

function problemsOf(env: Record<string, string | undefined>): readonly string[] {
  try {
    createNodeConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(NodeConfigError);
    return (error as NodeConfigError).problems;
  }
  throw new Error("预期抛出 NodeConfigError，实际没有抛出");
}

describe("node 配置", () => {
  it("读取 control 地址和节点名；槽位默认 sandbox 1、vm 0", () => {
    const config = createNodeConfig(base);
    expect(config).toEqual({ controlUrl: "https://geek-bot.example.com", name: "node-1", slots: { sandbox: 1, vm: 0 } });
    expect(config.slots).toEqual(NODE_SLOT_DEFAULTS);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.slots)).toBe(true);
  });

  it("control 地址去掉末尾斜杠，保留路径前缀，http 也允许", () => {
    expect(createNodeConfig({ ...base, GEEK_BOT_NODE_CONTROL_URL: "https://geek-bot.example.com/" }).controlUrl).toBe("https://geek-bot.example.com");
    expect(createNodeConfig({ ...base, GEEK_BOT_NODE_CONTROL_URL: "http://control:3000" }).controlUrl).toBe("http://control:3000");
    expect(createNodeConfig({ ...base, GEEK_BOT_NODE_CONTROL_URL: "https://geek-bot.example.com/bot/" }).controlUrl).toBe("https://geek-bot.example.com/bot");
  });

  it("control 地址只允许 http 或 https，不许带账号密码、查询串或片段", () => {
    for (const url of ["ftp://geek-bot.example.com", "file:///srv/control", "ws://geek-bot.example.com", "javascript:alert(1)"]) {
      expect(problemsOf({ ...base, GEEK_BOT_NODE_CONTROL_URL: url }).join("\n")).toContain("只允许 http 或 https");
    }
    expect(problemsOf({ ...base, GEEK_BOT_NODE_CONTROL_URL: "geek-bot.example.com" }).join("\n")).toContain("不是合法的 URL");
    expect(problemsOf({ ...base, GEEK_BOT_NODE_CONTROL_URL: "https://user:pass@geek-bot.example.com" }).join("\n")).toContain("不能包含用户名或密码");
    expect(problemsOf({ ...base, GEEK_BOT_NODE_CONTROL_URL: "https://geek-bot.example.com/?a=1" }).join("\n")).toContain("不能包含查询串或片段");
  });

  it("control 地址和节点名缺失或留空时报错", () => {
    const problems = problemsOf({ GEEK_BOT_NODE_CONTROL_URL: " ", GEEK_BOT_NODE_NAME: undefined });
    expect(problems).toEqual(["缺少环境变量 GEEK_BOT_NODE_CONTROL_URL", "缺少环境变量 GEEK_BOT_NODE_NAME"]);
  });

  it("节点名只能是小写字母、数字和连字符", () => {
    for (const name of ["Node-1", "node_1", "-node", "node-", "节点", "a".repeat(64)]) {
      expect(problemsOf({ ...base, GEEK_BOT_NODE_NAME: name }).join("\n")).toContain("GEEK_BOT_NODE_NAME 只能包含小写字母、数字和连字符");
    }
    expect(createNodeConfig({ ...base, GEEK_BOT_NODE_NAME: "a".repeat(63) }).name).toHaveLength(63);
  });

  it("槽位数是非负整数，0 合法", () => {
    const config = createNodeConfig({ ...base, GEEK_BOT_NODE_SANDBOX_SLOTS: "0", GEEK_BOT_NODE_VM_SLOTS: " 2 " });
    expect(config.slots).toEqual({ sandbox: 0, vm: 2 });
    for (const value of ["-1", "1.5", "two", "1e2"]) {
      expect(problemsOf({ ...base, GEEK_BOT_NODE_VM_SLOTS: value })).toEqual([`GEEK_BOT_NODE_VM_SLOTS 必须是非负整数，当前值：${JSON.stringify(value)}`]);
    }
    expect(problemsOf({ ...base, GEEK_BOT_NODE_SANDBOX_SLOTS: "-3" })[0]).toContain("GEEK_BOT_NODE_SANDBOX_SLOTS 必须是非负整数");
  });
});
