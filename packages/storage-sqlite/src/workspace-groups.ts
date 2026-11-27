import type { DatabaseSync } from 'node:sqlite';
import type { ProjectId, WorkspaceGroup, WorkspaceGroupId, WorkspaceGroupMember, WorkspaceGroupRepository, WorkspaceId } from '@agent-hub/domain';
import { asProjectId, asTaskId, asWorkspaceGroupId, asWorkspaceId } from '@agent-hub/domain';

/**
 * 组合工作空间（docs/design/multi-repo.md §11.2）：一行组 + N 行成员。
 * 成员本身就是 workspaces 表里的行，这里只记归属与准备状态。
 */
export function createSqliteWorkspaceGroups(db: DatabaseSync): WorkspaceGroupRepository {
  db.exec(`CREATE TABLE IF NOT EXISTS workspace_groups (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, worker_id TEXT, root TEXT NOT NULL,
    state TEXT NOT NULL, owner_task_id TEXT, error TEXT, created_at INTEGER NOT NULL)`);
  // 建组成员分支时预分配的会话 id；老库没有这一列。
  const groupColumns = db.prepare("PRAGMA table_info('workspace_groups')").all() as Array<{ name: string }>;
  if (!groupColumns.some((column) => column.name === 'session_id')) {
    db.exec('ALTER TABLE workspace_groups ADD COLUMN session_id TEXT');
  }
  if (!groupColumns.some((column) => column.name === 'layout')) {
    db.exec("ALTER TABLE workspace_groups ADD COLUMN layout TEXT");
  }
  if (!groupColumns.some((column) => column.name === 'primary_repo_id')) {
    db.exec('ALTER TABLE workspace_groups ADD COLUMN primary_repo_id TEXT');
  }
  if (!groupColumns.some((column) => column.name === 'primary_workspace_id')) {
    db.exec('ALTER TABLE workspace_groups ADD COLUMN primary_workspace_id TEXT');
  }
  if (!groupColumns.some((column) => column.name === 'pending_briefing')) {
    db.exec('ALTER TABLE workspace_groups ADD COLUMN pending_briefing INTEGER NOT NULL DEFAULT 0');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS workspace_group_members (
    group_id TEXT NOT NULL, workspace_id TEXT NOT NULL, repo_id TEXT, name TEXT NOT NULL,
    state TEXT NOT NULL, error TEXT, position INTEGER NOT NULL,
    project_repo_id TEXT, source_workspace_id TEXT,
    PRIMARY KEY (group_id, workspace_id))`);
  const memberColumns = db.prepare("PRAGMA table_info('workspace_group_members')").all() as Array<{ name: string; notnull: number }>;
  if (memberColumns.find((column) => column.name === 'repo_id')?.notnull === 1) {
    // 旧表的 NOT NULL 无法 ALTER；事务内复制，避免用伪 repo ID 表示本地来源。
    db.exec('BEGIN');
    try {
      db.exec(`CREATE TABLE workspace_group_members_new (
        group_id TEXT NOT NULL, workspace_id TEXT NOT NULL, repo_id TEXT, name TEXT NOT NULL,
        state TEXT NOT NULL, error TEXT, position INTEGER NOT NULL,
        project_repo_id TEXT, source_workspace_id TEXT, PRIMARY KEY (group_id, workspace_id))`);
      const projectRepo = memberColumns.some((column) => column.name === 'project_repo_id') ? 'project_repo_id' : 'NULL';
      const sourceWorkspace = memberColumns.some((column) => column.name === 'source_workspace_id') ? 'source_workspace_id' : 'NULL';
      db.exec(`INSERT INTO workspace_group_members_new SELECT group_id, workspace_id, repo_id, name, state, error, position, ${projectRepo}, ${sourceWorkspace} FROM workspace_group_members`);
      db.exec('DROP TABLE workspace_group_members; ALTER TABLE workspace_group_members_new RENAME TO workspace_group_members; COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } else {
    if (!memberColumns.some((column) => column.name === 'project_repo_id')) db.exec('ALTER TABLE workspace_group_members ADD COLUMN project_repo_id TEXT');
    if (!memberColumns.some((column) => column.name === 'source_workspace_id')) db.exec('ALTER TABLE workspace_group_members ADD COLUMN source_workspace_id TEXT');
  }

  const byIdStmt = db.prepare('SELECT * FROM workspace_groups WHERE id = ?');
  const byProjectStmt = db.prepare('SELECT * FROM workspace_groups WHERE project_id = ? ORDER BY created_at DESC');
  const membersStmt = db.prepare('SELECT * FROM workspace_group_members WHERE group_id = ? ORDER BY position');
  const upsertGroup = db.prepare(`INSERT INTO workspace_groups (id, project_id, worker_id, root, state, owner_task_id, error, created_at, session_id, layout, primary_repo_id, pending_briefing, primary_workspace_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET worker_id = excluded.worker_id, root = excluded.root, state = excluded.state,
      owner_task_id = excluded.owner_task_id, error = excluded.error, session_id = excluded.session_id,
      layout = excluded.layout, primary_repo_id = excluded.primary_repo_id, pending_briefing = excluded.pending_briefing, primary_workspace_id = excluded.primary_workspace_id`);
  const clearMembers = db.prepare('DELETE FROM workspace_group_members WHERE group_id = ?');
  const insertMember = db.prepare('INSERT INTO workspace_group_members (group_id, workspace_id, repo_id, name, state, error, position, project_repo_id, source_workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const deleteGroup = db.prepare('DELETE FROM workspace_groups WHERE id = ?');

  type GroupRow = { id: string; project_id: string; worker_id: string | null; root: string; state: string; owner_task_id: string | null; error: string | null; created_at: number; session_id?: string | null; layout?: string | null; primary_repo_id?: string | null; primary_workspace_id?: string | null; pending_briefing?: number | null };
  type MemberRow = { group_id: string; workspace_id: string; repo_id: string | null; name: string; state: string; error: string | null; position: number; project_repo_id: string | null; source_workspace_id: string | null };

  const toMember = (row: MemberRow): WorkspaceGroupMember => ({
    workspaceId: asWorkspaceId(row.workspace_id),
    repoId: row.repo_id,
    ...(row.project_repo_id !== null ? { projectRepoId: row.project_repo_id } : {}),
    ...(row.source_workspace_id !== null ? { sourceWorkspaceId: asWorkspaceId(row.source_workspace_id) } : {}),
    name: row.name,
    state: row.state as WorkspaceGroupMember['state'],
    error: row.error
  });

  const toGroup = (row: GroupRow): WorkspaceGroup => ({
    id: asWorkspaceGroupId(row.id),
    projectId: asProjectId(row.project_id),
    workerId: row.worker_id,
    root: row.root,
    members: (membersStmt.all(row.id) as MemberRow[]).map(toMember),
    state: row.state as WorkspaceGroup['state'],
    ownerTaskId: row.owner_task_id === null ? null : asTaskId(row.owner_task_id),
    createdAt: row.created_at,
    error: row.error,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.layout === 'amp' || row.layout === 'flat' ? { layout: row.layout } : {}),
    ...(row.primary_repo_id ? { primaryRepoId: row.primary_repo_id } : {}),
    ...(row.primary_workspace_id ? { primaryWorkspaceId: asWorkspaceId(row.primary_workspace_id) } : {}),
    ...(row.pending_briefing === 1 ? { pendingBriefing: true } : {})
  });

  return {
    async byId(id: WorkspaceGroupId) {
      const row = byIdStmt.get(id) as GroupRow | undefined;
      return row === undefined ? null : toGroup(row);
    },
    async listByProject(projectId: ProjectId) {
      return (byProjectStmt.all(projectId) as GroupRow[]).map(toGroup);
    },
    async save(group) {
      // 组很小（≤8 个成员），覆盖写比做 diff 简单可靠；成员表先清再插保证 position 顺序。
      db.exec('BEGIN');
      try {
        upsertGroup.run(group.id, group.projectId, group.workerId ?? null, group.root, group.state, group.ownerTaskId ?? null, group.error ?? null, group.createdAt, group.sessionId ?? null, group.layout ?? null, group.primaryRepoId ?? null, group.pendingBriefing ? 1 : 0, group.primaryWorkspaceId ?? null);
        clearMembers.run(group.id);
        group.members.forEach((member, position) => {
          insertMember.run(group.id, member.workspaceId as string, member.repoId, member.name, member.state, member.error ?? null, position, member.projectRepoId ?? null, member.sourceWorkspaceId ?? null);
        });
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    async remove(id: WorkspaceGroupId) {
      db.exec('BEGIN');
      try {
        clearMembers.run(id);
        deleteGroup.run(id);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  };
}

/** 组里出现过的 workspace id（清理用它判断某个 workspace 是不是组成员）。 */
export function groupIdOfWorkspace(db: DatabaseSync, workspaceId: WorkspaceId): WorkspaceGroupId | null {
  const row = db.prepare('SELECT group_id FROM workspace_group_members WHERE workspace_id = ?').get(workspaceId) as { group_id: string } | undefined;
  return row === undefined ? null : asWorkspaceGroupId(row.group_id);
}
