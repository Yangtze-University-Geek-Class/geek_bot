/**
 * 同源托管 console 的构建产物（ADR-0009）：只读 dist 目录里的普通文件，拒绝路径穿越、点文件与符号链接逃逸；
 * 前端路由回落到 index.html。带安全响应头：CSP 只允许同源脚本与连接、禁止被嵌入、nosniff、no-referrer。
 * 带 hash 的 assets/ 长期缓存，index.html 不缓存。
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, sep } from "node:path";
import type { FastifyReply } from "fastify";

const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

export const CONSOLE_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

export interface ConsoleAssets {
  /** dist 目录存在且有 index.html。 */
  readonly available: boolean;
  /** 按 URL 路径返回文件；没有对应文件且像前端路由时回落到 index.html；否则 null。 */
  serve(urlPath: string, reply: FastifyReply): FastifyReply | null;
}

export function createConsoleAssets(distDir: string): ConsoleAssets {
  const available = existsSync(join(distDir, "index.html"));
  const root = available ? realpathSync(distDir) : distDir;

  function resolveFile(urlPath: string): string | null {
    let decoded: string;
    try {
      decoded = decodeURIComponent(urlPath);
    } catch {
      return null;
    }
    if (decoded.includes("\0") || decoded.includes("\\")) return null;
    const parts = decoded.split("/").filter(Boolean);
    if (parts.some(part => part === ".." || part === "." || part.startsWith("."))) return null;
    const candidate = join(root, ...parts);
    try {
      const real = realpathSync(candidate);
      if (real !== root && !real.startsWith(root + sep)) return null;
      return statSync(real).isFile() ? real : null;
    } catch {
      return null;
    }
  }

  function send(reply: FastifyReply, file: string, immutable: boolean): FastifyReply {
    for (const [name, value] of Object.entries(CONSOLE_SECURITY_HEADERS)) reply.header(name, value);
    reply.header("Content-Type", MIME[extname(file).toLowerCase()] ?? "application/octet-stream");
    reply.header("Cache-Control", immutable ? "public, max-age=31536000, immutable" : "no-cache");
    return reply.code(200).send(readFileSync(file));
  }

  return {
    available,
    serve(urlPath, reply) {
      if (!available) return null;
      const path = urlPath.split("?", 1)[0] ?? "/";
      const file = path === "/" ? null : resolveFile(path);
      if (file) return send(reply, file, path.startsWith("/assets/"));
      // 带扩展名却找不到的是缺失的静态文件；其余按前端路由回落到 index.html。
      if (extname(path) !== "") return null;
      return send(reply, join(root, "index.html"), false);
    },
  };
}
