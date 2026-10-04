/**
 * VM 的出网 CONNECT 代理（每个 VM 任务一个，监听任务目录里的 unix socket，来宾经 guestfwd 连到它）。
 * 规则沿用 #12 实验代理（tests/integration/vm/egress-proxy.mjs）并补上实验时留下的缺口（SECURITY S-03、S-14）：
 *   - 只接受 CONNECT 到 443；目标必须是域名，直接写 IP 拒绝；GitHub 域名清单先于白名单拒绝；不在白名单拒绝；
 *   - 只解析一次；解析结果里只要有一个落在禁止地址段（私网、CGNAT、回环、链路本地、组播、保留、嵌入 IPv4 的 IPv6 写法、
 *     部署者追加的网段）就整体拒绝；只连接校验过的那个地址，不再重新解析（防 DNS 重绑定）；
 *   - SNI 绑定：隧道建立后先读客户端的 TLS ClientHello，SNI 必须与 CONNECT 的主机名一致（没有 SNI、不是 TLS 都拒绝），
 *     之后才连上游，防止在共享 CDN 上换 SNI 绕过白名单；
 *   - 连接数在解析前占位；总字节数逐块核对，超过就断开两端；
 *   - 记录只含主机名、端口、地址、字节数与决定，不记请求头和载荷；
 *   - 关闭时主动断开全部连接（VM 关机后还开着的隧道可能永远不关）。
 * 私网与保留地址段在运行时由数字拼出，仓库里不留地址字面量。
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, createServer, connect, isIP } from "node:net";
import type { Server, Socket } from "node:net";

const ip4 = (...octets: number[]): string => octets.join(".");
const ip6 = (...groups: string[]): string => groups.join(":");

export const FORBIDDEN_IPV4: readonly (readonly [string, number])[] = Object.freeze([
  [ip4(0, 0, 0, 0), 8],
  [ip4(10, 0, 0, 0), 8],
  [ip4(100, 64, 0, 0), 10],
  [ip4(127, 0, 0, 0), 8],
  [ip4(169, 254, 0, 0), 16],
  [ip4(172, 16, 0, 0), 12],
  [ip4(192, 0, 0, 0), 24],
  [ip4(192, 168, 0, 0), 16],
  [ip4(198, 18, 0, 0), 15],
  [ip4(224, 0, 0, 0), 4],
  [ip4(240, 0, 0, 0), 4],
] as const);

/** IPv4 映射（::ffff:0:0/96）与兼容（::/96）写法不放进 BlockList（Node 会拿 IPv4 去比这类规则），在 isForbiddenAddress 里单独判断。 */
export const FORBIDDEN_IPV6: readonly (readonly [string, number])[] = Object.freeze([
  [ip6("", "", ""), 128],
  [ip6("", "", "1"), 128],
  [ip6("fc00", "", ""), 7],
  [ip6("fe80", "", ""), 10],
  [ip6("64", "ff9b", "", ""), 96],
  [ip6("ff00", "", ""), 8],
  [ip6("64", "ff9b", "1", "", ""), 48],
  [ip6("2002", "", ""), 16],
  [ip6("2001", "", ""), 32],
] as const);

const IPV4_EMBEDDED_RE = /^::(?:ffff:)?(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]{1,4}:[0-9a-f]{1,4})$/i;

export const GITHUB_SUFFIXES = Object.freeze(["github.com", "githubusercontent.com", "ghcr.io", "github.io", "githubassets.com"]);

export function buildBlockList(extraCidrs: readonly string[] = []): BlockList {
  const list = new BlockList();
  for (const [address, prefix] of FORBIDDEN_IPV4) list.addSubnet(address, prefix, "ipv4");
  for (const [address, prefix] of FORBIDDEN_IPV6) list.addSubnet(address, prefix, "ipv6");
  for (const cidr of extraCidrs) {
    const [address, prefix] = cidr.split("/");
    list.addSubnet(address, Number(prefix), isIP(address) === 6 ? "ipv6" : "ipv4");
  }
  return list;
}

/** 地址是否落在禁止的地址段；不是合法 IP 的一律当作禁止。 */
export function isForbiddenAddress(address: string, blockList: BlockList = buildBlockList()): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  if (family === 6 && IPV4_EMBEDDED_RE.test(address)) return true;
  return blockList.check(address, family === 6 ? "ipv6" : "ipv4");
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, "");
}

export function matchesSuffix(host: string, suffixes: readonly string[]): boolean {
  const name = normalizeHost(host);
  return suffixes.some(suffix => name === suffix || name.endsWith(`.${suffix}`));
}

export function parseConnectLine(line: string): { host: string; port: number } | null {
  const match = /^CONNECT (?:\[([0-9a-f:.]+)\]|([^\s:[\]]+)):(\d{1,5}) HTTP\/1\.[01]$/i.exec(line);
  if (!match) return null;
  const port = Number(match[3]);
  if (port < 1 || port > 65535) return null;
  return { host: match[1] ?? match[2], port };
}

