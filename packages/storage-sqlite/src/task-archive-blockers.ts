import type { DatabaseSync } from 'node:sqlite';
import type { TaskArchiveBlocker, TaskArchiveBlockers } from '@agent-hub/domain';

/** Read exact task ownership, including abandoned or expired publish claims with unknown outcome. */
export function createTaskArchiveBlockers(db: DatabaseSync): TaskArchiveBlockers {
  const blocker = db.prepare(`SELECT CASE
    WHEN EXISTS (SELECT 1 FROM task_dispatch WHERE task_id = ? AND state IN ('queued', 'running')) THEN 'dispatch'
    WHEN EXISTS (SELECT 1 FROM workspace_delegation WHERE task_id = ? AND state IN ('pending', 'preparing', 'uncertain')) THEN 'delegation'
    WHEN EXISTS (SELECT 1 FROM delegation_publish_attempt a JOIN workspace_delegation d ON d.id = a.delegation_id
      WHERE d.task_id = ? AND a.state IN ('publishing', 'uncertain')) THEN 'publish'
    ELSE NULL END AS reason`);
  return async (taskId) => (blocker.get(taskId, taskId, taskId) as { reason: TaskArchiveBlocker | null }).reason;
}
