#!/usr/bin/env node
/**
 * #12 实验用的出网 CONNECT 代理：只用 Node 标准库，在实验容器里监听回环地址，VM 经 QEMU 的 guestfwd 连到它。
 * 规则按 docs/architecture/SECURITY.md 的 S-03（GitHub 域名清单默认拒绝）与 S-14（出网控制）：
 *
 *   - 只接受 CONNECT（HTTPS 隧道），普通 HTTP 请求一律 405；
 *   - 目标必须是域名：直接写 IP 的请求拒绝；只放 443 端口；
 *   - GitHub 域名清单按后缀拒绝，先于白名单判断；不在白名单里的域名拒绝；
 *   - 解析一次；解析结果里只要有一个落在禁止的地址段就整体拒绝；只连接校验过的那个地址，不再重新解析（防 DNS 重绑定）；
 *   - 连接数上限在解析之前占位；总字节数上限在传输过程中逐块核对，超过就断开两端；
 *   - 逐条记录决定（JSON 行），只记主机名、端口、地址与字节数，不记请求头和载荷。
 *
 * 这是可行性实验用的代理，生产实现随 #17 写进 app/node，照这里的规则与单测重新实现。
 * 私网与保留地址段在运行时由数字拼出，仓库里不留地址字面量（DOCUMENTATION「事实来源」）。
 * 已知不做的：CONNECT 的主机名没有与 TLS 的 SNI 绑定（共享 CDN 上可换 SNI 绕过白名单），留给 #17。
 *
 *   node egress-proxy.mjs --listen 127.0.0.1:3128 --allow registry.npmjs.org,deb.debian.org [--log proxy.jsonl]
 *                         [--max-connections 2000] [--max-bytes 4294967296]
 */
import { createServer, BlockList, connect, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ip4 = (...octets) => octets.join(".");
/** 按分组拼 IPv6 地址：空串用来表示 `::` 省略的部分，例如 ip6("fe80", "", "") 是 `fe80::`。 */
const ip6 = (...groups) => groups.join(":");

/** S-14 禁止的 IPv4 地址段：[起始地址, 前缀长度]。 */
export const FORBIDDEN_IPV4 = Object.freeze([
  [ip4(0, 0, 0, 0), 8], // 本网络
  [ip4(10, 0, 0, 0), 8], // RFC 1918
  [ip4(100, 64, 0, 0), 10], // CGNAT
  [ip4(127, 0, 0, 0), 8], // 回环
  [ip4(169, 254, 0, 0), 16], // 链路本地（含云元数据地址）
  [ip4(172, 16, 0, 0), 12], // RFC 1918
  [ip4(192, 168, 0, 0), 16], // RFC 1918
  [ip4(224, 0, 0, 0), 4], // 组播
  [ip4(240, 0, 0, 0), 4], // 保留与广播
]);

/**
 * 禁止的 IPv6 地址段。前六条是 S-14 列出的；后面几条会在地址里嵌入 IPv4，一并拒绝，免得借它们绕到私网。
 * IPv4 映射地址（::ffff:0:0/96）与 IPv4 兼容地址（::/96）不放进 BlockList：Node 的 BlockList 会拿 IPv4 地址去比
 * 这类规则，加了就会拒绝全部 IPv4。它们在 isForbiddenAddress 里单独判断。
 */
export const FORBIDDEN_IPV6 = Object.freeze([
  [ip6("", "", ""), 128], // 未指定地址
  [ip6("", "", "1"), 128], // 回环
  [ip6("fc00", "", ""), 7], // ULA
  [ip6("fe80", "", ""), 10], // 链路本地
  [ip6("64", "ff9b", "", ""), 96], // NAT64（RFC 6052）
  [ip6("ff00", "", ""), 8], // 组播
  [ip6("64", "ff9b", "1", "", ""), 48], // 本地用途的 NAT64（RFC 8215）
  [ip6("2002", "", ""), 16], // 6to4
  [ip6("2001", "", ""), 32], // Teredo
]);

/** 嵌入 IPv4 的两种写法：`::ffff:a.b.c.d`（映射）与 `::a.b.c.d`（兼容，已废弃），也包括它们的十六进制写法。 */
const IPV4_EMBEDDED_RE = /^::(?:ffff:)?(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]{1,4}:[0-9a-f]{1,4})$/i;

/** S-03 的 GitHub 域名清单：按后缀拒绝。 */
export const GITHUB_SUFFIXES = Object.freeze(["github.com", "githubusercontent.com", "ghcr.io"]);

