import type { DatabaseSync } from 'node:sqlite';
import type { CleanupPolicy, SweepItem, WorkspaceSweepStore } from '@agent-hub/domain';

/** 清理规则 + 清理记录（ADR 0027 §3：workspace_sweep_runs / workspace_sweep_items）。 */
export function createSqliteWorkspaceSweeps(db: DatabaseSync): WorkspaceSweepStore {
  db.exec(`CREATE TABLE IF NOT EXISTS workspace_cleanup_policies (
    scope TEXT NOT NULL, scope_id TEXT NOT NULL, pr_merged INTEGER NOT NULL, task_ended_clean INTEGER NOT NULL, idle_days INTEGER,
    updated_at INTEGER NOT NULL, PRIMARY KEY (scope, scope_id));
    CREATE TABLE IF NOT EXISTS workspace_sweep_runs (
    id TEXT PRIMARY KEY, trigger TEXT NOT NULL, started_at INTEGER NOT NULL, removed INTEGER NOT NULL, kept INTEGER NOT NULL, failed INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS workspace_sweep_items (
    run_id TEXT NOT NULL, project_id TEXT, workspace_id TEXT NOT NULL, path TEXT NOT NULL, branch TEXT,
    action TEXT NOT NULL, reason TEXT NOT NULL, size_bytes INTEGER, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS workspace_sweep_items_project ON workspace_sweep_items (project_id, at);`);
  const getPolicy = db.prepare('SELECT * FROM workspace_cleanup_policies WHERE scope = ? AND scope_id = ?');
  const putPolicy = db.prepare(`INSERT INTO workspace_cleanup_policies (scope, scope_id, pr_merged, task_ended_clean, idle_days, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope, scope_id) DO UPDATE SET pr_merged = excluded.pr_merged, task_ended_clean = excluded.task_ended_clean, idle_days = excluded.idle_days, updated_at = excluded.updated_at`);
  const putRun = db.prepare('INSERT INTO workspace_sweep_runs (id, trigger, started_at, removed, kept, failed) VALUES (?, ?, ?, ?, ?, ?)');
  const putItem = db.prepare('INSERT INTO workspace_sweep_items (run_id, project_id, workspace_id, path, branch, action, reason, size_bytes, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const ofProject = db.prepare('SELECT * FROM workspace_sweep_items WHERE project_id = ? ORDER BY at DESC, rowid DESC LIMIT ?');
  type Row = Record<string, string | number | null>;
  return {
    async policy(scope, id) {
      const r = getPolicy.get(scope, id) as Row | undefined;
      if (!r) return null;
      const policy: CleanupPolicy = { prMerged: r['pr_merged'] === 1, taskEndedClean: r['task_ended_clean'] === 1, idleDays: (r['idle_days'] as number | null) ?? null };
      return policy;
    },
    async savePolicy(scope, id, p, at) {
      putPolicy.run(scope, id, p.prMerged ? 1 : 0, p.taskEndedClean ? 1 : 0, p.idleDays, at);
    },
    async saveRun(run, items) {
      db.exec('BEGIN');
      try {
        putRun.run(run.id, run.trigger, run.startedAt, run.removed, run.kept, run.failed);
        for (const i of items) putItem.run(i.runId, i.projectId, i.workspaceId, i.path, i.branch, i.action, i.reason, i.sizeBytes, i.at);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    async itemsOfProject(projectId, limit) {
      return (ofProject.all(projectId, limit) as Row[]).map(
        (r): SweepItem => ({
          runId: String(r['run_id']), projectId: (r['project_id'] as string | null) ?? null, workspaceId: String(r['workspace_id']), path: String(r['path']),
          branch: (r['branch'] as string | null) ?? null, action: r['action'] as SweepItem['action'], reason: String(r['reason']),
          sizeBytes: (r['size_bytes'] as number | null) ?? null, at: Number(r['at'])
        })
      );
    }
  };
}
