import type { DatabaseSync } from 'node:sqlite';
import type { Workspace, WorkspaceRepository } from '@agent-hub/domain';
import { asProjectId, asTaskId, asWorkspaceId, newWorkspaceId, normalizePath } from '@agent-hub/domain';

type Row = Record<string, unknown>;

/**
 * 工作空间登记（docs/design/workspaces.md §6）。
 * 同一项目、同一台机器、同一目录只登记一次（removed 的不算）；NULL 机器 = Server 本机，所以索引里 COALESCE。
 */
export const WORKSPACE_SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id),
  worker_id         TEXT,
  path              TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('long_lived','temporary')),
  source            TEXT NOT NULL CHECK (source IN ('linked','created','cloned','worktree')),
  base_workspace_id TEXT,
  branch            TEXT,
  owner_task_id     TEXT,
  label             TEXT,
  is_git            INTEGER,
  state             TEXT NOT NULL CHECK (state IN ('preparing','ready','failed','kept','removed')),
  kept_reason       TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  CHECK ((kind = 'temporary') = (owner_task_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS workspaces_by_project ON workspaces(project_id);
CREATE INDEX IF NOT EXISTS workspaces_by_task ON workspaces(owner_task_id);
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_one_place
  ON workspaces(project_id, COALESCE(worker_id, ''), path) WHERE state <> 'removed';
`;

const bool = (value: unknown): boolean | null => (value === null || value === undefined ? null : Number(value) === 1);

export function toWorkspace(row: Row): Workspace {
  const nullable = (key: string): string | null => (row[key] as string | null) ?? null;
  const base = nullable('base_workspace_id');
  const owner = nullable('owner_task_id');
  return {
    id: asWorkspaceId(row['id'] as string),
    projectId: asProjectId(row['project_id'] as string),
    workerId: nullable('worker_id'),
    path: row['path'] as string,
    kind: row['kind'] as Workspace['kind'],
    source: row['source'] as Workspace['source'],
    baseWorkspaceId: base === null ? null : asWorkspaceId(base),
    branch: nullable('branch'),
    ownerTaskId: owner === null ? null : asTaskId(owner),
    label: nullable('label'),
    isGit: bool(row['is_git']),
    state: row['state'] as Workspace['state'],
    keptReason: nullable('kept_reason'),
    createdAt: row['created_at'] as number,
    updatedAt: row['updated_at'] as number
  };
}

export function createWorkspaceRepository(db: DatabaseSync): WorkspaceRepository {
  const upsert = db.prepare(
    'INSERT INTO workspaces(id, project_id, worker_id, path, kind, source, base_workspace_id, branch, owner_task_id, label, ' +
      'is_git, state, kept_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET worker_id = excluded.worker_id, path = excluded.path, branch = excluded.branch, ' +
      'label = excluded.label, is_git = excluded.is_git, state = excluded.state, kept_reason = excluded.kept_reason, ' +
      'updated_at = excluded.updated_at'
  );
  const byId = db.prepare('SELECT * FROM workspaces WHERE id = ?');
  const byProject = db.prepare('SELECT * FROM workspaces WHERE project_id = ? ORDER BY created_at ASC');
  const byTask = db.prepare('SELECT * FROM workspaces WHERE owner_task_id = ? ORDER BY created_at ASC');
  const temporaries = db.prepare("SELECT * FROM workspaces WHERE kind = 'temporary' AND state <> 'removed' ORDER BY created_at ASC");
  return {
    async save(w) {
      upsert.run(
        w.id, w.projectId, w.workerId, w.path, w.kind, w.source, w.baseWorkspaceId, w.branch, w.ownerTaskId, w.label,
        w.isGit === null ? null : w.isGit ? 1 : 0, w.state, w.keptReason, w.createdAt, w.updatedAt
      );
    },
    async byId(id) {
      const row = byId.get(id) as Row | undefined;
      return row ? toWorkspace(row) : null;
    },
    async byProject(projectId) {
      return (byProject.all(projectId) as Row[]).map(toWorkspace);
    },
    async byTask(taskId) {
      return (byTask.all(taskId) as Row[]).map(toWorkspace);
    },
    async temporaries() {
      return (temporaries.all() as Row[]).map(toWorkspace);
    }
  };
}

/**
 * 老数据迁移（§6）：每个还没有工作空间的项目，把 root_path（+ worker_id）和 directories 里的每一项
 * 登记成长期 linked 工作空间；再把该项目老会话的 workspace_id 补上——会话在哪台机器，就指向那台的目录，
 * 和迁移前 workspaceFor 的推算一模一样。幂等：已经有工作空间的项目跳过。
 */
export function migrateWorkspaces(db: DatabaseSync, now: number = Date.now()): number {
  const projects = db
    .prepare('SELECT p.* FROM projects p WHERE NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.project_id = p.id)')
    .all() as Row[];
  if (projects.length === 0) return 0;
  const insert = db.prepare(
    "INSERT INTO workspaces(id, project_id, worker_id, path, kind, source, state, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, 'long_lived', 'linked', 'ready', ?, ?)"
  );
  const sessions = db.prepare(
    'SELECT s.id, s.worker_id FROM sessions s JOIN tasks t ON t.id = s.task_id WHERE t.project_id = ? AND s.workspace_id IS NULL'
  );
  const point = db.prepare('UPDATE sessions SET workspace_id = ? WHERE id = ?');
  let migrated = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const project of projects) {
      const projectId = project['id'] as string;
      const home = (project['worker_id'] as string | null) ?? null;
      const root = String(project['root_path'] ?? '');
      let homeId: string | null = null;
      if (root.startsWith('/')) {
        homeId = newWorkspaceId();
        insert.run(homeId, projectId, home, normalizePath(root), now, now);
      }
      const mapped = new Map<string, string>();
      let directories: Record<string, string> = {};
      try {
        directories = JSON.parse(String(project['directories'] ?? '{}')) as Record<string, string>;
      } catch {
        directories = {};
      }
      for (const [workerId, path] of Object.entries(directories)) {
        if (workerId === home || typeof path !== 'string' || !path.startsWith('/')) continue;
        const id = newWorkspaceId();
        insert.run(id, projectId, workerId, normalizePath(path), now, now);
        mapped.set(workerId, id);
      }
      for (const session of sessions.all(projectId) as Row[]) {
        const worker = (session['worker_id'] as string | null) ?? null;
        const target = (worker !== null ? mapped.get(worker) : undefined) ?? homeId;
        if (target) point.run(target, session['id'] as string);
      }
      migrated += 1;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return migrated;
}
