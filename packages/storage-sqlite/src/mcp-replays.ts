import type { DatabaseSync } from 'node:sqlite';
import type { McpReplayStore } from '@agent-hub/domain';

/** 幂等回放只留 24 小时；调用方不会隔天拿同一个 clientRequestId 来重试。 */
const RETENTION_MS = 24 * 60 * 60_000;

export function createMcpReplays(db: DatabaseSync): McpReplayStore {
  db.exec(
    `CREATE TABLE IF NOT EXISTS mcp_replays (
      key TEXT PRIMARY KEY, body TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'done')`
  );
  // 老库没有 status 列：补上（已有行都是已完成的结果）。
  const columns = db.prepare('PRAGMA table_info(mcp_replays)').all() as { name?: string }[];
  if (!columns.some((column) => column.name === 'status')) {
    db.exec("ALTER TABLE mcp_replays ADD COLUMN status TEXT NOT NULL DEFAULT 'done'");
  }
  const read = db.prepare('SELECT body, status FROM mcp_replays WHERE key = ? AND created_at >= ?');
  const put = db.prepare(
    `INSERT INTO mcp_replays (key, body, created_at, status) VALUES (?, ?, ?, 'done')
     ON CONFLICT(key) DO UPDATE SET body = excluded.body, created_at = excluded.created_at, status = 'done'`
  );
  // 只有「没有占位 / 占位超时 / 旧结果已过期」时才抢到执行权。
  const claim = db.prepare(
    `INSERT INTO mcp_replays (key, body, created_at, status) VALUES (?, '', ?, 'pending')
     ON CONFLICT(key) DO UPDATE SET body = '', created_at = excluded.created_at, status = 'pending'
     WHERE (mcp_replays.status = 'pending' AND mcp_replays.created_at < ?)
        OR mcp_replays.created_at < ?`
  );
  const release = db.prepare("DELETE FROM mcp_replays WHERE key = ? AND status = 'pending'");
  const prune = db.prepare('DELETE FROM mcp_replays WHERE created_at < ?');
  return {
    async get(key, now = Date.now(), ttlMs = RETENTION_MS) {
      const row = read.get(key, now - ttlMs) as { body?: string; status?: string } | undefined;
      // 占位还没完成：不能当成结果回放。
      if (row?.status !== 'done') return null;
      return row.body ?? null;
    },
    async put(key, body, at) {
      put.run(key, body, at);
      prune.run(at - RETENTION_MS);
    },
    async claim(key, at, staleBefore, expiredBefore) {
      return Number(claim.run(key, at, staleBefore, expiredBefore).changes) > 0;
    },
    async release(key) {
      release.run(key);
    }
  };
}
