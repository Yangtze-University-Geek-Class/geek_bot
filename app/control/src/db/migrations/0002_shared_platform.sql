-- geek-bot-migration shrink=false
-- 0002：单实例共享平台（#34）。管理员与会话、认领码、device flow、平台连接与加密凭据、项目、条目、需求、
-- IM 入站事件去重、机器、任务与租约、任务事件、模型中继用量、publisher 的持久 outbox。
-- 时间一律是毫秒级 UNIX 时间（INTEGER），与 0001 相同；JSON 列以 _json 结尾。
-- 密文列（*_ct）只由 control 的 master key 加解密；哈希列（*_hash）是 SHA-256 十六进制，原值不入库。
-- 本文件进入 stage 后不再修改；迁移器在一个事务里执行它，文件里不写 BEGIN、COMMIT。

-- 后台管理员，按 GitHub 数字 id 识别（S-09）。owner 只有一个，由认领产生。
CREATE TABLE admins (
  github_id INTEGER PRIMARY KEY,
  login TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'operator', 'viewer')),
  note TEXT,
  invited_by INTEGER,
  invited_at INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE UNIQUE INDEX admins_single_owner ON admins (role) WHERE role = 'owner';

-- 一次性认领码（S-10）：只存哈希；再次生成作废旧码；连续输错 5 次作废。
CREATE TABLE bootstrap_codes (
  id INTEGER PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER,
  used_at INTEGER
);

-- 认领码通过后的 gb_claim 票据：15 分钟内只允许发起认领用的 device flow。
CREATE TABLE claim_grants (
  token_hash TEXT PRIMARY KEY,
  code_id INTEGER NOT NULL REFERENCES bootstrap_codes (id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- 后台会话：只存 256 位随机 sid 的哈希；空闲 2 小时、最长 12 小时（S-09）。
CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  github_id INTEGER NOT NULL REFERENCES admins (github_id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  reauth_at INTEGER
);
CREATE INDEX sessions_github_id ON sessions (github_id);

-- GitHub device flow（认领、登录、重新认证、绑定 GitHub 连接）。device_code 以 master key 加密，只留在 control；
-- browser_hash 是 gb_flow cookie 随机值的哈希，别的浏览器拿到 flow_id 也用不了。
CREATE TABLE oauth_flows (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('claim', 'login', 'reauth', 'connection')),
  browser_hash TEXT NOT NULL,
  session_hash TEXT,
  claim_hash TEXT,
  connection_id TEXT REFERENCES connections (id) ON DELETE CASCADE,
  device_code_ct TEXT NOT NULL,
  user_code TEXT NOT NULL,
  verification_uri TEXT NOT NULL,
  interval_s INTEGER NOT NULL,
  next_poll_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'expired', 'denied', 'done', 'failed')),
  result_github_id INTEGER,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX oauth_flows_expires ON oauth_flows (expires_at);

-- 平台连接：GitHub、GitLab 代码平台，Feishu 与通用签名 webhook IM。公共字段见 protocol ConnectionRecord。
CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab', 'feishu', 'webhook')),
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  status TEXT NOT NULL,
  account_name TEXT,
  account_external_id TEXT,
  scopes TEXT,
  capabilities_json TEXT NOT NULL,
  last_error TEXT,
  last_synced_at INTEGER,
  revision INTEGER NOT NULL,
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX connections_name ON connections (name);

-- 连接凭据：整组凭据 JSON 的 AES-256-GCM 密文（connectors 的 sealCredentials 生成），只在 connectors 与 publisher 解密。
CREATE TABLE connection_credentials (
  connection_id TEXT PRIMARY KEY REFERENCES connections (id) ON DELETE CASCADE,
  credentials_ct TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1
);