/** 部署者另配的组网网段等（形如 `a.b.c.d/n`），在 FORBIDDEN_* 之外追加。 */
export function buildBlockList(extraCidrs = []) {
  const list = new BlockList();
  for (const [address, prefix] of FORBIDDEN_IPV4) list.addSubnet(address, prefix, "ipv4");
  for (const [address, prefix] of FORBIDDEN_IPV6) list.addSubnet(address, prefix, "ipv6");
  for (const cidr of extraCidrs) {
    const [address, prefix] = cidr.split("/");
    const family = isIP(address) === 6 ? "ipv6" : "ipv4";
    list.addSubnet(address, Number(prefix), family);
  }
  return list;
}

/** 地址是否落在禁止的地址段；不是合法 IP 的一律当作禁止。 */
export function isForbiddenAddress(address, blockList = buildBlockList()) {
  const family = isIP(address);
  if (family === 0) return true;
  if (family === 6 && IPV4_EMBEDDED_RE.test(address)) return true;
  return blockList.check(address, family === 6 ? "ipv6" : "ipv4");
}

/** host 是否等于某个后缀，或是它的子域。比较前去掉末尾的点并转小写。 */
export function matchesSuffix(host, suffixes) {
  const name = host.toLowerCase().replace(/\.$/, "");
  return suffixes.some(suffix => name === suffix || name.endsWith(`.${suffix}`));
}

/**
 * 解析 CONNECT 请求行：返回 { host, port }，不是合法的 CONNECT 返回 null。
 * 方括号只允许包住 IPv6 字面量，而且必须成对；主机名里不许有空白与方括号。
 */
export function parseConnectLine(line) {
  const match = /^CONNECT (?:\[([0-9a-f:.]+)\]|([^\s:[\]]+)):(\d{1,5}) HTTP\/1\.[01]$/i.exec(line);
  if (!match) return null;
  const port = Number(match[3]);
  if (port < 1 || port > 65535) return null;
  return { host: match[1] ?? match[2], port };
}

/**
 * 解析之前的判断：{ allowed: boolean, reason: string }。
 * 顺序：端口 → IP 字面量 → 主机名格式 → GitHub 清单 → 白名单。
 */
export function decideTarget(host, port, allowSuffixes) {
  if (port !== 443) return { allowed: false, reason: "port_not_allowed" };
  if (isIP(host) !== 0) return { allowed: false, reason: "ip_literal" };
  if (!/^[a-z0-9.-]+$/i.test(host) || host.length > 253) return { allowed: false, reason: "invalid_host" };
  if (matchesSuffix(host, GITHUB_SUFFIXES)) return { allowed: false, reason: "github_denied" };
  if (!matchesSuffix(host, allowSuffixes)) return { allowed: false, reason: "not_in_allowlist" };
  return { allowed: true, reason: "allowlisted" };
}

/** 解析结果的判断：全部地址都不在禁止段时，返回要连接的那一个；否则拒绝。 */
export function chooseAddress(addresses, blockList = buildBlockList()) {
  if (addresses.length === 0) return { address: null, reason: "no_address" };
  const forbidden = addresses.find(entry => isForbiddenAddress(entry.address, blockList));
  if (forbidden) return { address: null, reason: "resolved_to_forbidden_address" };
  const preferred = addresses.find(entry => entry.family === 4) ?? addresses[0];
  return { address: preferred.address, reason: "resolved" };
}

function positiveInteger(flag, value) {
  const number = Number(value);
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(number) || number < 1) throw new Error(`${flag} 要是正整数`);
  return number;
}

export function parseArgs(argv) {
  const options = { listen: "127.0.0.1:3128", allow: [], log: null, maxConnections: 2000, maxBytes: 4 * 1024 ** 3, denyCidr: [] };
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (value === undefined) throw new Error(`参数缺值：${flag}`);
    if (flag === "--listen") options.listen = value;
    else if (flag === "--allow") options.allow = value.split(",").filter(Boolean);
    else if (flag === "--log") options.log = value;
    else if (flag === "--max-connections") options.maxConnections = positiveInteger(flag, value);
    else if (flag === "--max-bytes") options.maxBytes = positiveInteger(flag, value);
    else if (flag === "--deny-cidr") options.denyCidr = value.split(",").filter(Boolean);
    else throw new Error(`不认识的参数：${flag}`);
  }
  return options;
}

