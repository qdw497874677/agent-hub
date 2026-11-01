import type { DatabaseSync } from 'node:sqlite';
import type {
  IndexDoc,
  IndexHit,
  MemoryEntry,
  MemoryEntryFilter,
  MemoryIndex,
  MemoryScope,
  MemorySettingsStore,
  MemoryStore,
  ProjectMemoryMode
} from '@agent-hub/domain';
import { scopeKey } from '@agent-hub/domain';

type Row = Record<string, unknown>;

/**
 * 记忆的默认适配器（ADR 0019 §4）：条目 + 历史 + 出处引用 + 每项目设置，
 * 以及一个 FTS5（trigram，中英文都能搜子串）索引。只有这个文件碰 memory_* 表。
 */
export const MEMORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_entries_scope ON memory_entries(scope_key, updated_at);
CREATE INDEX IF NOT EXISTS memory_entries_status ON memory_entries(status, scope_key);
CREATE TABLE IF NOT EXISTS memory_history (
  entry_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (entry_id, version)
);
CREATE TABLE IF NOT EXISTS memory_citations (
  entry_id TEXT NOT NULL,
  source TEXT NOT NULL,
  uri TEXT NOT NULL,
  PRIMARY KEY (entry_id, source, uri)
);
CREATE INDEX IF NOT EXISTS memory_citations_uri ON memory_citations(source, uri);
CREATE TABLE IF NOT EXISTS memory_settings (
  project_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_distill_settings (
  project_id TEXT PRIMARY KEY,
  model TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_index_docs (
  key TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  origin TEXT NOT NULL,
  source TEXT,
  kind TEXT,
  trust TEXT NOT NULL,
  hash TEXT,
  ref TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_index_docs_scope ON memory_index_docs(scope_key, source);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(key UNINDEXED, title, text, tokenize = 'trigram');
`;

const parseEntry = (row: Row | undefined): MemoryEntry | null => (row ? (JSON.parse(String(row.body)) as MemoryEntry) : null);

export function createSqliteMemoryStore(db: DatabaseSync): MemoryStore {
  db.exec(MEMORY_SCHEMA);
  const insert = db.prepare('INSERT INTO memory_entries (id, scope_key, kind, status, version, updated_at, body) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const byId = db.prepare('SELECT body FROM memory_entries WHERE id = ?');
  const replace = db.prepare('UPDATE memory_entries SET scope_key = ?, kind = ?, status = ?, version = ?, updated_at = ?, body = ? WHERE id = ? AND version = ?');
  const keepHistory = db.prepare('INSERT OR REPLACE INTO memory_history (entry_id, version, body) SELECT id, version, body FROM memory_entries WHERE id = ?');
  const history = db.prepare('SELECT body FROM memory_history WHERE entry_id = ? ORDER BY version');
  const cite = db.prepare('INSERT OR IGNORE INTO memory_citations (entry_id, source, uri) VALUES (?, ?, ?)');
  const uncite = db.prepare('DELETE FROM memory_citations WHERE entry_id = ?');
  const citing = db.prepare('SELECT e.body FROM memory_citations c JOIN memory_entries e ON e.id = c.entry_id WHERE c.source = ? AND c.uri = ?');

  const writeCitations = (entry: MemoryEntry) => {
    uncite.run(entry.id);
    for (const ref of entry.provenance.sources) cite.run(entry.id, ref.source, ref.uri);
  };

  return {
    id: 'sqlite',
    async put(entry) {
      insert.run(entry.id, scopeKey(entry.scope), entry.kind, entry.status, entry.version, entry.updatedAt, JSON.stringify(entry));
      writeCitations(entry);
    },
    async update(entry, ifVersion) {
      db.exec('BEGIN IMMEDIATE');
      try {
        keepHistory.run(entry.id);
        const result = replace.run(scopeKey(entry.scope), entry.kind, entry.status, entry.version, entry.updatedAt, JSON.stringify(entry), entry.id, ifVersion);
        if (Number(result.changes) === 0) {
          db.exec('ROLLBACK');
          return null;
        }
        writeCitations(entry);
        db.exec('COMMIT');
        return entry;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    async get(id) {
      return parseEntry(byId.get(id) as Row | undefined);
    },
    async list(scopes: readonly MemoryScope[] | null, filter: MemoryEntryFilter = {}) {
      if (scopes !== null && scopes.length === 0) return [];
      const keys = (scopes ?? []).map(scopeKey);
      const where = scopes === null ? ['1 = 1'] : [`scope_key IN (${keys.map(() => '?').join(',')})`];
      const params: (string | number)[] = [...keys];
      if (filter.status && filter.status.length > 0) {
        where.push(`status IN (${filter.status.map(() => '?').join(',')})`);
        params.push(...filter.status);
      }
      if (filter.kinds && filter.kinds.length > 0) {
        where.push(`kind IN (${filter.kinds.map(() => '?').join(',')})`);
        params.push(...filter.kinds);
      }
      params.push(Math.min(Math.max(filter.limit ?? 100, 1), 10_000));
      const rows = db.prepare(`SELECT body FROM memory_entries WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`).all(...params) as Row[];
      return rows.flatMap((row) => parseEntry(row) ?? []);
    },
    async citing(source, uri) {
      return (citing.all(source, uri) as Row[]).flatMap((row) => parseEntry(row) ?? []);
    },
    async history(id) {
      return (history.all(id) as Row[]).flatMap((row) => parseEntry(row) ?? []);
    },
    async purge(id) {
      db.prepare('DELETE FROM memory_history WHERE entry_id = ?').run(id);
      uncite.run(id);
      db.prepare('DELETE FROM memory_entries WHERE id = ?').run(id);
    }
  };
}

export function createSqliteMemorySettings(db: DatabaseSync): MemorySettingsStore {
  db.exec(MEMORY_SCHEMA);
  const get = db.prepare('SELECT mode FROM memory_settings WHERE project_id = ?');
  const set = db.prepare('INSERT INTO memory_settings (project_id, mode, updated_at) VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at');
  const getDistill = db.prepare('SELECT model FROM memory_distill_settings WHERE project_id = ?');
  const setDistill = db.prepare(
    'INSERT INTO memory_distill_settings (project_id, model, updated_at) VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET model = excluded.model, updated_at = excluded.updated_at'
  );
  return {
    async distillModel(projectId) {
      const row = getDistill.get(projectId) as { model: string | null } | undefined;
      return row?.model ?? null;
    },
    async setDistillModel(projectId, model, at) {
      setDistill.run(projectId, model, at);
    },
    async projectMode(projectId) {
      const row = get.get(projectId) as Row | undefined;
      return row?.mode === 'review' ? 'review' : 'append-only';
    },
    async setProjectMode(projectId, mode: ProjectMemoryMode, at) {
      set.run(projectId, mode, at);
    }
  };
}

/** 搜索词 → FTS5 查询：trigram 要求每个词至少 3 个字符；更短的词另走 LIKE。 */
export function ftsTerms(text: string): { match: string | null; short: string[] } {
  const words = text
    .split(/[\s,，。；;:：、!?！？()（）"'“”‘’`]+/u)
    .map((word) => word.trim())
    .filter((word) => word.length > 0)
    .slice(0, 12);
  const long = words.filter((word) => [...word].length >= 3);
  const short = words.filter((word) => [...word].length < 3);
  return { match: long.length > 0 ? long.map((word) => `"${word.replaceAll('"', '""')}"`).join(' OR ') : null, short };
}

