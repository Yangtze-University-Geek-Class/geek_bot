/**
 * #12 出网代理的规则（S-03、S-14）与行为：纯函数单测，加上在本机回环地址上起的代理与假上游（不连外网，
 * DNS 由注入的 lookup 代替）。不需要 KVM，随 pnpm test 在任何机器上跑。
 * 私网与保留地址在运行时拼出，仓库里不留地址字面量（DOCUMENTATION「事实来源」）。
 */
import { BlockList, connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildBlockList, chooseAddress, decideTarget, isForbiddenAddress, matchesSuffix, parseArgs, parseConnectLine, startProxy } from "./egress-proxy.mjs";

const ip4 = (...octets: number[]) => octets.join(".");
const ip6 = (...groups: string[]) => groups.join(":");
const ALLOW = ["registry.npmjs.org", "deb.debian.org"];

describe("parseArgs", () => {
  it("连接数与字节上限只接受正整数，不让 NaN 或 0 把上限变成失效", () => {
    expect(parseArgs(["--max-connections", "5", "--max-bytes", "1024"])).toMatchObject({ maxConnections: 5, maxBytes: 1024 });
    for (const bad of ["abc", "0", "-1", "1.5", "", "1e3"]) {
      expect(() => parseArgs(["--max-connections", bad])).toThrow("--max-connections 要是正整数");
      expect(() => parseArgs(["--max-bytes", bad])).toThrow("--max-bytes 要是正整数");
    }
  });
});

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
    const samples = [
      ip6("", "", ""),
      ip6("", "", "1"),
      ip6("fd00", "", "1"),
      ip6("fc12", "3456", "", "1"),
      ip6("fe80", "", "1"),
      ip6("", "", "ffff", ip4(10, 0, 0, 1)),
      ip6("", "", "ffff", ip4(8, 8, 8, 8)),
      ip6("", "", "ffff", "a00", "1"),
      ip6("64", "ff9b", "", "a00", "1"),
      ip6("ff02", "", "1"),
    ];
    for (const address of samples) expect(isForbiddenAddress(address), address).toBe(true);
  });

  it("嵌入 IPv4 的其它写法也拒绝：IPv4 兼容地址、本地用途的 NAT64、6to4、Teredo", () => {
    for (const address of [ip6("", "", ip4(10, 0, 0, 1)), ip6("", "", "a00", "1"), ip6("64", "ff9b", "1", "", "a00", "1"), ip6("2002", "a00", "1", "", "1"), ip6("2001", "0", "", "1")]) {
      expect(isForbiddenAddress(address), address).toBe(true);
    }
  });

  it("回归：IPv4 映射规则不能连带拒绝全部 IPv4（Node BlockList 会拿 IPv4 去比映射规则）", () => {
    expect(isForbiddenAddress(ip4(8, 8, 8, 8))).toBe(false);
  });

  it("公网地址放行；不是 IP 的字符串一律当作禁止", () => {
    for (const address of [ip4(104, 16, 0, 1), ip4(151, 101, 0, 1), ip4(100, 128, 0, 1), ip4(172, 32, 0, 1), ip6("2606", "4700", "", "1111"), ip6("2001", "4860", "", "8888")]) {
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

describe("parseConnectLine 与 decideTarget", () => {
  it("只认合法的 CONNECT 请求行；方括号必须成对，只包 IPv6", () => {
    expect(parseConnectLine("CONNECT registry.npmjs.org:443 HTTP/1.1")).toEqual({ host: "registry.npmjs.org", port: 443 });
    expect(parseConnectLine(`CONNECT [${ip6("2606", "4700", "", "1111")}]:443 HTTP/1.1`)).toEqual({ host: ip6("2606", "4700", "", "1111"), port: 443 });
    for (const line of [
      "GET http://registry.npmjs.org/ HTTP/1.1",
      "CONNECT [registry.npmjs.org:443 HTTP/1.1",
      "CONNECT registry.npmjs.org]:443 HTTP/1.1",
      "CONNECT registry.npmjs.org 443 HTTP/1.1",
      "CONNECT  registry.npmjs.org:443 HTTP/1.1",
      "CONNECT registry.npmjs.org:443 HTTP/2",
      "CONNECT registry.npmjs.org:0 HTTP/1.1",
      "CONNECT registry.npmjs.org:99999 HTTP/1.1",
    ]) {
      expect(parseConnectLine(line), line).toBeNull();
    }
  });

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
    expect(decideTarget(ip6("2606", "4700", "", "1111"), 443, ALLOW).reason).toBe("ip_literal");
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
    expect(chooseAddress([{ address: ip6("", "", "1"), family: 6 }]).address).toBeNull();
    expect(chooseAddress([])).toEqual({ address: null, reason: "no_address" });
  });

  it("全部是公网地址时优先连 IPv4", () => {
    const addresses = [
      { address: ip6("2606", "4700", "", "1111"), family: 6 },
      { address: ip4(104, 16, 0, 1), family: 4 },
    ];
    expect(chooseAddress(addresses)).toEqual({ address: ip4(104, 16, 0, 1), reason: "resolved" });
  });
});

// ---- 代理行为：本机回环上的代理 + 假上游，DNS 由注入的 lookup 代替 ----

const LOOPBACK = ip4(127, 0, 0, 1);
const PUBLIC_ANSWER = ip4(104, 16, 0, 1);
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function listen(server: Server): Promise<number> {
  return new Promise(resolve => server.listen(0, LOOPBACK, () => resolve((server.address() as AddressInfo).port)));
}

/** 假上游：记下收到的数据，连上后可选地回发一段数据。 */
async function fakeUpstream(reply?: Buffer) {
  const received: Buffer[] = [];
  const server = createServer(socket => {
    socket.on("data", data => received.push(data));
    if (reply) socket.write(reply);
  });
  const port = await listen(server);
  cleanups.push(() => server.close());
  return { port, received };
}

async function proxyWith(options: { maxConnections?: number; maxBytes?: number; lookup?: (host: string) => Promise<{ address: string; family: number }[]>; upstreamPort: number }) {
  const records: Record<string, unknown>[] = [];
  const connected: string[] = [];
  const proxy = startProxy({
    listen: `${LOOPBACK}:0`,
    allow: ALLOW,
    maxConnections: options.maxConnections ?? 10,
    maxBytes: options.maxBytes ?? 1024 * 1024,
    blockList: new BlockList(),
    lookup: options.lookup ?? (async () => [{ address: PUBLIC_ANSWER, family: 4 }]),
    record: (entry: Record<string, unknown>) => records.push(entry),
    connectUpstream: ({ host }: { host: string }) => {
      connected.push(host);
      return connect({ host: LOOPBACK, port: options.upstreamPort });
    },
  });
  await new Promise<void>(resolve => (proxy.server.listening ? resolve() : proxy.server.once("listening", () => resolve())));
  cleanups.push(() => proxy.shutdown());
  return { port: (proxy.server.address() as AddressInfo).port, records, connected, stats: proxy.stats };
}

/** 发一段原始数据给代理，收集回来的全部字节，直到连接关闭或超时。 */
function exchange(port: number, payload: string | Buffer, extra?: { afterMs: number; data: Buffer }): Promise<{ text: string; bytes: number; socket: Socket }> {
  return new Promise(resolve => {
    const socket = connect({ host: LOOPBACK, port }, () => {
      socket.write(payload);
      if (extra) setTimeout(() => socket.write(extra.data), extra.afterMs);
    });
    const chunks: Buffer[] = [];
    socket.on("data", data => chunks.push(data));
    const done = () => resolve({ text: Buffer.concat(chunks).toString("latin1"), bytes: Buffer.concat(chunks).length, socket });
    socket.on("close", done);
    socket.on("error", () => undefined);
    setTimeout(() => {
      socket.destroy();
    }, 1500);
  });
}

const CONNECT_REQUEST = "CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("startProxy", () => {
  it("每个 CONNECT 只解析一次，只连接解析并校验过的那个地址", async () => {
    const upstream = await fakeUpstream();
    const lookup = vi.fn(async () => [{ address: PUBLIC_ANSWER, family: 4 }]);
    const proxy = await proxyWith({ lookup, upstreamPort: upstream.port });
    const { text } = await exchange(proxy.port, CONNECT_REQUEST);
    expect(text).toContain("200 Connection Established");
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(proxy.connected).toEqual([PUBLIC_ANSWER]);
  });

  it("解析与连接上游期间客户端发来的数据不丢", async () => {
    const upstream = await fakeUpstream();
    const lookup = async () => {
      await sleep(150);
      return [{ address: PUBLIC_ANSWER, family: 4 }];
    };
    const proxy = await proxyWith({ lookup, upstreamPort: upstream.port });
    await exchange(proxy.port, Buffer.concat([Buffer.from(CONNECT_REQUEST), Buffer.from("early-")]), { afterMs: 50, data: Buffer.from("during-lookup") });
    expect(Buffer.concat(upstream.received).toString()).toBe("early-during-lookup");
  });

  it("总字节数在传输过程中核对：超过上限就断开两端，记为 byte_limit", async () => {
    const upstream = await fakeUpstream(Buffer.alloc(64 * 1024, 7));
    const proxy = await proxyWith({ maxBytes: 4096, upstreamPort: upstream.port });
    const { bytes } = await exchange(proxy.port, CONNECT_REQUEST);
    expect(bytes).toBeLessThan(64 * 1024);
    await sleep(50);
    expect(proxy.records.some(entry => entry.decision === "error" && entry.reason === "byte_limit")).toBe(true);
  });

  it("连接数上限在解析之前占位：并发请求不能一起越过上限", async () => {
    const upstream = await fakeUpstream();
    const lookup = async () => {
      await sleep(200);
      return [{ address: PUBLIC_ANSWER, family: 4 }];
    };
    const proxy = await proxyWith({ maxConnections: 1, lookup, upstreamPort: upstream.port });
    const [first, second] = await Promise.all([exchange(proxy.port, CONNECT_REQUEST), exchange(proxy.port, CONNECT_REQUEST)]);
    const statuses = [first.text, second.text].map(text => text.split("\r\n")[0]).sort();
    expect(statuses).toEqual(["HTTP/1.1 200 Connection Established", "HTTP/1.1 429 Too Many Requests"]);
  });

  it("上游连不上时回 502，记为 error，不记成 allow", async () => {
    const closed = createServer();
    const port = await listen(closed);
    await new Promise(resolve => closed.close(resolve));
    const proxy = await proxyWith({ upstreamPort: port });
    const { text } = await exchange(proxy.port, CONNECT_REQUEST);
    expect(text.split("\r\n")[0]).toBe("HTTP/1.1 502 Bad Gateway");
    await sleep(50);
    expect(proxy.records.find(entry => entry.host === "registry.npmjs.org")).toMatchObject({ decision: "error" });
    expect(proxy.records.some(entry => entry.decision === "allow")).toBe(false);
  });

  it("拒绝的请求不解析、不连上游", async () => {
    const upstream = await fakeUpstream();
    const lookup = vi.fn(async () => [{ address: PUBLIC_ANSWER, family: 4 }]);
    const proxy = await proxyWith({ lookup, upstreamPort: upstream.port });
    const { text } = await exchange(proxy.port, "CONNECT github.com:443 HTTP/1.1\r\n\r\n");
    expect(text.split("\r\n")[0]).toBe("HTTP/1.1 403 Forbidden");
    expect(lookup).not.toHaveBeenCalled();
    expect(proxy.connected).toEqual([]);
  });
});
