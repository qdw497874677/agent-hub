import type { DatabaseSync } from 'node:sqlite';
import type { SessionBaseStore } from '@agent-hub/domain';

/** 会话开始时工作空间的 HEAD（ADR 0025 决定 7）：diff 默认基准。一会话一行，只写一次。 */
export function createSqliteSessionBases(db: DatabaseSync): SessionBaseStore {
  db.exec('CREATE TABLE IF NOT EXISTS session_git_bases (session_id TEXT PRIMARY KEY, head TEXT NOT NULL)');
  const get = db.prepare('SELECT head FROM session_git_bases WHERE session_id = ?');
  const put = db.prepare('INSERT OR IGNORE INTO session_git_bases (session_id, head) VALUES (?, ?)');
  return {
    async get(sessionId) {
      return (get.get(sessionId) as { head: string } | undefined)?.head ?? null;
    },
    async setIfAbsent(sessionId, head) {
      put.run(sessionId, head);
    }
  };
}
