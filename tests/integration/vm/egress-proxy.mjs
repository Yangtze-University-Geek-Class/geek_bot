#!/usr/bin/env node
/**
 * #12 实验用的出网 CONNECT 代理：只用 Node 标准库，在实验容器里监听回环地址，VM 经 QEMU 的 guestfwd 连到它。
 * 规则按 docs/architecture/SECURITY.md 的 S-03（GitHub 域名清单默认拒绝）与 S-14（出网控制）：
 *
 *   - 只接受 CONNECT（HTTPS 隧道），普通 HTTP 请求一律 405；
 *   - 目标必须是域名：直接写 IP 的请求拒绝；
 *   - GitHub 域名清单按后缀拒绝，先于白名单判断；不在白名单里的域名拒绝；
 *   - 解析一次；解析结果里只要有一个落在禁止的地址段（私网、CGNAT、链路本地、回环、IPv6 回环、ULA、链路本地、
 *     IPv4 映射、NAT64 等）就整体拒绝；只连接校验过的那个地址，不再重新解析（防 DNS 重绑定）；
 *   - 限制连接数与总字节数，逐条记录决定（JSON 行）。
 *
 * 这是可行性实验的一部分，生产实现随 #17 写进 app/node。私网地址段在运行时由数字拼出，仓库里不留字面量（TESTING「隔离」）。
 *
 *   node egress-proxy.mjs --listen 127.0.0.1:3128 --allow registry.npmjs.org,deb.debian.org [--log proxy.jsonl]
 *                         [--max-connections 2000] [--max-bytes 4294967296]
 */
import { createServer, BlockList, connect, isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ip4 = (...octets) => octets.join(".");

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

/** S-14 禁止的 IPv6 地址段。 */
export const FORBIDDEN_IPV6 = Object.freeze([
  ["::", 128], // 未指定地址
  ["::1", 128], // 回环
  ["fc00::", 7], // ULA
  ["fe80::", 10], // 链路本地
  // IPv4 映射地址（::ffff:0:0/96）不放进 BlockList：Node 的 BlockList 会拿 IPv4 地址去比 IPv4 映射规则，
  // 加了这条就会拒绝全部 IPv4。它在 isForbiddenAddress 里单独判断。
  ["64:ff9b::", 96], // NAT64
  ["ff00::", 8], // 组播
]);

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

/** IPv4 映射地址（`::ffff:a.b.c.d` 或 `::ffff:xxxx:xxxx`）：S-14 一律拒绝。 */
const IPV4_MAPPED_RE = /^::ffff:(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]{1,4}:[0-9a-f]{1,4})$/i;

/** 地址是否落在禁止的地址段；不是合法 IP 的一律当作禁止。 */
export function isForbiddenAddress(address, blockList = buildBlockList()) {
  const family = isIP(address);
  if (family === 0) return true;
  if (family === 6 && IPV4_MAPPED_RE.test(address)) return true;
  return blockList.check(address, family === 6 ? "ipv6" : "ipv4");
}

/** host 是否等于某个后缀，或是它的子域。比较前去掉末尾的点并转小写。 */
export function matchesSuffix(host, suffixes) {
  const name = host.toLowerCase().replace(/\.$/, "");
  return suffixes.some(suffix => name === suffix || name.endsWith(`.${suffix}`));
}

/**
 * 解析之前的判断：{ allowed: boolean, reason: string }。
 * 顺序：IP 字面量 → GitHub 清单 → 白名单。端口只放 443。
 */
