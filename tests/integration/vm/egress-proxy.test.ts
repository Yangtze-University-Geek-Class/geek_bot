/**
 * #12 出网代理的规则（S-03、S-14）：纯函数单测，不需要 KVM，随 pnpm test 在任何机器上跑。
 * 私网地址在运行时拼出，仓库里不留字面量（TESTING「隔离」）。
 */
import { describe, expect, it } from "vitest";
import { buildBlockList, chooseAddress, decideTarget, isForbiddenAddress, matchesSuffix } from "./egress-proxy.mjs";

const ip4 = (...octets: number[]) => octets.join(".");
const ALLOW = ["registry.npmjs.org", "deb.debian.org"];

describe("isForbiddenAddress", () => {
  it("S-14 列出的 IPv4 地址段都被拒绝", () => {
    const samples = [
      ip4(0, 1, 2, 3),
      ip4(10, 0, 2, 2),
      ip4(10, 255, 255, 255),
      ip4(100, 64, 0, 1),
      ip4(100, 127, 255, 254),
      ip4(127, 0, 0, 1),
      ip4(169, 254, 169, 254),
      ip4(172, 16, 0, 1),
      ip4(172, 31, 255, 255),
      ip4(192, 168, 1, 1),
      ip4(224, 0, 0, 1),
      ip4(255, 255, 255, 255),
    ];
    for (const address of samples) expect(isForbiddenAddress(address), address).toBe(true);
  });

  it("S-14 列出的 IPv6 地址段都被拒绝，包括 IPv4 映射与 NAT64", () => {
    for (const address of ["::", "::1", "fd00::1", "fc12:3456::1", "fe80::1", `::ffff:${ip4(10, 0, 0, 1)}`, `::ffff:${ip4(8, 8, 8, 8)}`, "::ffff:a00:1", "64:ff9b::a00:1", "ff02::1"]) {
      expect(isForbiddenAddress(address), address).toBe(true);
    }
  });

  it("回归：IPv4 映射规则不能连带拒绝全部 IPv4（Node BlockList 会拿 IPv4 去比映射规则）", () => {
    expect(isForbiddenAddress(ip4(8, 8, 8, 8))).toBe(false);
  });

  it("公网地址放行；不是 IP 的字符串一律当作禁止", () => {
    for (const address of [ip4(104, 16, 0, 1), ip4(151, 101, 0, 1), ip4(100, 128, 0, 1), ip4(172, 32, 0, 1), "2606:4700::1111"]) {
      expect(isForbiddenAddress(address), address).toBe(false);
    }
    expect(isForbiddenAddress("registry.npmjs.org")).toBe(true);
    expect(isForbiddenAddress("")).toBe(true);
  });

  it("部署者另配的网段一并拒绝", () => {
    const list = buildBlockList([`${ip4(198, 51, 100, 0)}/24`]);
    expect(isForbiddenAddress(ip4(198, 51, 100, 7), list)).toBe(true);
    expect(isForbiddenAddress(ip4(198, 51, 101, 7), list)).toBe(false);
  });
});

describe("decideTarget", () => {
  it("白名单里的域名与子域放行，只放 443", () => {
    expect(decideTarget("registry.npmjs.org", 443, ALLOW)).toEqual({ allowed: true, reason: "allowlisted" });
    expect(decideTarget("REGISTRY.npmjs.org.", 443, ALLOW).allowed).toBe(true);
    expect(decideTarget("security.deb.debian.org", 443, ALLOW).allowed).toBe(true);
    expect(decideTarget("registry.npmjs.org", 80, ALLOW)).toEqual({ allowed: false, reason: "port_not_allowed" });
  });

  it("GitHub 域名清单先于白名单拒绝，白名单里写了也不放", () => {
    const allowEverything = [...ALLOW, "github.com", "githubusercontent.com", "ghcr.io"];
    for (const host of ["github.com", "api.github.com", "codeload.github.com", "npm.pkg.github.com", "objects.githubusercontent.com", "ghcr.io"]) {
      expect(decideTarget(host, 443, allowEverything), host).toEqual({ allowed: false, reason: "github_denied" });
    }
  });

  it("IP 字面量、白名单外的域名、后缀冒名与非法主机名都拒绝", () => {
    expect(decideTarget(ip4(1, 1, 1, 1), 443, ALLOW).reason).toBe("ip_literal");
    expect(decideTarget("[2606:4700::1111]", 443, ALLOW).reason).toBe("ip_literal");
    expect(decideTarget("example.com", 443, ALLOW).reason).toBe("not_in_allowlist");
    expect(decideTarget("evilregistry.npmjs.org.example.com", 443, ALLOW).reason).toBe("not_in_allowlist");
    expect(decideTarget("notregistry.npmjs.org", 443, ALLOW).reason).toBe("not_in_allowlist");
    expect(decideTarget("bad host", 443, ALLOW).reason).toBe("invalid_host");
  });

  it("后缀只按整段匹配", () => {
    expect(matchesSuffix("a.b.example.com", ["example.com"])).toBe(true);
    expect(matchesSuffix("badexample.com", ["example.com"])).toBe(false);
  });
});

describe("chooseAddress", () => {
  it("解析结果里只要有一个禁止地址就整体拒绝（防混入私网的记录）", () => {
    const mixed = [
      { address: ip4(104, 16, 0, 1), family: 4 },
      { address: ip4(10, 0, 0, 1), family: 4 },
    ];
    expect(chooseAddress(mixed)).toEqual({ address: null, reason: "resolved_to_forbidden_address" });
    expect(chooseAddress([{ address: "::1", family: 6 }]).address).toBeNull();
    expect(chooseAddress([])).toEqual({ address: null, reason: "no_address" });
  });

  it("全部是公网地址时优先连 IPv4，返回的就是要连接的地址，不再重新解析", () => {
    const addresses = [
      { address: "2606:4700::1111", family: 6 },
      { address: ip4(104, 16, 0, 1), family: 4 },
    ];
    expect(chooseAddress(addresses)).toEqual({ address: ip4(104, 16, 0, 1), reason: "resolved" });
  });
});