export function decideTarget(host: string, port: number, allowSuffixes: readonly string[]): { allowed: boolean; reason: string } {
  if (port !== 443) return { allowed: false, reason: "port_not_allowed" };
  if (isIP(host) !== 0) return { allowed: false, reason: "ip_literal" };
  if (!/^[a-z0-9.-]+$/i.test(host) || host.length > 253) return { allowed: false, reason: "invalid_host" };
  if (matchesSuffix(host, GITHUB_SUFFIXES)) return { allowed: false, reason: "github_denied" };
  if (!matchesSuffix(host, allowSuffixes)) return { allowed: false, reason: "not_in_allowlist" };
  return { allowed: true, reason: "allowlisted" };
}

export function chooseAddress(addresses: readonly { address: string; family: number }[], blockList: BlockList = buildBlockList()): { address: string | null; reason: string } {
  if (addresses.length === 0) return { address: null, reason: "no_address" };
  if (addresses.some(entry => isForbiddenAddress(entry.address, blockList))) return { address: null, reason: "resolved_to_forbidden_address" };
  const preferred = addresses.find(entry => entry.family === 4) ?? addresses[0];
  return { address: preferred.address, reason: "resolved" };
}

/**
 * 从 TLS 记录里取 ClientHello 的 SNI。返回值：
 *   { complete: false }                       数据还不够，继续读；
 *   { complete: true, sni: string | null }    解析完成（null 表示不是 TLS ClientHello 或没有 SNI）。
 * 只看第一个握手记录；ClientHello 跨多个记录时按「没有 SNI」处理（现实客户端的 ClientHello 都放在一个记录里）。
 */
export function parseClientHelloSni(data: Buffer): { complete: false } | { complete: true; sni: string | null } {
  if (data.length < 5) return { complete: false };
  if (data[0] !== 0x16 || data[1] !== 0x03) return { complete: true, sni: null };
  const recordLength = data.readUInt16BE(3);
  if (recordLength > 16_384 + 2_048) return { complete: true, sni: null };
  if (data.length < 5 + recordLength) return { complete: false };
  const record = data.subarray(5, 5 + recordLength);
  if (record.length < 4 || record[0] !== 0x01) return { complete: true, sni: null };
  const helloLength = record.readUIntBE(1, 3);
  if (helloLength + 4 > record.length) return { complete: true, sni: null };
  let offset = 4 + 2 + 32;
  const need = (bytes: number): boolean => offset + bytes <= 4 + helloLength;
  if (!need(1)) return { complete: true, sni: null };
  offset += 1 + record[offset];
  if (!need(2)) return { complete: true, sni: null };
  offset += 2 + record.readUInt16BE(offset);
  if (!need(1)) return { complete: true, sni: null };
  offset += 1 + record[offset];
  if (!need(2)) return { complete: true, sni: null };
  const extensionsEnd = offset + 2 + record.readUInt16BE(offset);
  offset += 2;
  if (extensionsEnd > 4 + helloLength) return { complete: true, sni: null };
  while (offset + 4 <= extensionsEnd) {
    const type = record.readUInt16BE(offset);
    const length = record.readUInt16BE(offset + 2);
    offset += 4;
    if (offset + length > extensionsEnd) return { complete: true, sni: null };
    if (type === 0x0000) {
      let cursor = offset + 2;
      const listEnd = offset + 2 + record.readUInt16BE(offset);
      while (cursor + 3 <= listEnd) {
        const nameType = record[cursor];
        const nameLength = record.readUInt16BE(cursor + 1);
        cursor += 3;
        if (cursor + nameLength > listEnd) return { complete: true, sni: null };
        if (nameType === 0) {
          const name = record.subarray(cursor, cursor + nameLength).toString("ascii");
          return { complete: true, sni: /^[a-z0-9.-]{1,253}$/i.test(name) ? name : null };
        }
        cursor += nameLength;
      }
      return { complete: true, sni: null };
    }
    offset += length;
  }
  return { complete: true, sni: null };
}

export interface EgressRecord {
  readonly host: string | null;
  readonly port: number | null;
  readonly decision: "allow" | "deny" | "error" | "summary";
  readonly reason: string;
  readonly address?: string;
  readonly bytesUp?: number;
  readonly bytesDown?: number;
}

export interface EgressProxyOptions {
  readonly socketPath: string;
  readonly allow: readonly string[];
  readonly denyCidrs: readonly string[];
  readonly maxConnections: number;
  readonly maxBytes: number;
  readonly record: (entry: EgressRecord) => void;
  /** 测试注入：代替 DNS 与上游连接。 */
  readonly lookup?: (host: string) => Promise<readonly { address: string; family: number }[]>;
  readonly connectUpstream?: (address: string, port: number) => Socket;
}

