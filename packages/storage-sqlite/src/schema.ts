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
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title      TEXT NOT NULL,
  goal       TEXT,
  status     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_by_project ON tasks(project_id);

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
CREATE TABLE IF NOT EXISTS entry_map (
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  entry_id   TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS layout (
  project_id TEXT PRIMARY KEY,
  positions  TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;
