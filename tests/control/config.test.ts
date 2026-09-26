import { describe, expect, it } from "vitest";
import {
  CONTROL_DEFAULTS,
  CONTROL_ENV,
  ControlConfigError,
  createControlConfig,
  createDeploymentConfig,
  DEPLOYMENT_DEFAULTS,
  FORBIDDEN_SECRET_ENV,
  isLoopbackHost,
  loadControlConfig,
  probeAddress,
} from "../../app/control/src/config.js";

function errorOf(run: () => unknown): ControlConfigError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ControlConfigError);
    return error as ControlConfigError;
  }
  throw new Error("预期抛出 ControlConfigError，实际没有抛出");
}

describe("control 配置", () => {
  it("产品默认值：轮询 60 秒、静默 300 秒、第 5 天提醒、第 7 天关闭、最多追问 2 轮、VM 1 vCPU / 2 GiB、备份 7 日 4 周、UTC 3 点", () => {
    expect(createControlConfig({})).toEqual({
      pollIntervalSeconds: 60,
      quietWindowSeconds: 300,
      remindAfterDays: 5,
      closeAfterDays: 7,
      maxFollowUpRounds: 2,
      vmVcpus: 1,
      vmMemoryMiB: 2048,
      backupKeepDaily: 7,
      backupKeepWeekly: 4,
      backupHourUtc: 3,
    });
    expect(createControlConfig()).toEqual(CONTROL_DEFAULTS);
    expect(Object.isFrozen(CONTROL_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(createControlConfig({}))).toBe(true);
  });

  it("环境变量名都带 GEEK_BOT_ 前缀，且与配置项一一对应", () => {
    expect(Object.keys(CONTROL_ENV).sort()).toEqual(Object.keys(CONTROL_DEFAULTS).sort());
    const names = Object.values(CONTROL_ENV);
    for (const name of names) expect(name).toMatch(/^GEEK_BOT_[A-Z0-9_]+$/);
    expect(new Set(names).size).toBe(names.length);
  });

  it("从环境变量覆盖默认值，首尾空白忽略，留空按未设置处理", () => {
    const config = createControlConfig({
      GEEK_BOT_POLL_INTERVAL_SECONDS: "120",
      GEEK_BOT_QUIET_WINDOW_SECONDS: "0",
      GEEK_BOT_REMIND_AFTER_DAYS: " 3 ",
      GEEK_BOT_CLOSE_AFTER_DAYS: "10",
      GEEK_BOT_MAX_FOLLOWUP_ROUNDS: "0",
      GEEK_BOT_VM_VCPUS: "2",
      GEEK_BOT_VM_MEMORY_MIB: "",
      GEEK_BOT_BACKUP_KEEP_DAILY: "3",
      GEEK_BOT_BACKUP_KEEP_WEEKLY: "0",
      GEEK_BOT_BACKUP_HOUR_UTC: "23",
    });
    expect(config).toEqual({
      pollIntervalSeconds: 120,
      quietWindowSeconds: 0,
      remindAfterDays: 3,
      closeAfterDays: 10,
      maxFollowUpRounds: 0,
      vmVcpus: 2,
      vmMemoryMiB: 2048,
      backupKeepDaily: 3,
      backupKeepWeekly: 0,
      backupHourUtc: 23,
    });
  });

  it("非整数、负数、小数、带单位和低于下限的值都拒绝，并给出中文原因", () => {
    for (const value of ["abc", "-1", "1.5", "60s", "1e3", "0x10"]) {
      const error = errorOf(() => createControlConfig({ GEEK_BOT_POLL_INTERVAL_SECONDS: value }));
      expect(error.problems).toHaveLength(1);
      expect(error.problems[0]).toContain("GEEK_BOT_POLL_INTERVAL_SECONDS 必须是不小于 1 的整数");
    }
    expect(() => createControlConfig({ GEEK_BOT_POLL_INTERVAL_SECONDS: "0" })).toThrow("不小于 1 的整数");
    expect(() => createControlConfig({ GEEK_BOT_VM_VCPUS: "0" })).toThrow("GEEK_BOT_VM_VCPUS");
    expect(() => createControlConfig({ GEEK_BOT_VM_MEMORY_MIB: "2" })).toThrow("不小于 512 的整数");
    expect(() => createControlConfig({ GEEK_BOT_QUIET_WINDOW_SECONDS: "-5" })).toThrow("必须是非负整数");
    expect(() => createControlConfig({ GEEK_BOT_MAX_FOLLOWUP_ROUNDS: "two" })).toThrow("必须是非负整数");
    expect(() => createControlConfig({ GEEK_BOT_BACKUP_KEEP_DAILY: "0" })).toThrow("GEEK_BOT_BACKUP_KEEP_DAILY 必须是不小于 1 的整数");
    expect(() => createControlConfig({ GEEK_BOT_BACKUP_HOUR_UTC: "24" })).toThrow("GEEK_BOT_BACKUP_HOUR_UTC 必须是 0 到 23 之间的整数");
  });

  it("关闭天数必须大于提醒天数", () => {
    expect(() => createControlConfig({ GEEK_BOT_CLOSE_AFTER_DAYS: "5" })).toThrow("关闭天数必须大于提醒天数");
    expect(() => createControlConfig({ GEEK_BOT_REMIND_AFTER_DAYS: "8" })).toThrow("关闭天数必须大于提醒天数");
    expect(createControlConfig({ GEEK_BOT_REMIND_AFTER_DAYS: "6" }).closeAfterDays).toBe(7);
  });

  it("一次列出全部问题；单项不合法时不再追加误导的先后比较", () => {
    const error = errorOf(() =>
      createControlConfig({ GEEK_BOT_POLL_INTERVAL_SECONDS: "x", GEEK_BOT_VM_VCPUS: "0", GEEK_BOT_REMIND_AFTER_DAYS: "soon", GEEK_BOT_CLOSE_AFTER_DAYS: "3" }),
    );
    expect(error.problems).toHaveLength(3);
    expect(error.message).toContain("control 配置不合法");
    expect(error.problems.some(problem => problem.includes("关闭天数必须大于提醒天数"))).toBe(false);
  });
});

describe("control 部署配置", () => {
  const base = { GEEK_BOT_INSTANCE_ROLE: "preview" };

  function deploymentErrorOf(env: Record<string, string>): ControlConfigError {
    return errorOf(() => createDeploymentConfig(env, "/srv/geek-bot"));
  }

  it("默认只绑回环地址，库在 /data，密钥文件在 /run/secrets；备份与本地通道放在库所在目录下", () => {
    const config = createDeploymentConfig(base, "/srv/geek-bot");
    expect(config).toMatchObject({
      instanceRole: "preview",
      host: "127.0.0.1",
      port: 8080,
      publicOrigin: null,
      allowPlaintextMesh: false,
      dbPath: "/data/geek-bot.db",
      dataDir: "/data",
      backupDir: "/data/backups",
      runDir: "/data/run",
      masterKeyFile: "/run/secrets/master_key",
      backupKeyFile: "/run/secrets/backup_key",
      logLevel: "info",
      appVersion: "local",
    });
    expect(DEPLOYMENT_DEFAULTS.host).toBe("127.0.0.1");
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("实例角色必须显式配置，只能是 preview 或 production（B-64）", () => {
    expect(deploymentErrorOf({}).problems).toEqual(["GEEK_BOT_INSTANCE_ROLE 必须显式配置为 preview 或 production，没有默认值"]);
    expect(deploymentErrorOf({ GEEK_BOT_INSTANCE_ROLE: "staging" }).message).toContain("GEEK_BOT_INSTANCE_ROLE 只能是 preview 或 production");
    expect(createDeploymentConfig({ GEEK_BOT_INSTANCE_ROLE: "production" }).instanceRole).toBe("production");
  });

  it("绑定非回环地址时必须配置 GEEK_BOT_PUBLIC_ORIGIN；origin 不是 https 时还要显式开启明文模式（S-20）", () => {
    expect(deploymentErrorOf({ ...base, GEEK_BOT_HOST: "0.0.0.0" }).message).toContain("绑定非回环地址时必须配置 GEEK_BOT_PUBLIC_ORIGIN");
    expect(deploymentErrorOf({ ...base, GEEK_BOT_HOST: "203.0.113.10", GEEK_BOT_PUBLIC_ORIGIN: "http://geek-bot.example.com" }).message).toContain(
      "GEEK_BOT_ALLOW_PLAINTEXT_MESH=true",
    );
    const https = createDeploymentConfig({ ...base, GEEK_BOT_HOST: "0.0.0.0", GEEK_BOT_PUBLIC_ORIGIN: "https://geek-bot.example.com/" });
    expect(https.publicOrigin).toBe("https://geek-bot.example.com");
    const mesh = createDeploymentConfig({
      ...base,
      GEEK_BOT_HOST: "203.0.113.10",
      GEEK_BOT_PUBLIC_ORIGIN: "http://geek-bot.example.com:8080",
      GEEK_BOT_ALLOW_PLAINTEXT_MESH: "true",
    });
    expect(mesh).toMatchObject({ allowPlaintextMesh: true, publicOrigin: "http://geek-bot.example.com:8080" });
    for (const host of ["127.0.0.1", "127.0.0.53", "localhost", "::1", "[::1]"]) {
      expect(isLoopbackHost(host)).toBe(true);
      expect(createDeploymentConfig({ ...base, GEEK_BOT_HOST: host }).host).toBe(host);
    }
    for (const host of ["0.0.0.0", "::", "203.0.113.10", "geek-bot.example.com"]) expect(isLoopbackHost(host)).toBe(false);
  });

  it("origin 只能是 http(s)://主机[:端口]：带路径、查询串、用户信息或别的协议都拒绝", () => {
    for (const origin of ["https://geek-bot.example.com/console", "https://geek-bot.example.com/?a=1", "https://user@geek-bot.example.com", "ftp://geek-bot.example.com", "geek-bot.example.com", "https://geek-bot.example.com#x"]) {
      expect(deploymentErrorOf({ ...base, GEEK_BOT_PUBLIC_ORIGIN: origin }).message).toContain("GEEK_BOT_PUBLIC_ORIGIN");
    }
  });

  it("密钥只从 *_FILE 读：直接写值的密钥变量拒绝启动，报错不回显值", () => {
    const value = "c2VjcmV0LXZhbHVlLXRoYXQtbXVzdC1ub3QtbGVhaw==";
    const error = deploymentErrorOf({ ...base, GEEK_BOT_MASTER_KEY: value, GEEK_BOT_BACKUP_KEY: value });
    expect(error.problems).toEqual([
      "GEEK_BOT_MASTER_KEY 不接受直接写值：密钥只能以文件提供，改用 GEEK_BOT_MASTER_KEY_FILE 指向密钥文件",
      "GEEK_BOT_BACKUP_KEY 不接受直接写值：密钥只能以文件提供，改用 GEEK_BOT_BACKUP_KEY_FILE 指向密钥文件",
    ]);
    expect(error.message).not.toContain(value);
    expect(FORBIDDEN_SECRET_ENV).toEqual(["GEEK_BOT_MASTER_KEY", "GEEK_BOT_BACKUP_KEY"]);
  });

  it("master key 与备份加密密钥不能指向同一个文件", () => {
    expect(deploymentErrorOf({ ...base, GEEK_BOT_MASTER_KEY_FILE: "/run/secrets/key", GEEK_BOT_BACKUP_KEY_FILE: "/run/secrets/key" }).message).toContain(
      "必须是两把不同的密钥",
    );
  });

  it("相对路径按传入的目录解析；端口、日志级别、镜像版本、开关值不合法时一次列出", () => {
    const config = createDeploymentConfig({ ...base, GEEK_BOT_DB_PATH: "./data/geek-bot.db", GEEK_BOT_MASTER_KEY_FILE: "keys/master" }, "/srv/geek-bot");
    expect(config).toMatchObject({ dbPath: "/srv/geek-bot/data/geek-bot.db", backupDir: "/srv/geek-bot/data/backups", masterKeyFile: "/srv/geek-bot/keys/master" });
    const error = deploymentErrorOf({
      ...base,
      GEEK_BOT_PORT: "70000",
      GEEK_BOT_LOG_LEVEL: "verbose",
      GEEK_BOT_APP_VERSION: "v1 with space",
      GEEK_BOT_ALLOW_PLAINTEXT_MESH: "yes",
      GEEK_BOT_HOST: "bad host",
    });
    expect(error.problems).toHaveLength(5);
    expect(createDeploymentConfig({ ...base, GEEK_BOT_APP_VERSION: "v0.2.0-rc.1", GEEK_BOT_PORT: "18080", GEEK_BOT_LOG_LEVEL: "warn" })).toMatchObject({
      appVersion: "v0.2.0-rc.1",
      port: 18080,
      logLevel: "warn",
    });
  });

  it("loadControlConfig 把产品默认值与部署配置的问题合在一起报", () => {
    const error = errorOf(() => loadControlConfig({ GEEK_BOT_POLL_INTERVAL_SECONDS: "x" }, "/srv"));
    expect(error.problems).toHaveLength(2);
    expect(loadControlConfig(base, "/srv").behavior).toEqual(CONTROL_DEFAULTS);
  });

  it("健康检查探针连的地址：通配地址换成回环地址", () => {
    expect(probeAddress({})).toEqual({ host: "127.0.0.1", port: 8080 });
    expect(probeAddress({ GEEK_BOT_HOST: "0.0.0.0", GEEK_BOT_PORT: "9000" })).toEqual({ host: "127.0.0.1", port: 9000 });
    expect(probeAddress({ GEEK_BOT_HOST: "::" })).toEqual({ host: "::1", port: 8080 });
    expect(probeAddress({ GEEK_BOT_HOST: "203.0.113.10" })).toEqual({ host: "203.0.113.10", port: 8080 });
  });
});
