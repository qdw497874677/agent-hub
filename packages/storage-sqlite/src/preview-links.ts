import type { DatabaseSync } from 'node:sqlite';
import type {
  PreviewLink,
  PreviewLinkId,
  PreviewLinkRepository,
  SessionId,
} from '@agent-hub/domain';

interface PreviewLinkRow {
  id: string;
  session_id: string;
  worker_id: string;
  port: number;
  hub_port: number;
  label: string;
  source: string;
  state: string;
  created_at: number;
  last_seen_at: number;
}

const toLink = (row: PreviewLinkRow): PreviewLink => ({
  // 库里存的就是完整的 `pv_<hex>`，直接当作品牌 id 用。
  id: row.id as PreviewLinkId,
  sessionId: row.session_id as SessionId,
  workerId: row.worker_id,
  port: row.port,
  hubPort: row.hub_port,
  label: row.label,
  source: row.source as PreviewLink['source'],
  state: row.state as PreviewLink['state'],
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
});

/**
 * 预览链接（docs/design/preview.md §4）：一行 = 一条「会话里的端口 → hub 端口」的映射。
 * `hub_port` 全库唯一，代理层就是靠它反查该转发到哪台 worker 的哪个端口。
 * 会话删除时的连带清理写在 store.ts 的 runSessionCascade 里。
 */
export function createSqlitePreviewLinks(db: DatabaseSync): PreviewLinkRepository {
  db.exec(`CREATE TABLE IF NOT EXISTS preview_links (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, worker_id TEXT NOT NULL,
    port INTEGER NOT NULL, hub_port INTEGER NOT NULL UNIQUE, label TEXT NOT NULL,
    source TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL)`);
  db.exec('CREATE INDEX IF NOT EXISTS preview_links_by_session ON preview_links(session_id)');

  const byIdStmt = db.prepare('SELECT * FROM preview_links WHERE id = ?');
  const byHubPortStmt = db.prepare('SELECT * FROM preview_links WHERE hub_port = ?');
  const bySessionStmt = db.prepare('SELECT * FROM preview_links WHERE session_id = ? ORDER BY created_at ASC, id ASC');
  const allStmt = db.prepare('SELECT * FROM preview_links ORDER BY created_at ASC, id ASC');
  const upsertStmt = db.prepare(`INSERT INTO preview_links
    (id, session_id, worker_id, port, hub_port, label, source, state, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET session_id = excluded.session_id, worker_id = excluded.worker_id,
      port = excluded.port, hub_port = excluded.hub_port, label = excluded.label,
      source = excluded.source, state = excluded.state, created_at = excluded.created_at,
      last_seen_at = excluded.last_seen_at`);
  const deleteStmt = db.prepare('DELETE FROM preview_links WHERE id = ?');
  const deleteBySessionStmt = db.prepare('DELETE FROM preview_links WHERE session_id = ?');

  const one = (row: unknown): PreviewLink | null => (row === undefined ? null : toLink(row as PreviewLinkRow));

  return {
    async byId(id: PreviewLinkId): Promise<PreviewLink | null> {
      return one(byIdStmt.get(id));
    },
    async byHubPort(hubPort: number): Promise<PreviewLink | null> {
      return one(byHubPortStmt.get(hubPort));
    },
    async listBySession(sessionId: SessionId): Promise<readonly PreviewLink[]> {
      return (bySessionStmt.all(sessionId) as unknown as PreviewLinkRow[]).map(toLink);
    },
    async listAll(): Promise<readonly PreviewLink[]> {
      return (allStmt.all() as unknown as PreviewLinkRow[]).map(toLink);
    },
    async save(link: PreviewLink): Promise<void> {
      upsertStmt.run(
        link.id,
        link.sessionId,
        link.workerId,
        link.port,
        link.hubPort,
        link.label,
        link.source,
        link.state,
        link.createdAt,
        link.lastSeenAt,
      );
    },
    async remove(id: PreviewLinkId): Promise<void> {
      deleteStmt.run(id);
    },
    async removeBySession(sessionId: SessionId): Promise<void> {
      deleteBySessionStmt.run(sessionId);
    },
  };
}