export function createSqliteMemoryIndex(db: DatabaseSync): MemoryIndex {
  db.exec(MEMORY_SCHEMA);
  const upsertDoc = db.prepare(
    'INSERT INTO memory_index_docs (key, scope_key, origin, source, kind, trust, hash, ref, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET scope_key = excluded.scope_key, origin = excluded.origin, source = excluded.source, kind = excluded.kind, trust = excluded.trust, hash = excluded.hash, ref = excluded.ref, updated_at = excluded.updated_at'
  );
  const deleteFts = db.prepare('DELETE FROM memory_fts WHERE key = ?');
  const insertFts = db.prepare('INSERT INTO memory_fts (key, title, text) VALUES (?, ?, ?)');
  const deleteDoc = db.prepare('DELETE FROM memory_index_docs WHERE key = ?');
  const indexed = db.prepare('SELECT key, hash FROM memory_index_docs WHERE scope_key = ? AND source = ?');

  const toHit = (row: Row, relevance: number): IndexHit => ({
    key: String(row.key),
    scopeKey: String(row.scope_key),
    origin: row.origin === 'entry' ? 'entry' : 'source',
    title: String(row.title ?? ''),
    snippet: String(row.snip ?? ''),
    relevance,
    trust: row.trust === 'trusted' ? 'trusted' : 'untrusted',
    updatedAt: Number(row.updated_at),
    ref: row.ref ? JSON.parse(String(row.ref)) : null
  });

  return {
    async upsert(docs: readonly IndexDoc[]) {
      db.exec('BEGIN');
      try {
        for (const doc of docs) {
          upsertDoc.run(doc.key, doc.scopeKey, doc.origin, doc.ref?.source ?? null, doc.kind, doc.trust, doc.ref?.hash ?? null, doc.ref ? JSON.stringify(doc.ref) : null, doc.updatedAt);
          deleteFts.run(doc.key);
          insertFts.run(doc.key, doc.title, doc.text);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    async remove(keys) {
      for (const key of keys) {
        deleteFts.run(key);
        deleteDoc.run(key);
      }
    },
    async indexed(scope, source) {
      return new Map((indexed.all(scope, source) as Row[]).map((row) => [String(row.key), String(row.hash ?? '')]));
    },
    async query({ text, scopeKeys, origins, kinds, limit }) {
      if (scopeKeys.length === 0 || origins.length === 0) return [];
      const { match, short } = ftsTerms(text);
      const where = [`d.scope_key IN (${scopeKeys.map(() => '?').join(',')})`, `d.origin IN (${origins.map(() => '?').join(',')})`];
      const params: (string | number)[] = [...scopeKeys, ...origins];
      if (kinds && kinds.length > 0) {
        // 来源没有 kind，按 kind 过滤时只留条目
        where.push(`d.kind IN (${kinds.map(() => '?').join(',')})`);
        params.push(...kinds);
      }
      const cap = Math.min(Math.max(limit, 1), 100);
      if (match) {
        const rows = db
          .prepare(
            `SELECT d.*, f.title AS title, snippet(memory_fts, 2, '', '', '…', 24) AS snip, bm25(memory_fts, 0, 5, 1) AS score
             FROM memory_fts f JOIN memory_index_docs d ON d.key = f.key
             WHERE memory_fts MATCH ? AND ${where.join(' AND ')} ORDER BY score LIMIT ?`
          )
          .all(match, ...params, cap) as Row[];
        return rows.map((row) => {
          const raw = Math.max(0, -Number(row.score));
          return toHit(row, raw / (1 + raw));
        });
      }
      if (short.length === 0) return [];
      // 太短的词（一两个汉字、"ui"）：退回子串匹配
      const like = short.map(() => '(f.title LIKE ? OR f.text LIKE ?)').join(' OR ');
      const likeParams = short.flatMap((word) => [`%${word.replaceAll('%', '')}%`, `%${word.replaceAll('%', '')}%`]);
      const rows = db
        .prepare(
          `SELECT d.*, f.title AS title, substr(f.text, 1, 160) AS snip FROM memory_fts f JOIN memory_index_docs d ON d.key = f.key
           WHERE (${like}) AND ${where.join(' AND ')} ORDER BY d.updated_at DESC LIMIT ?`
        )
        .all(...likeParams, ...params, cap) as Row[];
      return rows.map((row) => toHit(row, 0.3));
    }
  };
}