-- 项目：代码平台上发现的仓库，id 由连接 id 与平台数字 id 稳定派生。发现不到的记为 lost；已归档不能写。
-- 四个开关逐类显式授权平台条目上的任务（自动入队与条目派发）；新项目全部关闭，打开只归 owner 并要求重新认证。
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections (id),
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  url TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  private INTEGER NOT NULL CHECK (private IN (0, 1)),
  archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
  permission TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'lost')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  write_mode TEXT NOT NULL CHECK (write_mode IN ('off', 'dry_run', 'on')),
  review_enabled INTEGER NOT NULL DEFAULT 0 CHECK (review_enabled IN (0, 1)),
  triage_enabled INTEGER NOT NULL DEFAULT 0 CHECK (triage_enabled IN (0, 1)),
  fix_enabled INTEGER NOT NULL DEFAULT 0 CHECK (fix_enabled IN (0, 1)),
  rework_enabled INTEGER NOT NULL DEFAULT 0 CHECK (rework_enabled IN (0, 1)),
  machine_ids_json TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  last_synced_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (connection_id, external_id)
);
CREATE INDEX projects_path ON projects (path, id);

-- 条目：issue 与变更（GitHub PR、GitLab MR 统一为 change，origin 保留来源类型）。
-- bot_authored 是同步时适配器按平台账号数字 id（不是用户名）判定的「由连接绑定的机器人账号发起」。
CREATE TABLE items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  external_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('issue', 'change')),
  origin TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  url TEXT NOT NULL,
  state TEXT NOT NULL,
  author TEXT NOT NULL,
  bot_authored INTEGER NOT NULL DEFAULT 0 CHECK (bot_authored IN (0, 1)),
  head_sha TEXT,
  base_sha TEXT,
  head_ref TEXT,
  base_ref TEXT,
  labels_json TEXT NOT NULL DEFAULT '[]',
  assignees_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL,
  synced_at INTEGER NOT NULL,
  UNIQUE (project_id, kind, external_id)
);
CREATE INDEX items_project_updated ON items (project_id, updated_at, id);

-- 需求：手工创建或 IM/平台入站；先入站再关联项目，未关联项目不能派发。
-- 代码平台来源（github、gitlab）的需求由 control 按条目生成：item_id 唯一，source_ref 是条目 id，项目固定。
CREATE TABLE demands (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  project_id TEXT REFERENCES projects (id),
  source TEXT NOT NULL CHECK (source IN ('manual', 'github', 'gitlab', 'feishu', 'webhook')),
  source_ref TEXT NOT NULL,
  source_connection_id TEXT REFERENCES connections (id),
  item_id TEXT REFERENCES items (id),
  status TEXT NOT NULL CHECK (status IN ('new', 'blocked', 'queued', 'running', 'completed', 'failed')),
  revision INTEGER NOT NULL,
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((item_id IS NOT NULL) = (source IN ('github', 'gitlab'))),
  CHECK (item_id IS NULL OR project_id IS NOT NULL)
);
CREATE INDEX demands_created ON demands (created_at, id);
CREATE UNIQUE INDEX demands_item ON demands (item_id) WHERE item_id IS NOT NULL;

