-- geek-bot-migration shrink=false
-- 0001：库版本记录、设置与 API 记录、告警、审计、备份登记（data-model 表清单里标 #3 的 7 张表）。
-- 迁移规则见 docs/services/control/data-model.md「迁移规则」：本文件进入 stage 后不再修改，写错了就再写一个新的迁移。
-- 迁移器在一个事务里执行本文件、写 schema_migrations 并设 PRAGMA user_version；文件里不写 BEGIN、COMMIT。

-- 已应用的迁移，一个文件一行。库当前的兼容版本是编号最大那一行的 compat_version。
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  shrink INTEGER NOT NULL CHECK (shrink IN (0, 1)),
  compat_version INTEGER NOT NULL,
  app_version TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

-- 后台「设置」保存的全局值与暂停开关；删行即恢复默认。
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_by INTEGER,
  updated_at INTEGER NOT NULL
);

-- 配置类资源的版本号（ETag / If-Match）。
CREATE TABLE revisions (
  scope TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 创建类请求的幂等记录，24 小时后删除。
CREATE TABLE idempotency_keys (
  github_id INTEGER NOT NULL,
  route TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status INTEGER NOT NULL,
  response_json TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (github_id, route, key)
);

-- 告警：同一件事只有一条未解决的告警，重复发生只加计数。
CREATE TABLE alerts (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  count INTEGER NOT NULL,
  acked_by INTEGER,
  acked_at INTEGER,
  resolved_at INTEGER
);
CREATE UNIQUE INDEX alerts_open_kind_subject ON alerts (kind, subject) WHERE resolved_at IS NULL;

-- 审计记录，只追加（SECURITY S-16）：更新和删除都被触发器拒绝。
CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'bot', 'system', 'node', 'cli')),
  actor_id TEXT,
  action TEXT NOT NULL,
  code TEXT,
  target TEXT,
  detail_json TEXT,
  reauth INTEGER NOT NULL CHECK (reauth IN (0, 1))
);
CREATE INDEX audit_logs_at ON audit_logs (at);
CREATE INDEX audit_logs_action ON audit_logs (action);
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs 只追加，不能修改已有记录');
END;
CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs 只追加，不能删除已有记录');
END;

-- 备份文件登记与恢复校验结果。备份完成后才写这一行，所以一份备份里不含它自己的登记。
CREATE TABLE backups (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('daily', 'weekly', 'pre_deploy', 'pre_migration', 'manual')),
  file TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  compat_version INTEGER NOT NULL,
  app_version TEXT NOT NULL,
  backup_key_id TEXT NOT NULL,
  row_counts_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  verified_at INTEGER,
  verify_result TEXT CHECK (verify_result IN ('ok', 'failed')),
  verify_detail TEXT,
  pruned_at INTEGER
);
