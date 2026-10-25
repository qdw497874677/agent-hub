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
  summary    TEXT,
  log_seq    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_by_project ON tasks(project_id);

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
  task_id          TEXT NOT NULL REFERENCES tasks(id),
  agent_id         TEXT NOT NULL,
  model            TEXT NOT NULL,
  origin_kind      TEXT NOT NULL,
  origin_session   TEXT,
  origin_seq       INTEGER,
  status           TEXT NOT NULL,
  last_seq         INTEGER NOT NULL,
  agent_session    TEXT,
  options          TEXT NOT NULL DEFAULT '{}',
  option_spec      TEXT NOT NULL DEFAULT '[]',
  worker_id        TEXT,
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
`;