-- IM 入站事件去重：同一连接的同一事件 id 只产生一个需求。
CREATE TABLE intake_events (
  connection_id TEXT NOT NULL REFERENCES connections (id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  demand_id TEXT REFERENCES demands (id),
  received_at INTEGER NOT NULL,
  PRIMARY KEY (connection_id, event_id)
);

-- 机器：全局共享执行池。节点令牌只存哈希；boot_id 变化时对账回收租约。
CREATE TABLE machines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'cordoned', 'ready', 'draining', 'offline', 'disabled')),
  trust TEXT NOT NULL CHECK (trust IN ('standard', 'high')),
  tags_json TEXT NOT NULL,
  slots_sandbox INTEGER NOT NULL,
  slots_vm INTEGER NOT NULL,
  capacity_cpu INTEGER NOT NULL,
  capacity_memory_mib INTEGER NOT NULL,
  declared_json TEXT,
  protocol_version INTEGER,
  boot_id TEXT,
  heartbeat_seq INTEGER,
  health_json TEXT,
  health_gate_json TEXT,
  token_hash TEXT UNIQUE,
  last_seen_at INTEGER,
  revision INTEGER NOT NULL,
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 任务与租约：一个任务同时最多一个租约（lease_id + epoch + machine_id）；结果每个租约只记一次。
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  demand_id TEXT REFERENCES demands (id),
  item_id TEXT REFERENCES items (id),
  kind TEXT NOT NULL CHECK (kind IN ('review', 'triage', 'followup', 'fix', 'rework')),
  executor TEXT NOT NULL CHECK (executor IN ('sandbox', 'vm')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'awaiting_publish', 'completed', 'failed', 'cancelled', 'superseded')),
  priority INTEGER NOT NULL,
  cpu INTEGER NOT NULL,
  memory_mib INTEGER NOT NULL,
  required_tags_json TEXT NOT NULL,
  required_trust TEXT NOT NULL CHECK (required_trust IN ('standard', 'high')),
  machine_id TEXT REFERENCES machines (id),
  epoch INTEGER NOT NULL,
  lease_id TEXT UNIQUE,
  lease_expires_at INTEGER,
  lease_acked_at INTEGER,
  lease_request_key TEXT,
  model_token_hash TEXT UNIQUE,
  model_pool_json TEXT,
  token_budget INTEGER NOT NULL,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  request_budget INTEGER NOT NULL,
  requests_used INTEGER NOT NULL DEFAULT 0,
  timeout_s INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  tools_json TEXT NOT NULL,
  head_sha TEXT,
  base_sha TEXT,
  -- 平台条目任务创建时冻结的条目快照（编号、类型、标题、正文、状态、作者、head/base）与触发版本：
  -- change 是 head sha，issue 是标题与正文的哈希；同一条目、同一类型、同一版本只自动入队一次。
  item_snapshot_json TEXT,
  item_version TEXT,
  bundle_json TEXT,
  bundle_sha256 TEXT,
  result_json TEXT,
  result_lease_id TEXT,
  error TEXT,
  infra_failures INTEGER NOT NULL DEFAULT 0,
  excluded_machines_json TEXT NOT NULL,
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((item_id IS NULL) = (item_snapshot_json IS NULL))
);
CREATE INDEX tasks_queue ON tasks (status, priority DESC, created_at, id);
CREATE INDEX tasks_updated ON tasks (updated_at, id);
CREATE INDEX tasks_machine ON tasks (machine_id, status);
CREATE INDEX tasks_item ON tasks (item_id, kind, item_version);
CREATE INDEX tasks_project_status ON tasks (project_id, status);

-- 任务时间线：节点回传、已打码；按 (task_id, seq) 去重。
CREATE TABLE task_events (
  task_id TEXT NOT NULL REFERENCES tasks (id),
  seq INTEGER NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('text', 'tool', 'error', 'retry', 'model')),
  text TEXT NOT NULL,
  lease_id TEXT,
  PRIMARY KEY (task_id, seq)
);

-- 模型中继的每次请求（S-02 的可信降级记录）。
CREATE TABLE model_usage (
  id INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks (id),
  lease_id TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT,
  http_status INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL
);
CREATE INDEX model_usage_task ON model_usage (task_id, at);

-- IM 回传的持久 outbox（需求受理、派发进度、结果）：同 publications 的状态机，只由 publisher 发送。
CREATE TABLE im_publications (
  id TEXT PRIMARY KEY,
  demand_id TEXT NOT NULL REFERENCES demands (id),
  task_id TEXT REFERENCES tasks (id),
  connection_id TEXT NOT NULL REFERENCES connections (id),
  source_ref TEXT NOT NULL,
  message TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'sent', 'confirmed', 'failed', 'rejected', 'dry_run', 'unknown')),
  external_ref TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX im_publications_state ON im_publications (state, updated_at);

-- publisher 的持久 outbox：先在事务里记意图（dedupe_key 唯一），提交后发送；结果未知记 unknown，先核对再重试。
CREATE TABLE publications (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks (id),
  project_id TEXT NOT NULL REFERENCES projects (id),
  connection_id TEXT NOT NULL REFERENCES connections (id),
  action TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'sent', 'confirmed', 'failed', 'rejected', 'dry_run', 'unknown')),
  write_mode TEXT NOT NULL CHECK (write_mode IN ('off', 'dry_run', 'on')),
  payload_json TEXT NOT NULL,
  preview TEXT NOT NULL,
  external_ref TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX publications_task ON publications (task_id, created_at);
CREATE INDEX publications_state ON publications (state, updated_at);