export function decideTarget(host, port, allowSuffixes) {
  if (port !== 443) return { allowed: false, reason: "port_not_allowed" };
  const bare = host.replace(/^\[|\]$/g, "");
  if (isIP(bare) !== 0) return { allowed: false, reason: "ip_literal" };
  if (!/^[a-z0-9.-]+$/i.test(bare) || bare.length > 253) return { allowed: false, reason: "invalid_host" };
  if (matchesSuffix(bare, GITHUB_SUFFIXES)) return { allowed: false, reason: "github_denied" };
  if (!matchesSuffix(bare, allowSuffixes)) return { allowed: false, reason: "not_in_allowlist" };
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

function parseArgs(argv) {
  const options = { listen: "127.0.0.1:3128", allow: [], log: null, maxConnections: 2000, maxBytes: 4 * 1024 ** 3, denyCidr: [] };
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (value === undefined) throw new Error(`参数缺值：${flag}`);
    if (flag === "--listen") options.listen = value;
    else if (flag === "--allow") options.allow = value.split(",").filter(Boolean);
    else if (flag === "--log") options.log = value;
    else if (flag === "--max-connections") options.maxConnections = Number(value);
    else if (flag === "--max-bytes") options.maxBytes = Number(value);
    else if (flag === "--deny-cidr") options.denyCidr = value.split(",").filter(Boolean);
    else throw new Error(`不认识的参数：${flag}`);
  }
  return options;
}

export function startProxy(options) {
  const blockList = buildBlockList(options.denyCidr);
  const stats = { connections: 0, bytesUp: 0, bytesDown: 0 };
  const record = entry => {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    if (options.log) appendFileSync(options.log, `${line}\n`);
    else process.stdout.write(`${line}\n`);
  };
  const sockets = new Set();
  const track = socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
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
      const requestLine = head.subarray(0, head.indexOf("\r\n")).toString("latin1");
      const rest = head.subarray(end + 4);
      const match = /^CONNECT (\[[0-9a-f:.]+\]|[^\s:]+):(\d+) HTTP\/1\.[01]$/i.exec(requestLine);
      const deny = (status, reason, host = null, port = null) => {
        record({ host, port, decision: "deny", reason });
        client.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
      };
      if (!match) return deny("405 Method Not Allowed", "not_connect");
      const host = match[1];
      const port = Number(match[2]);
      const decision = decideTarget(host, port, options.allow);
      if (!decision.allowed) return deny("403 Forbidden", decision.reason, host, port);
      if (stats.connections >= options.maxConnections) return deny("429 Too Many Requests", "connection_limit", host, port);
      if (stats.bytesUp + stats.bytesDown >= options.maxBytes) return deny("429 Too Many Requests", "byte_limit", host, port);
      let resolved;
      try {
        resolved = chooseAddress(await lookup(host, { all: true, verbatim: true }), blockList);
      } catch {
        return deny("502 Bad Gateway", "dns_failed", host, port);
      }
      if (!resolved.address) return deny("403 Forbidden", resolved.reason, host, port);
      stats.connections += 1;
      const upstream = connect({ host: resolved.address, port });
      track(upstream);
      let up = 0;
      let down = 0;
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length > 0) upstream.write(rest);
        client.on("data", data => {
          up += data.length;
          stats.bytesUp += data.length;
        });
        upstream.on("data", data => {
          down += data.length;
          stats.bytesDown += data.length;
        });
        client.pipe(upstream);
        upstream.pipe(client);
      });
      const finish = reason => {
        record({ host, port, address: resolved.address, decision: "allow", reason, bytesUp: up, bytesDown: down });
      };
      upstream.once("error", () => {
        client.destroy();
      });
      client.once("error", () => upstream.destroy());
      upstream.once("close", () => {
        client.destroy();
        finish("closed");
      });
    };
    client.on("data", onData);
    client.once("error", () => client.destroy());
  });
  const [host, port] = options.listen.split(":");
  server.listen(Number(port), host, () => record({ decision: "listening", reason: options.listen, allow: options.allow }));
  // 收到 SIGTERM 就记汇总、断开所有连接并退出：server.close() 会一直等还开着的隧道，VM 关机后可能永远等不到。
  process.on("SIGTERM", () => {
    record({ decision: "summary", reason: "sigterm", ...stats });
    server.close();
    for (const socket of sockets) socket.destroy();
    process.exit(0);
  });
  return { server, stats };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    startProxy(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
