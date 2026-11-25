/**
 * 控制面 schema。行存、OLTP、单写者。
 * journal 的 (session_id, seq) 主键同时是幂等保护：worker 重发同一事件不会写两遍。
 */
export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  root_path  TEXT NOT NULL,
  worker_id  TEXT,
  directories TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title      TEXT NOT NULL,
  goal       TEXT,
  status     TEXT NOT NULL,
  owner_id   TEXT,
  branch     TEXT,
  base_branch TEXT,
  -- 显式父任务（项目内子任务）；只在创建时写，旧库由 task-creations.ts 补列。
  parent_task_id TEXT,
  summary    TEXT,
  -- 归档时间；NULL = 未归档。只经 CAS 语句写，整行 upsert 更新时不覆盖。
  archived_at INTEGER,
  log_seq    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_by_project ON tasks(project_id);

-- 会话内写工具的持久请求回执（docs/design/project-session-mcp.md）：
-- key 由 人 + 来源会话 + 项目 + 操作 + 调用方请求键 组成；result 是首次成功结果的 JSON。
-- 回执与业务写入同事务，重试只回放、不重跑。
CREATE TABLE IF NOT EXISTS request_receipts (
  key               TEXT PRIMARY KEY,
  actor_id          TEXT NOT NULL,
  source_session_id TEXT,
  project_id        TEXT NOT NULL,
  operation         TEXT NOT NULL,
  fingerprint       TEXT NOT NULL,
  result            TEXT NOT NULL,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS request_receipts_by_project ON request_receipts(project_id, created_at);

-- 任务工作日志：只追加。修订 = 新行 + 旧行 superseded_by 指向它。
CREATE TABLE IF NOT EXISTS task_log_entries (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  seq           INTEGER NOT NULL,
  author        TEXT NOT NULL,
  kind          TEXT NOT NULL,
  body          TEXT NOT NULL,
  links         TEXT NOT NULL DEFAULT '[]',
  attachments   TEXT NOT NULL DEFAULT '[]',
  session_id    TEXT,
  created_at    INTEGER NOT NULL,
  supersedes    TEXT,
  superseded_by TEXT,
  UNIQUE(task_id, seq)
);

CREATE TABLE IF NOT EXISTS sessions (
  id               TEXT PRIMARY KEY,
  -- #221 步骤 7：容器会话（群角色 / bot P2P）不属于任何任务，task_id 可以是 NULL；
  -- 老库由 store.ts 的 relaxSessionsTaskId 重建表迁移。
  task_id          TEXT REFERENCES tasks(id),
  agent_id         TEXT NOT NULL,
  model            TEXT NOT NULL,
  origin_kind      TEXT NOT NULL,
  origin_session   TEXT,
  origin_seq       INTEGER,
  kind             TEXT,
  parent_session_id TEXT,
  status           TEXT NOT NULL,
  last_seq         INTEGER NOT NULL,
  -- 第几轮对话：每次 prompt +1。状态只描述最近一轮，turn 让调用方把请求和回复对上。
  turn             INTEGER NOT NULL DEFAULT 0,
  agent_session    TEXT,
  options          TEXT NOT NULL DEFAULT '{}',
  option_spec      TEXT NOT NULL DEFAULT '[]',
  model_pinned     INTEGER NOT NULL DEFAULT 0,
  worker_id        TEXT,
  -- #243：容器会话创建时落定的来源项目；只用于授权。老库为 NULL，由 store.ts 补列。
  origin_project_id TEXT,
  environment_revision TEXT,
  -- 常驻：Worker 不按空闲回收这条会话，也不占保活上限。
  pinned           INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_by_task ON sessions(task_id);

CREATE TABLE IF NOT EXISTS artifacts (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  task_id    TEXT NOT NULL,
  path       TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  label      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS artifacts_by_session ON artifacts(session_id);

CREATE TABLE IF NOT EXISTS journal (
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  at         INTEGER NOT NULL,
  -- 这条事件属于第几轮（老库由 store.ts 的 turn 迁移回填）。
  turn       INTEGER,
  PRIMARY KEY (session_id, seq)
);

-- 双权威的桥：平台的 seq 与 agent 自己的 entry id。Pi 的 fork 单位是 entry id。
-- 会话文本投影：搜索的单位是「这个会话说过的话」，不是单条 delta。
-- 流式回复把一句话拆成几十行 journal，按行 LIKE 永远搜不到跨行的词。
CREATE TABLE IF NOT EXISTS session_text (
  session_id TEXT PRIMARY KEY,
  text       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS entry_map (
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  entry_id   TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS layout (
  project_id TEXT PRIMARY KEY,
  positions  TEXT NOT NULL,
  sizes      TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_links (
  project_id   TEXT NOT NULL,
  a_session_id TEXT NOT NULL,
  b_session_id TEXT NOT NULL,
  created_by   TEXT,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (project_id, a_session_id, b_session_id)
);

CREATE INDEX IF NOT EXISTS session_links_b ON session_links(b_session_id);

-- Agent 配置：可复用的启动组合，按 owner 隔离（owner_id = NULL 表示无账号/本机）。
CREATE TABLE IF NOT EXISTS agent_profiles (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT,
  name       TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  model      TEXT NOT NULL DEFAULT '',
  options    TEXT NOT NULL DEFAULT '{}',
  notes      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_profiles_by_owner ON agent_profiles(owner_id, updated_at);
`;
