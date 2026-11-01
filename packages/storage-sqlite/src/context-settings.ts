import type { DatabaseSync } from 'node:sqlite';
import type { ContextSetting, ContextSettingsStore } from '@agent-hub/domain';

export const CONTEXT_SCHEMA = `
CREATE TABLE IF NOT EXISTS context_settings (
  key TEXT PRIMARY KEY,
  strategy TEXT NOT NULL,
  params TEXT,
  enabled TEXT,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);
`;

interface Row { strategy: string; params: string | null; enabled: string | null; updated_at: number; updated_by: string }

/** 上下文策略的选择（ADR 0020 §8）：hub / 项目 / 角色 / 会话各一行。 */
export function createSqliteContextSettings(db: DatabaseSync): ContextSettingsStore {
  db.exec(CONTEXT_SCHEMA);
  const get = db.prepare('SELECT strategy, params, enabled, updated_at, updated_by FROM context_settings WHERE key = ?');
  const put = db.prepare(
    'INSERT INTO context_settings (key, strategy, params, enabled, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET strategy = excluded.strategy, params = excluded.params, enabled = excluded.enabled, updated_at = excluded.updated_at, updated_by = excluded.updated_by'
  );
  const del = db.prepare('DELETE FROM context_settings WHERE key = ?');
  const byPrefix = db.prepare('SELECT key, strategy, params, enabled, updated_at, updated_by FROM context_settings WHERE substr(key, 1, ?) = ? ORDER BY key');
  const decode = (row: Row): ContextSetting => ({
    strategy: row.strategy,
    ...(row.params ? { params: JSON.parse(row.params) as Record<string, unknown> } : {}),
    ...(row.enabled ? { enabled: JSON.parse(row.enabled) as string[] } : {}),
    updatedAt: row.updated_at,
    updatedBy: row.updated_by
  });
  return {
    async list(prefix) {
      return (byPrefix.all(prefix.length, prefix) as unknown as (Row & { key: string })[]).map((row) => ({ key: row.key, setting: decode(row) }));
    },
    async get(key) {
      const row = get.get(key) as Row | undefined;
      if (!row) return null;
      const setting: ContextSetting = {
        strategy: row.strategy,
        ...(row.params ? { params: JSON.parse(row.params) as Record<string, unknown> } : {}),
        ...(row.enabled ? { enabled: JSON.parse(row.enabled) as string[] } : {}),
        updatedAt: row.updated_at,
        updatedBy: row.updated_by
      };
      return setting;
    },
    async set(key, value) {
      if (!value) return void del.run(key);
      put.run(key, value.strategy, value.params ? JSON.stringify(value.params) : null, value.enabled ? JSON.stringify(value.enabled) : null, value.updatedAt, value.updatedBy);
    }
  };
}
