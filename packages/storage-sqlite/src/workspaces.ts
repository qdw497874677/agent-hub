import type { DatabaseSync } from 'node:sqlite';
import type { Workspace, WorkspaceRepository } from '@agent-hub/domain';
import { asProjectId, asTaskId, asWorkspaceGroupId, asWorkspaceId, newWorkspaceId, normalizePath } from '@agent-hub/domain';

type Row = Record<string, unknown>;

/**
 * 工作空间登记（docs/design/workspaces.md §6）。
 * 同一项目、同一台机器、同一目录只登记一次（removed 的不算）；NULL 机器 = Server 本机，所以索引里 COALESCE。
 */
export const WORKSPACE_SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id                TEXT PRIMARY KEY,
  project_id        TEXT REFERENCES projects(id),
  team_id           TEXT,
  repo_url          TEXT,
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
  setup             TEXT,
  group_id          TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  CHECK ((kind = 'temporary') = (owner_task_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS workspaces_by_project ON workspaces(project_id);
CREATE INDEX IF NOT EXISTS workspaces_by_task ON workspaces(owner_task_id);
CREATE INDEX IF NOT EXISTS workspaces_by_place ON workspaces(COALESCE(worker_id, ''), path);
CREATE TABLE IF NOT EXISTS project_workspaces (
  project_id   TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  linked_by    TEXT,
  linked_at    INTEGER NOT NULL,
  PRIMARY KEY (project_id, workspace_id)
);
CREATE INDEX IF NOT EXISTS project_workspaces_by_workspace ON project_workspaces(workspace_id);
`;

const WORKSPACE_COLUMNS =
  'id, project_id, team_id, repo_url, worker_id, path, kind, source, base_workspace_id, branch, owner_task_id, label, is_git, state, kept_reason, setup, group_id, created_at, updated_at';

/**
 * ADR 0026 表结构升级（幂等、可回滚）：老表 project_id 是 NOT NULL、没有 team_id / repo_url。
 * SQLite 改不了 NOT NULL，只能重建：新表建好、整表拷过去、改名。列名和老代码完全兼容——回滚到老版本时，
 * 老代码照样按 project_id 找到迁移来的工作空间（只是看不到后来新增的关联）。
 * 必须在 WORKSPACE_SCHEMA 之前跑（那里的建表是 IF NOT EXISTS）。
 */
export function upgradeWorkspaceTable(db: DatabaseSync): boolean {
  const columns = db.prepare('PRAGMA table_info(workspaces)').all() as Row[];
  if (columns.length === 0) return false; // 新库：WORKSPACE_SCHEMA 直接建新表
  const has = (name: string) => columns.some((c) => c['name'] === name);
  const projectNotNull = columns.some((c) => c['name'] === 'project_id' && Number(c['notnull']) === 1);
  if (has('team_id') && has('repo_url') && !projectNotNull) return false;
  const create = WORKSPACE_SCHEMA.slice(WORKSPACE_SCHEMA.indexOf('CREATE TABLE'), WORKSPACE_SCHEMA.indexOf(');') + 2)
    .replace('CREATE TABLE IF NOT EXISTS workspaces', 'CREATE TABLE workspaces_v2');
  const copied = WORKSPACE_COLUMNS.split(', ').map((c) => (has(c) ? c : `NULL AS ${c}`)).join(', ');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(create);
    db.exec(`INSERT INTO workspaces_v2(${WORKSPACE_COLUMNS}) SELECT ${copied} FROM workspaces`);
    db.exec('DROP TABLE workspaces');
    db.exec('ALTER TABLE workspaces_v2 RENAME TO workspaces');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return true;
}

const bool = (value: unknown): boolean | null => (value === null || value === undefined ? null : Number(value) === 1);

/** 准备命令状态（JSON）。解析不了 → 记日志、按 null 处理（老库 / 手改过的行不该让工作空间读不出来）。 */
function parseSetup(raw: string | null): Workspace['setup'] {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const state = (value as Record<string, unknown>)['state'];
    if (state !== 'none' && state !== 'running' && state !== 'ready' && state !== 'failed') {
      console.warn('[storage] workspace.setup 状态不合法，按 null 处理');
      return null;
    }
    return value as Workspace['setup'];
  } catch {
    console.warn('[storage] workspace.setup 不是合法 JSON，按 null 处理');
    return null;
  }
}

export function toWorkspace(row: Row): Workspace {
  const nullable = (key: string): string | null => (row[key] as string | null) ?? null;
  const base = nullable('base_workspace_id');
  const owner = nullable('owner_task_id');
  return {
    id: asWorkspaceId(row['id'] as string),
    projectId: nullable('project_id') === null ? null : asProjectId(row['project_id'] as string),
    teamId: nullable('team_id'),
    repoUrl: nullable('repo_url'),
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
    setup: parseSetup(nullable('setup')),
    groupId: nullable('group_id') === null ? null : asWorkspaceGroupId(row['group_id'] as string),
    createdAt: row['created_at'] as number,
    updatedAt: row['updated_at'] as number
  };
}

export function createWorkspaceRepository(db: DatabaseSync): WorkspaceRepository {
  const upsert = db.prepare(
    `INSERT INTO workspaces(${WORKSPACE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ` +
      'ON CONFLICT(id) DO UPDATE SET worker_id = excluded.worker_id, path = excluded.path, branch = excluded.branch, ' +
      'team_id = excluded.team_id, repo_url = excluded.repo_url, ' +
      'label = excluded.label, is_git = excluded.is_git, state = excluded.state, kept_reason = excluded.kept_reason, ' +
      'setup = excluded.setup, group_id = excluded.group_id, updated_at = excluded.updated_at'
  );
  const byId = db.prepare('SELECT * FROM workspaces WHERE id = ?');
  const byProject = db.prepare(
    "SELECT * FROM workspaces WHERE (kind = 'temporary' AND project_id = ?) " +
      'OR id IN (SELECT workspace_id FROM project_workspaces WHERE project_id = ?) ORDER BY created_at ASC'
  );
  const exists = db.prepare('SELECT 1 FROM workspaces WHERE id = ?');
  const longLived = db.prepare("SELECT * FROM workspaces WHERE kind = 'long_lived' AND state <> 'removed' ORDER BY created_at ASC");
  const link = db.prepare('INSERT OR IGNORE INTO project_workspaces(project_id, workspace_id, linked_by, linked_at) VALUES (?, ?, ?, ?)');
  const unlink = db.prepare('DELETE FROM project_workspaces WHERE project_id = ? AND workspace_id = ?');
  const linksOf = db.prepare('SELECT * FROM project_workspaces WHERE workspace_id = ? ORDER BY linked_at ASC');
  const byTask = db.prepare('SELECT * FROM workspaces WHERE owner_task_id = ? ORDER BY created_at ASC');
  const temporaries = db.prepare("SELECT * FROM workspaces WHERE kind = 'temporary' AND state <> 'removed' ORDER BY created_at ASC");
  const onMachine = db.prepare("SELECT * FROM workspaces WHERE worker_id IS ? AND state <> 'removed' ORDER BY created_at ASC");
  return {
    async save(w) {
      const fresh = exists.get(w.id) === undefined;
      upsert.run(
        w.id, w.projectId, w.teamId, w.repoUrl, w.workerId, w.path, w.kind, w.source, w.baseWorkspaceId, w.branch, w.ownerTaskId, w.label,
        w.isGit === null ? null : w.isGit ? 1 : 0, w.state, w.keptReason, w.setup ? JSON.stringify(w.setup) : null, w.groupId ?? null,
        w.createdAt, w.updatedAt
      );
      if (fresh && w.kind === 'long_lived' && w.projectId !== null) link.run(w.projectId, w.id, null, w.createdAt);
    },
    async longLived() {
      return (longLived.all() as Row[]).map(toWorkspace);
    },
    async link(l) {
      link.run(l.projectId, l.workspaceId, l.linkedBy, l.linkedAt);
    },
    async unlink(projectId, workspaceId) {
      unlink.run(projectId, workspaceId);
    },
    async linksOf(workspaceId) {
      return (linksOf.all(workspaceId) as Row[]).map((row) => ({
        projectId: asProjectId(row['project_id'] as string),
        workspaceId: asWorkspaceId(row['workspace_id'] as string),
        linkedBy: (row['linked_by'] as string | null) ?? null,
        linkedAt: row['linked_at'] as number
      }));
    },
    async byId(id) {
      const row = byId.get(id) as Row | undefined;
      return row ? toWorkspace(row) : null;
    },
    async byProject(projectId) {
      return (byProject.all(projectId, projectId) as Row[]).map(toWorkspace);
    },
    async byTask(taskId) {
      return (byTask.all(taskId) as Row[]).map(toWorkspace);
    },
    async temporaries() {
      return (temporaries.all() as Row[]).map(toWorkspace);
    },
    async onMachine(workerId) {
      return (onMachine.all(workerId) as Row[]).map(toWorkspace);
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

export interface SharedWorkspaceMigration {
  /** 新建的关联行（每个老的长期工作空间 → 原项目）。 */
  readonly linked: number;
  /** 补上 team_id 的工作空间。 */
  readonly teamed: number;
  /** 完全相同 (团队, 机器, 目录) 的重复登记合并掉的条数（会话 / worktree 改指向保留的那条）。 */
  readonly merged: number;
}

/**
 * ADR 0026 数据迁移（幂等，每次启动都跑）：
 * 1. 长期工作空间还没有任何关联、也从没被取消关联过的 → 关联到 project_id（原项目）；
 * 2. team_id 为空的 → 取 project_id 所在项目的团队（项目的团队之后才补上的，下次启动再补）；
 * 3. 不同项目登记了完全相同的 (机器, 目录) → 合并成最早那条，关联到各自项目。重复的 clone（不同目录）不动（Q7）。
 * 「从没被取消关联过」用 workspace_link_migrated 标记表记：只迁移一次，之后人取消关联就不会被补回来。
 */
export function migrateSharedWorkspaces(db: DatabaseSync, now: number = Date.now()): SharedWorkspaceMigration {
  db.exec('CREATE TABLE IF NOT EXISTS workspace_link_migrated (workspace_id TEXT PRIMARY KEY)');
  let linked = 0;
  let teamed = 0;
  let merged = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    teamed = Number(
      db
        .prepare(
          'UPDATE workspaces SET team_id = (SELECT p.team_id FROM projects p WHERE p.id = workspaces.project_id) ' +
            'WHERE team_id IS NULL AND project_id IS NOT NULL AND (SELECT p.team_id FROM projects p WHERE p.id = workspaces.project_id) IS NOT NULL'
        )
        .run().changes
    );
    const pending = db
      .prepare(
        "SELECT id, project_id, created_at FROM workspaces WHERE kind = 'long_lived' AND project_id IS NOT NULL " +
          'AND id NOT IN (SELECT workspace_id FROM workspace_link_migrated)'
      )
      .all() as Row[];
    const link = db.prepare('INSERT OR IGNORE INTO project_workspaces(project_id, workspace_id, linked_by, linked_at) VALUES (?, ?, NULL, ?)');
    const mark = db.prepare('INSERT OR IGNORE INTO workspace_link_migrated(workspace_id) VALUES (?)');
    for (const row of pending) {
      linked += Number(link.run(row['project_id'] as string, row['id'] as string, (row['created_at'] as number) ?? now).changes);
      mark.run(row['id'] as string);
    }
    // 同一 (团队, 机器, 目录) 的活跃长期登记：保留最早的，其余合并
    const dupes = db
      .prepare(
        "SELECT COALESCE(team_id, '') AS t, COALESCE(worker_id, '') AS w, path FROM workspaces " +
          "WHERE kind = 'long_lived' AND state <> 'removed' GROUP BY t, w, path HAVING COUNT(*) > 1"
      )
      .all() as Row[];
    for (const dupe of dupes) {
      const rows = db
        .prepare(
          "SELECT id FROM workspaces WHERE kind = 'long_lived' AND state <> 'removed' AND COALESCE(team_id, '') = ? AND COALESCE(worker_id, '') = ? AND path = ? ORDER BY created_at ASC, id ASC"
        )
        .all(dupe['t'] as string, dupe['w'] as string, dupe['path'] as string) as Row[];
      const keep = rows[0]?.['id'] as string;
      for (const extra of rows.slice(1)) {
        const id = extra['id'] as string;
        db.prepare('INSERT OR IGNORE INTO project_workspaces(project_id, workspace_id, linked_by, linked_at) SELECT project_id, ?, linked_by, linked_at FROM project_workspaces WHERE workspace_id = ?').run(keep, id);
        db.prepare('DELETE FROM project_workspaces WHERE workspace_id = ?').run(id);
        db.prepare('UPDATE sessions SET workspace_id = ? WHERE workspace_id = ?').run(keep, id);
        db.prepare('UPDATE workspaces SET base_workspace_id = ? WHERE base_workspace_id = ?').run(keep, id);
        db.prepare("UPDATE workspaces SET state = 'removed', updated_at = ? WHERE id = ?").run(now, id);
        merged += 1;
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { linked, teamed, merged };
}