export interface EgressProxy {
  readonly stats: { connections: number; bytesUp: number; bytesDown: number };
  close(): void;
}

const HELLO_TIMEOUT_MS = 10_000;

/** 在 unix socket 上起代理；resolve 时已经在监听。 */
export function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
  const blockList = buildBlockList(options.denyCidrs);
  const lookup = options.lookup ?? (async (host: string) => dnsLookup(host, { all: true, verbatim: true }));
  const connectUpstream = options.connectUpstream ?? ((address: string, port: number) => connect({ host: address, port }));
  const stats = { connections: 0, bytesUp: 0, bytesDown: 0 };
  let reserved = 0;
  const sockets = new Set<Socket>();
  const track = (socket: Socket): void => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  const overBudget = (): boolean => stats.bytesUp + stats.bytesDown >= options.maxBytes;

  const server: Server = createServer(client => {
    track(client);
    client.once("error", () => client.destroy());
    let head = Buffer.alloc(0);
    const onHead = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) {
        if (head.length > 8_192) client.destroy();
        return;
      }
      client.off("data", onHead);
      client.pause();
      void tunnel(client, head.subarray(0, head.indexOf("\r\n")).toString("latin1"), head.subarray(end + 4));
    };
    client.on("data", onHead);
  });

  const tunnel = async (client: Socket, requestLine: string, rest: Buffer): Promise<void> => {
    const deny = (status: string, reason: string, host: string | null = null, port: number | null = null): void => {
      options.record({ host, port, decision: "deny", reason });
      client.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    };
    const target = parseConnectLine(requestLine);
    if (!target) return deny("405 Method Not Allowed", "not_connect");
    const { host, port } = target;
    const decision = decideTarget(host, port, options.allow);
    if (!decision.allowed) return deny("403 Forbidden", decision.reason, host, port);
    if (stats.connections + reserved >= options.maxConnections) return deny("429 Too Many Requests", "connection_limit", host, port);
    if (overBudget()) return deny("429 Too Many Requests", "byte_limit", host, port);
    reserved += 1;
    let resolved: { address: string | null; reason: string };
    try {
      resolved = chooseAddress(await lookup(host), blockList);
    } catch {
      reserved -= 1;
      return deny("502 Bad Gateway", "dns_failed", host, port);
    }
    reserved -= 1;
    if (!resolved.address || client.destroyed) return deny("403 Forbidden", resolved.address ? "client_gone" : resolved.reason, host, port);
    const address = resolved.address;
    stats.connections += 1;

    // 隧道建立，先读 ClientHello 核对 SNI，再连上游。
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    let hello = rest;
    const sni = await new Promise<string | null>(resolve => {
      const timer = setTimeout(() => finish(null), HELLO_TIMEOUT_MS);
      const finish = (value: string | null): void => {
        clearTimeout(timer);
        client.off("data", onData);
        client.off("close", onClose);
        client.pause();
        resolve(value);
      };
      const check = (): boolean => {
        const parsed = parseClientHelloSni(hello);
        if (!parsed.complete) {
          if (hello.length > 20_000) finish(null);
          return false;
        }
        finish(parsed.sni);
        return true;
      };
      const onData = (chunk: Buffer): void => {
        hello = Buffer.concat([hello, chunk]);
        check();
      };
      const onClose = (): void => finish(null);
      if (check()) return;
      client.on("data", onData);
      client.once("close", onClose);
      client.resume();
    });
    if (sni === null || normalizeHost(sni) !== normalizeHost(host)) {
      options.record({ host, port, address, decision: "deny", reason: sni === null ? "no_sni" : "sni_mismatch" });
      client.destroy();
      return;
    }

    const upstream = connectUpstream(address, port);
    track(upstream);
    let up = 0;
    let down = 0;
    let established = false;
    let failure: string | null = null;
    const account = (direction: "up" | "down", data: Buffer): void => {
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
      account("up", hello);
      upstream.write(hello);
      client.on("data", data => account("up", data));
      upstream.on("data", data => account("down", data));
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
    upstream.once("error", error => {
      failure = failure ?? `upstream_error:${"code" in error && typeof error.code === "string" ? error.code : "unknown"}`;
      client.destroy();
    });
    client.once("close", () => upstream.destroy());
    upstream.once("close", () => {
      client.destroy();
      options.record({ host, port, address, decision: established && failure === null ? "allow" : "error", reason: failure ?? "closed", bytesUp: up, bytesDown: down });
    });
  };

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => {
      server.off("error", reject);
      resolve({
        stats,
        close: () => {
          options.record({ host: null, port: null, decision: "summary", reason: "shutdown", bytesUp: stats.bytesUp, bytesDown: stats.bytesDown });
          server.close();
          for (const socket of sockets) socket.destroy();
        },
      });
    });
  });
}
