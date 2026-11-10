import type { DatabaseSync } from 'node:sqlite';
import { asProjectId, asSessionId, type ProjectId, type SessionId, type SessionLink, type SessionLinkRepository } from '@agent-hub/domain';

interface LinkRow {
  project_id: string;
  a_session_id: string;
  b_session_id: string;
  created_by: string | null;
  created_at: number;
}

const toLink = (row: LinkRow): SessionLink => ({
  projectId: asProjectId(row.project_id),
  aSessionId: asSessionId(row.a_session_id),
  bSessionId: asSessionId(row.b_session_id),
  createdBy: row.created_by,
  createdAt: row.created_at
});

const ordered = (one: SessionId, other: SessionId): [SessionId, SessionId] =>
  one < other ? [one, other] : [other, one];

/** 会话连线：无向关系，规范成 (a < b) 一行；重复 save 不报错。 */
export function createSqliteSessionLinks(db: DatabaseSync): SessionLinkRepository {
  const selectByProject = db.prepare('SELECT * FROM session_links WHERE project_id = ? ORDER BY created_at ASC');
  const selectForSession = db.prepare(
    'SELECT * FROM session_links WHERE a_session_id = ? OR b_session_id = ? ORDER BY created_at ASC'
  );
  const selectPair = db.prepare(
    'SELECT 1 FROM session_links WHERE a_session_id = ? AND b_session_id = ?'
  );
  const insert = db.prepare(
    'INSERT INTO session_links(project_id, a_session_id, b_session_id, created_by, created_at) VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT(project_id, a_session_id, b_session_id) DO NOTHING'
  );
  const deletePair = db.prepare(
    'DELETE FROM session_links WHERE project_id = ? AND a_session_id = ? AND b_session_id = ?'
  );
  const deleteProject = db.prepare('DELETE FROM session_links WHERE project_id = ?');

  return {
    async listByProject(projectId: ProjectId): Promise<SessionLink[]> {
      return (selectByProject.all(projectId) as unknown as LinkRow[]).map(toLink);
    },
    async forSession(sessionId: SessionId): Promise<SessionLink[]> {
      return (selectForSession.all(sessionId, sessionId) as unknown as LinkRow[]).map(toLink);
    },
    async areLinked(one: SessionId, other: SessionId): Promise<boolean> {
      if (one === other) return false;
      const [a, b] = ordered(one, other);
      return selectPair.get(a, b) !== undefined;
    },
    async save(link: SessionLink): Promise<void> {
      insert.run(link.projectId, link.aSessionId, link.bSessionId, link.createdBy, link.createdAt);
    },
    async remove(projectId: ProjectId, one: SessionId, other: SessionId): Promise<void> {
      if (one === other) return;
      const [a, b] = ordered(one, other);
      deletePair.run(projectId, a, b);
    },
    async removeByProject(projectId: ProjectId): Promise<void> {
      deleteProject.run(projectId);
    }
  };
}
