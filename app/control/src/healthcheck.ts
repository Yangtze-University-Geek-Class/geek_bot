/**
 * 镜像 HEALTHCHECK 的探针：在容器里请求本进程的 GET /readyz，200 以 0 退出，其它（503、连不上、超时）以 1 退出。
 * 只读监听地址与端口（通配地址换成回环地址），不打印响应内容。镜像里没有 curl，所以用 Node 自带的 http。
 */
import { request } from "node:http";
import { probeAddress } from "./config.js";

const TIMEOUT_MS = 4000;

const { host, port } = probeAddress(process.env);
const req = request({ host, port, path: "/readyz", method: "GET", timeout: TIMEOUT_MS }, res => {
  res.resume();
  process.exitCode = res.statusCode === 200 ? 0 : 1;
});
req.on("timeout", () => req.destroy(new Error("timeout")));
req.on("error", () => {
  process.exitCode = 1;
});
req.end();