/**
 * 起代理。测试可以注入：lookup（代替 DNS）、blockList（代替禁止段）、record（收集记录）、
 * connectUpstream（代替 net.connect，只在测试里用来连本机的假上游）。
 */
export function startProxy(options) {
  const blockList = options.blockList ?? buildBlockList(options.denyCidr ?? []);
  const lookup = options.lookup ?? ((host) => dnsLookup(host, { all: true, verbatim: true }));
  const connectUpstream = options.connectUpstream ?? connect;
  const stats = { connections: 0, bytesUp: 0, bytesDown: 0 };
  let reserved = 0;
  const record =
    options.record ??
    (entry => {
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
      if (options.log) appendFileSync(options.log, `${line}\n`);
      else process.stdout.write(`${line}\n`);
    });
  const sockets = new Set();
  const track = socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  const overBudget = () => stats.bytesUp + stats.bytesDown >= options.maxBytes;

  const server = createServer(client => {
    track(client);
    let head = Buffer.alloc(0);
    const onData = async chunk => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) {
        if (head.length > 8192) client.destroy();
        return;
      }
      client.off("data", onData);
      // 解析与连接上游期间先暂停，客户端这时发来的数据留在缓冲里，等隧道建好再一起转发。
      client.pause();
      const requestLine = head.subarray(0, head.indexOf("\r\n")).toString("latin1");
      const rest = head.subarray(end + 4);
      const deny = (status, reason, host = null, port = null) => {
        record({ host, port, decision: "deny", reason });
        client.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
      };
      const target = parseConnectLine(requestLine);
      if (!target) return deny("405 Method Not Allowed", "not_connect");
      const { host, port } = target;
      const decision = decideTarget(host, port, options.allow);
      if (!decision.allowed) return deny("403 Forbidden", decision.reason, host, port);
      // 先占位再解析：并发请求不能在解析期间一起越过连接数上限。
      if (stats.connections + reserved >= options.maxConnections) return deny("429 Too Many Requests", "connection_limit", host, port);
      if (overBudget()) return deny("429 Too Many Requests", "byte_limit", host, port);
      reserved += 1;
      let resolved;
      try {
        resolved = chooseAddress(await lookup(host), blockList);
      } catch {
        reserved -= 1;
        return deny("502 Bad Gateway", "dns_failed", host, port);
      }
      reserved -= 1;
      if (!resolved.address) return deny("403 Forbidden", resolved.reason, host, port);
      stats.connections += 1;
      const upstream = connectUpstream({ host: resolved.address, port });
      track(upstream);
      let up = 0;
      let down = 0;
      let established = false;
      let failure = null;
      const account = (direction, data) => {
        if (direction === "up") {
          up += data.length;
          stats.bytesUp += data.length;
        } else {
          down += data.length;
          stats.bytesDown += data.length;
        }
        if (overBudget()) {
          failure = "byte_limit";
          client.destroy();
          upstream.destroy();
        }
      };
      upstream.once("connect", () => {
        established = true;
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length > 0) {
          account("up", rest);
          upstream.write(rest);
        }
        client.on("data", data => account("up", data));
        upstream.on("data", data => account("down", data));
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
      });
      upstream.once("error", error => {
        failure = failure ?? `upstream_error:${error.code ?? "unknown"}`;
        if (established) client.destroy();
        else client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      });
      client.once("error", () => upstream.destroy());
      upstream.once("close", () => {
        client.destroy();
        const ok = established && failure === null;
        record({ host, port, address: resolved.address, decision: ok ? "allow" : "error", reason: failure ?? "closed", bytesUp: up, bytesDown: down });
      });
    };
    client.on("data", onData);
    client.once("error", () => client.destroy());
  });
  const [host, port] = options.listen.split(":");
  server.listen(Number(port), host, () => record({ decision: "listening", reason: options.listen, allow: options.allow }));
  const shutdown = () => {
    record({ decision: "summary", reason: "shutdown", ...stats });
    server.close();
    for (const socket of sockets) socket.destroy();
  };
  return { server, stats, shutdown };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const proxy = startProxy(parseArgs(process.argv.slice(2)));
    // 收到 SIGTERM 就记汇总、断开所有连接并退出：server.close() 会一直等还开着的隧道，VM 关机后可能永远等不到。
    process.on("SIGTERM", () => {
      proxy.shutdown();
      process.exit(0);
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
