import type { DatabaseSync } from 'node:sqlite';
import type { GitHostTokenStore, PullRequestLink, PullRequestRepository } from '@agent-hub/domain';
import { createSecretVault } from './secrets.ts';

/** 挂在任务上的 PR（ADR 0027 §2）。 */
export function createSqlitePullRequests(db: DatabaseSync): PullRequestRepository {
  db.exec(`CREATE TABLE IF NOT EXISTS task_pull_requests (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, workspace_id TEXT, session_id TEXT,
    provider TEXT NOT NULL, via TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL, url TEXT NOT NULL,
    branch TEXT NOT NULL, base TEXT NOT NULL, state TEXT NOT NULL, head_sha TEXT, merged_at INTEGER,
    created_by TEXT NOT NULL, created_at INTEGER NOT NULL, last_synced_at INTEGER NOT NULL,
    UNIQUE (repo, number, task_id));
    CREATE INDEX IF NOT EXISTS task_pull_requests_task ON task_pull_requests (task_id);
    CREATE INDEX IF NOT EXISTS task_pull_requests_open ON task_pull_requests (state, last_synced_at);`);
  const upsert = db.prepare(`INSERT INTO task_pull_requests (id, task_id, workspace_id, session_id, provider, via, repo, number, url, branch, base, state, head_sha, merged_at, created_by, created_at, last_synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET url = excluded.url, state = excluded.state, head_sha = excluded.head_sha, merged_at = excluded.merged_at, last_synced_at = excluded.last_synced_at`);
  const byTask = db.prepare('SELECT * FROM task_pull_requests WHERE task_id = ? ORDER BY created_at DESC');
  const byWorkspace = db.prepare('SELECT * FROM task_pull_requests WHERE workspace_id = ? ORDER BY created_at DESC');
  const due = db.prepare("SELECT * FROM task_pull_requests WHERE state = 'open' AND last_synced_at < ? ORDER BY last_synced_at LIMIT ?");
  type Row = Record<string, string | number | null>;
  const toLink = (r: Row): PullRequestLink => ({
    id: String(r['id']), taskId: String(r['task_id']), workspaceId: (r['workspace_id'] as string | null) ?? null, sessionId: (r['session_id'] as string | null) ?? null,
    provider: 'github', via: r['via'] === 'gh' ? 'gh' : 'token', repo: String(r['repo']), number: Number(r['number']), url: String(r['url']),
    branch: String(r['branch']), base: String(r['base']), state: r['state'] as PullRequestLink['state'], headSha: (r['head_sha'] as string | null) ?? null,
    mergedAt: (r['merged_at'] as number | null) ?? null, createdBy: String(r['created_by']), createdAt: Number(r['created_at']), lastSyncedAt: Number(r['last_synced_at'])
  });
  return {
    async save(l) {
      upsert.run(l.id, l.taskId, l.workspaceId, l.sessionId, l.provider, l.via, l.repo, l.number, l.url, l.branch, l.base, l.state, l.headSha, l.mergedAt, l.createdBy, l.createdAt, l.lastSyncedAt);
    },
    async byTask(taskId) {
      return (byTask.all(taskId) as Row[]).map(toLink);
    },
    async byWorkspace(workspaceId) {
      return (byWorkspace.all(workspaceId) as Row[]).map(toLink);
    },
    async openSyncedBefore(before, limit) {
      return (due.all(before, limit) as Row[]).map(toLink);
    }
  };
}

/** 团队代码托管 token：加密（同 provider_secrets 那套），名字 = 团队 id；另记末 4 位给界面看。 */
export function createSqliteGitHostTokens(db: DatabaseSync, key: Uint8Array): GitHostTokenStore {
  const vault = createSecretVault(db, key, 'git_host_secrets');
  db.exec('CREATE TABLE IF NOT EXISTS git_host_token_meta (team_id TEXT PRIMARY KEY, last4 TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const meta = db.prepare('SELECT last4, updated_at FROM git_host_token_meta WHERE team_id = ?');
  const putMeta = db.prepare('INSERT OR REPLACE INTO git_host_token_meta (team_id, last4, updated_at) VALUES (?, ?, ?)');
  const dropMeta = db.prepare('DELETE FROM git_host_token_meta WHERE team_id = ?');
  return {
    async status(teamId) {
      const row = meta.get(teamId) as { last4: string; updated_at: number } | undefined;
      return row ? { configured: true, last4: row.last4, updatedAt: row.updated_at } : { configured: false, last4: null, updatedAt: null };
    },
    async put(teamId, token, at) {
      await vault.put(teamId, token, at);
      putMeta.run(teamId, token.slice(-4), at);
    },
    async remove(teamId) {
      dropMeta.run(teamId);
      return vault.remove(teamId);
    },
    async reveal(teamId) {
      return (await vault.reveal([teamId]))[teamId] ?? null;
    }
  };
}
