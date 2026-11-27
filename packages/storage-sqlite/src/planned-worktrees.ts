import type { DatabaseSync } from 'node:sqlite';
import type { PlannedWorktree, PlannedWorktreeJson, PlannedWorktreeStore } from '@agent-hub/domain';

/** Storage is deliberately data-only; authorization and secret-free payloads are the caller's responsibility. */
export function createSqlitePlannedWorktrees<Plan = PlannedWorktreeJson, Progress = PlannedWorktreeJson>(db: DatabaseSync): PlannedWorktreeStore<Plan, Progress> {
  db.exec(`CREATE TABLE IF NOT EXISTS planned_worktrees (
    id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, project_id TEXT NOT NULL,
    task_id TEXT NOT NULL, worker_id TEXT NOT NULL, created_at INTEGER NOT NULL,
    plan TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision >= 0),
    state TEXT NOT NULL CHECK (state IN ('draft','pending','unknown','ready-unused','closed','failed')),
    progress TEXT NOT NULL, protected_workspace_ids TEXT NOT NULL, protected_group_ids TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS planned_worktrees_task ON planned_worktrees(task_id);
  CREATE INDEX IF NOT EXISTS planned_worktrees_project_worker ON planned_worktrees(project_id, worker_id)`);

  function read(raw: unknown): PlannedWorktree<Plan, Progress> | null {
    if (!raw) return null;
    const r = raw as Record<string, unknown>;
    return { id: r.id as string, actorId: r.actor_id as string, projectId: r.project_id as string,
      taskId: r.task_id as string, workerId: r.worker_id as string, createdAt: r.created_at as number,
      plan: JSON.parse(r.plan as string), revision: r.revision as number, state: r.state as PlannedWorktree['state'],
      progress: JSON.parse(r.progress as string), protectedWorkspaceIds: JSON.parse(r.protected_workspace_ids as string),
      protectedGroupIds: JSON.parse(r.protected_group_ids as string) };
  }
  const get = (id: string) => read(db.prepare('SELECT * FROM planned_worktrees WHERE id = ?').get(id));
  return {
    get,
    listByTask(taskId) {
      if (!nonempty(taskId)) throw new Error('invalid task id');
      return db.prepare('SELECT * FROM planned_worktrees WHERE task_id = ? ORDER BY created_at, id').all(taskId).map((r) => read(r)!);
    },
    listByProjectWorker(projectId, workerId) {
      if (!nonempty(projectId) || !nonempty(workerId)) throw new Error('invalid project or worker id');
      return db.prepare('SELECT * FROM planned_worktrees WHERE project_id = ? AND worker_id = ? ORDER BY created_at, id').all(projectId, workerId).map((r) => read(r)!);
    },
    byWorkspaceId(workspaceId) {
      if (!nonempty(workspaceId)) throw new Error('invalid workspace id');
      return db.prepare('SELECT planned_worktrees.* FROM planned_worktrees WHERE EXISTS (SELECT 1 FROM json_each(protected_workspace_ids) WHERE value = ?) ORDER BY created_at, id').all(workspaceId).map((r) => read(r)!);
    },
    create(record) {
      if (![record.id, record.actorId, record.projectId, record.taskId, record.workerId].every(nonempty) || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0) throw new Error('invalid planned worktree identity');
      if (record.state !== 'draft' && record.state !== 'pending') throw new Error('invalid planned worktree initial state');
      const plan = json(record.plan), progress = json(record.progress);
      const workspaces = ids(record.protectedWorkspaceIds), groups = ids(record.protectedGroupIds);
      return db.prepare(`INSERT INTO planned_worktrees VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
        .run(record.id, record.actorId, record.projectId, record.taskId, record.workerId, record.createdAt, plan, record.state, progress, workspaces, groups).changes === 1;
    },
    compareAndSet(id, expectedRevision, update) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) throw new Error('invalid planned worktree revision');
      if (!['draft', 'pending', 'unknown', 'ready-unused', 'closed', 'failed'].includes(update.state)) throw new Error('invalid planned worktree state');
      const progress = json(update.progress), workspaces = ids(update.protectedWorkspaceIds), groups = ids(update.protectedGroupIds);
      // Protection IDs remain monotonic, including with concurrent callers and after termination.
      const result = db.prepare(`UPDATE planned_worktrees SET state = ?, progress = ?, protected_workspace_ids = ?, protected_group_ids = ?, revision = revision + 1
        WHERE id = ? AND revision = ? AND state NOT IN ('closed','failed') AND (state = 'draft' OR ? != 'draft')
        AND (state != 'draft' OR ? IN ('draft', 'pending', 'closed'))
        AND (? != 'failed' OR state IN ('pending', 'unknown'))
        AND NOT EXISTS (SELECT 1 FROM json_each(protected_workspace_ids) old WHERE old.value NOT IN (SELECT value FROM json_each(?)))
        AND NOT EXISTS (SELECT 1 FROM json_each(protected_group_ids) old WHERE old.value NOT IN (SELECT value FROM json_each(?)))`)
        .run(update.state, progress, workspaces, groups, id, expectedRevision, update.state, update.state, update.state, workspaces, groups);
      return result.changes ? get(id) : null;
    },
    isWorkspaceProtected(id) {
      if (!nonempty(id)) throw new Error('invalid workspace id');
      return db.prepare("SELECT 1 FROM planned_worktrees, json_each(protected_workspace_ids) WHERE state NOT IN ('draft','closed','failed') AND json_each.value = ? LIMIT 1").get(id) !== undefined;
    },
    isGroupProtected(id) {
      if (!nonempty(id)) throw new Error('invalid group id');
      return db.prepare("SELECT 1 FROM planned_worktrees, json_each(protected_group_ids) WHERE state NOT IN ('draft','closed','failed') AND json_each.value = ? LIMIT 1").get(id) !== undefined;
    }
  };
}

function nonempty(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function ids(value: readonly string[]): string {
  if (!Array.isArray(value) || !value.every(nonempty) || new Set(value).size !== value.length) throw new Error('invalid planned worktree protection ids');
  return JSON.stringify(value);
}
function json(value: unknown): string {
  // Reject values JSON.stringify would silently alter, including non-plain objects and cycles.
  const seen = new Set<object>();
  function validate(v: unknown): void {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
    if (typeof v === 'number' && Number.isFinite(v)) return;
    if (typeof v !== 'object' || seen.has(v) || (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)) throw new Error('invalid planned worktree JSON');
    seen.add(v);
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) { if (!(i in v)) throw new Error('invalid planned worktree JSON'); validate(v[i]); }
    } else for (const child of Object.values(v)) validate(child);
    seen.delete(v);
  }
  validate(value);
  return JSON.stringify(value);
}
