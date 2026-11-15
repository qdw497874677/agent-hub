import type { DatabaseSync } from 'node:sqlite';
import type { McpReplayStore } from '@agent-hub/domain';

/** 幂等回放只留 24 小时；调用方不会隔天拿同一个 clientRequestId 来重试。 */
const RETENTION_MS = 24 * 60 * 60_000;

export function createMcpReplays(db: DatabaseSync): McpReplayStore {
  db.exec(
    'CREATE TABLE IF NOT EXISTS mcp_replays (key TEXT PRIMARY KEY, body TEXT NOT NULL, created_at INTEGER NOT NULL)'
  );
  const get = db.prepare('SELECT body FROM mcp_replays WHERE key = ?');
  const put = db.prepare(
    'INSERT INTO mcp_replays (key, body, created_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET body = excluded.body'
  );
  const prune = db.prepare('DELETE FROM mcp_replays WHERE created_at < ?');
  return {
    async get(key) {
      const row = get.get(key) as { body?: string } | undefined;
      return row?.body ?? null;
    },
    async put(key, body, at) {
      put.run(key, body, at);
      prune.run(at - RETENTION_MS);
    }
  };
}
