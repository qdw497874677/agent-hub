import type { DatabaseSync } from 'node:sqlite';
import type {
  ProjectWorkspaceLink,
  Workspace,
  WorkspaceClaim,
  WorkspaceClaimOutcome,
  WorkspaceRepository,
  WorkspaceSaveOutcome,
  WorkspaceTransfer,
  WorkspaceTransferOutcome
} from '@agent-hub/domain';
import { asProjectId, asTaskId, asWorkspaceGroupId, asWorkspaceId, newWorkspaceId, normalizePath, type WorkspaceId } from '@agent-hub/domain';
import { inTransaction } from './tx.ts';

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
-- #233：给团队 / 机器 / 目录的活跃登记加查询索引（非唯一，不清理老数据；唯一性由 save/claim 事务保证）。
CREATE INDEX IF NOT EXISTS workspaces_by_team_place ON workspaces(COALESCE(team_id, ''), COALESCE(worker_id, ''), path);
CREATE TABLE IF NOT EXISTS project_workspaces (
  project_id   TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  linked_by    TEXT,
  linked_at    INTEGER NOT NULL,
  PRIMARY KEY (project_id, workspace_id)
);
-- workspace_id 的唯一索引由 ensureSingleWorkspaceOwner 在去重之后建（老库可能还有多条认领）。
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

const LINKS_SQL = 'SELECT * FROM project_workspaces WHERE workspace_id = ? ORDER BY linked_at ASC, project_id ASC';
const INSERT_LINK_SQL = 'INSERT INTO project_workspaces(project_id, workspace_id, linked_by, linked_at) VALUES (?, ?, ?, ?)';
// 同团队 / 机器下的活跃长期登记；路径在 JS 里 normalize 后再比，兼容老数据里没归一化的写法。
const LIVE_PLACE_SQL =
  "SELECT * FROM workspaces WHERE kind = 'long_lived' AND state <> 'removed' AND id <> ? " +
  "AND COALESCE(team_id, '') = COALESCE(?, '') AND COALESCE(worker_id, '') = COALESCE(?, '') " +
  'ORDER BY created_at ASC, id ASC';

function toLink(row: Row): ProjectWorkspaceLink {
  return {
    projectId: asProjectId(row['project_id'] as string),
    workspaceId: asWorkspaceId(row['workspace_id'] as string),
    linkedBy: (row['linked_by'] as string | null) ?? null,
    linkedAt: row['linked_at'] as number
  };
}

function linksIn(db: DatabaseSync, workspaceId: WorkspaceId): ProjectWorkspaceLink[] {
  return (db.prepare(LINKS_SQL).all(workspaceId) as Row[]).map(toLink);
}

function insertLinkIn(db: DatabaseSync, link: ProjectWorkspaceLink): void {
  db.prepare(INSERT_LINK_SQL).run(link.projectId, link.workspaceId, link.linkedBy, link.linkedAt);
}

/** 同一团队 / 机器 / 归一化目录上的其他活跃长期登记（不含自己）。 */
function placePeersIn(db: DatabaseSync, workspace: Workspace): Workspace[] {
  const path = normalizePath(workspace.path);
  return (db.prepare(LIVE_PLACE_SQL).all(workspace.id, workspace.teamId, workspace.workerId) as Row[])
    .map(toWorkspace)
    .filter((peer) => normalizePath(peer.path) === path);
}

/**
 * 历史重复行保护：工作空间自己在同一位置还有别的活跃登记时，认领 / 转移都可能让两条重复登记
 * 继续分属不同项目，所以先显式拒绝；不替调用方挑一条，也不改动任何一行。
 */
function ambiguousIn(db: DatabaseSync, workspaceId: WorkspaceId): Workspace[] | null {
  const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) as Row | undefined;
  if (!row) return null;
  const workspace = toWorkspace(row);
  if (workspace.kind !== 'long_lived' || workspace.state === 'removed') return null;
  const peers = placePeersIn(db, workspace);
  return peers.length > 0 ? [workspace, ...peers] : null;
}

/**
 * #233：检查与写入必须在调用方的 BEGIN IMMEDIATE 里。同项目 → owned（保留原元数据）；
 * 别的项目 → conflict（现任不动）；空 → 新认领。绝不 REPLACE。
 * 导出让 store.ts 把「建项目 + 认领已有工作空间」放进同一次事务。
 */
export function claimWorkspaceInTransaction(db: DatabaseSync, c: WorkspaceClaim): WorkspaceClaimOutcome {
  const current = linksIn(db, c.workspaceId);
  const ambiguous = ambiguousIn(db, c.workspaceId);
  if (ambiguous) {
    // 已经是这个项目、且没有别的认领：幂等成功，不算「建立新归属」。
    if (current.length === 1 && current[0]!.projectId === c.projectId) return { status: 'owned', link: current[0]! };
    return { status: 'ambiguous', candidates: ambiguous };
  }
  const same = current.find((l) => l.projectId === c.projectId);
  if (same) return { status: 'owned', link: same };
  if (current.length > 0) return { status: 'conflict', owner: current[0]! };
  const link: ProjectWorkspaceLink = {
    projectId: c.projectId,
    workspaceId: c.workspaceId,
    linkedBy: c.linkedBy,
    linkedAt: c.linkedAt
  };
  insertLinkIn(db, link);
  return { status: 'claimed', link };
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
  const longLived = db.prepare("SELECT * FROM workspaces WHERE kind = 'long_lived' AND state <> 'removed' ORDER BY created_at ASC");
  const deleteOtherLinks = db.prepare('DELETE FROM project_workspaces WHERE workspace_id = ? AND project_id <> ?');
  const unlink = db.prepare('DELETE FROM project_workspaces WHERE project_id = ? AND workspace_id = ?');
  const byTask = db.prepare('SELECT * FROM workspaces WHERE owner_task_id = ? ORDER BY created_at ASC');
  const temporaries = db.prepare("SELECT * FROM workspaces WHERE kind = 'temporary' AND state <> 'removed' ORDER BY created_at ASC");
  const onMachine = db.prepare("SELECT * FROM workspaces WHERE worker_id IS ? AND state <> 'removed' ORDER BY created_at ASC");

  /**
   * #233：只有当前「其他认领者」与调用方观察到的 expectedProjectIds 完全一致才替换；
   * 不一致 → stale，一行都不改。这样转移期间别人的新认领不会被覆盖。
   */
  const transferInTx = (t: WorkspaceTransfer): WorkspaceTransferOutcome => {
    const current = linksIn(db, t.workspaceId);
    const others = current.filter((l) => l.projectId !== t.projectId);
    const expected = [...new Set(t.expectedProjectIds)].map(String).sort();
    const actual = others.map((l) => String(l.projectId)).sort();
    const sameSet = expected.length === actual.length && expected.every((id, i) => id === actual[i]);
    if (!sameSet) return { status: 'stale', owner: others[0] ?? null };
    const existing = current.find((l) => l.projectId === t.projectId);
    if (others.length === 0) {
      if (existing) return { status: 'owned', link: existing };
      insertLinkIn(db, { projectId: t.projectId, workspaceId: t.workspaceId, linkedBy: t.linkedBy, linkedAt: t.linkedAt });
      return {
        status: 'transferred',
        link: { projectId: t.projectId, workspaceId: t.workspaceId, linkedBy: t.linkedBy, linkedAt: t.linkedAt }
      };
    }
    deleteOtherLinks.run(t.workspaceId, t.projectId);
    if (existing) return { status: 'transferred', link: existing };
    insertLinkIn(db, { projectId: t.projectId, workspaceId: t.workspaceId, linkedBy: t.linkedBy, linkedAt: t.linkedAt });
    return {
      status: 'transferred',
      link: { projectId: t.projectId, workspaceId: t.workspaceId, linkedBy: t.linkedBy, linkedAt: t.linkedAt }
    };
  };

  const uniqueViolation = (error: unknown): boolean =>
    error instanceof Error && /UNIQUE constraint failed/i.test(error.message);

  return {
    async save(w): Promise<WorkspaceSaveOutcome> {
      // 目录唯一性检查 + 写入 + 自动关联都在同一个 BEGIN IMMEDIATE 里（#233 / ADR 0026 §6）。
      return inTransaction(db, () => {
        const target: Workspace = { ...w, path: normalizePath(w.path) };
        const currentRow = byId.get(target.id) as Row | undefined;
        const previous = currentRow === undefined ? null : toWorkspace(currentRow);
        const fresh = previous === null;
        const moved =
          previous !== null &&
          (previous.teamId !== target.teamId ||
            previous.workerId !== target.workerId ||
            normalizePath(previous.path) !== target.path);
        const liveLongLived = target.kind === 'long_lived' && target.state !== 'removed';
        const wasLiveLongLived = previous !== null && previous.kind === 'long_lived' && previous.state !== 'removed';
        // 除了新建 / 换目录，已删除或临时登记在同一路径「复活」成长期也要过唯一性检查，
        // 否则会悄悄多出一条活跃长期登记。
        const becomingLive = liveLongLived && !wasLiveLongLived;
        if (liveLongLived && (fresh || moved || becomingLive)) {
          const peers = placePeersIn(db, target);
          if (peers.length > 1) return { status: 'ambiguous', candidates: peers };
          const peer = peers[0];
          // 同位置已经有唯一登记：复用现任，不插入第二条，也不改现任的元数据 / 认领。
          if (fresh && peer) return { status: 'existing', workspace: peer };
          // 已有登记换目录 / 复活，撞上别的登记：不静默改写，让人显式处理。
          if (!fresh && peer) return { status: 'place-taken', existing: peer };
        }
        let projectId = target.projectId;
        if (fresh && target.kind === 'long_lived' && target.projectId !== null) {
          const outcome = claimWorkspaceInTransaction(db, { projectId: target.projectId, workspaceId: target.id, linkedBy: null, linkedAt: target.createdAt });
          if (outcome.status === 'conflict') {
            // 已有别的项目认领：这行按团队级工作空间保存，不留下和关联表矛盾的 project_id。
            projectId = null;
            console.warn(
              `[storage] 工作空间 ${target.id} 已属于项目 ${outcome.owner.projectId}，保存时不再关联到项目 ${target.projectId}`
            );
          }
        }
        upsert.run(
          target.id, projectId, target.teamId, target.repoUrl, target.workerId, target.path, target.kind, target.source, target.baseWorkspaceId,
          target.branch, target.ownerTaskId, target.label, target.isGit === null ? null : target.isGit ? 1 : 0, target.state, target.keptReason,
          target.setup ? JSON.stringify(target.setup) : null, target.groupId ?? null, target.createdAt, target.updatedAt
        );
        // 自动认领冲突时 projectId 可能被置空，返回真正落库的行，调用方看到的和库里一致。
        return { status: 'saved', workspace: toWorkspace(byId.get(target.id) as Row) };
      });
    },
    async longLived() {
      return (longLived.all() as Row[]).map(toWorkspace);
    },
    async claim(c) {
      try {
        return inTransaction(db, () => {
          const ambiguous = ambiguousIn(db, c.workspaceId);
          if (ambiguous) {
            // 已经是这个项目、且没有别的认领：幂等成功，不算「建立新归属」。
            const current = linksIn(db, c.workspaceId);
            if (current.length === 1 && current[0]!.projectId === c.projectId) return { status: 'owned', link: current[0]! };
            return { status: 'ambiguous', candidates: ambiguous };
          }
          return claimWorkspaceInTransaction(db, c);
        });
      } catch (error) {
        if (!uniqueViolation(error)) throw error;
        // 唯一索引兜底：事务已回滚，重新读取现任（另一个连接刚刚抢先写入）。
        const current = linksIn(db, c.workspaceId);
        const same = current.find((l) => l.projectId === c.projectId);
        if (same) return { status: 'owned', link: same };
        if (current.length > 0) return { status: 'conflict', owner: current[0]! };
        throw error;
      }
    },
    async transfer(t) {
      try {
        return inTransaction(db, () => {
          const ambiguous = ambiguousIn(db, t.workspaceId);
          if (ambiguous) {
            // 当前只有目标项目一个认领：转移是空操作，允许幂等返回，不借机改任何行。
            const current = linksIn(db, t.workspaceId);
            if (current.length === 1 && current[0]!.projectId === t.projectId) return { status: 'owned', link: current[0]! };
            return { status: 'ambiguous', candidates: ambiguous };
          }
          return transferInTx(t);
        });
      } catch (error) {
        if (!uniqueViolation(error)) throw error;
        const current = linksIn(db, t.workspaceId);
        return { status: 'stale', owner: current.find((l) => l.projectId !== t.projectId) ?? null };
      }
    },
    async unlink(projectId, workspaceId) {
      unlink.run(projectId, workspaceId);
    },
    async linksOf(workspaceId) {
      return linksIn(db, workspaceId);
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

/**
 * 独占归属（2026-11）：一个长期工作空间同一时间只能被一个项目认领。
 * 1. 兜底去重：每个 workspace_id 只保留一条认领。优先保留「还活着」的项目（projects.deleted_at IS NULL），
 *    其次是软删除但仍存在的项目，最后才是项目已不存在的悬空认领；同一档内沿用老规则（linked_at 最早、
 *    project_id 字典序最小），保证老库重复跑的结果稳定；
 * 2. 建 `project_workspaces(workspace_id)` 唯一索引，之后由数据库兜底。
 * 幂等：重复跑没有重复行就什么都不删，索引 IF NOT EXISTS。
 *
 * 被删的每条认领都在同一事务里写 audit_log（actor=system，action=workspace.owner.reconcile），
 * 带 workspace_id / project_id / linked_at / survivor 及两边的 live|deleted|dangling 分类。事务回滚时
 * 审计一起回滚。只有调用前 audit_log 还不存在（裸 DatabaseSync 的单测）时才退化为提交后的结构化 console
 * 日志——日志只在 COMMIT 之后输出，不会记录未落地的清理。
 */
export function ensureSingleWorkspaceOwner(db: DatabaseSync): number {
  let removed = 0;
  const records: {
    workspaceId: string;
    projectId: string;
    linkedAt: number;
    projectState: 'live' | 'deleted' | 'dangling';
    survivorProjectId: string;
    survivorLinkedAt: number;
    survivorState: 'live' | 'deleted' | 'dangling';
  }[] = [];
  const auditReady =
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'").get() !== undefined;
  db.exec('BEGIN IMMEDIATE');
  try {
    const dupes = db
      .prepare('SELECT workspace_id FROM project_workspaces GROUP BY workspace_id HAVING COUNT(*) > 1')
      .all() as Row[];
    const claimsOf = db.prepare(
      'SELECT pw.project_id, pw.linked_at, ' +
        'CASE WHEN p.id IS NULL THEN 2 WHEN p.deleted_at IS NOT NULL THEN 1 ELSE 0 END AS rank ' +
        'FROM project_workspaces pw LEFT JOIN projects p ON p.id = pw.project_id ' +
        'WHERE pw.workspace_id = ? ORDER BY rank ASC, pw.linked_at ASC, pw.project_id ASC'
    );
    const removeClaim = db.prepare('DELETE FROM project_workspaces WHERE workspace_id = ? AND project_id = ?');
    // 只写老 schema 就有的列：老库的 audit_log 可能还没有 ip / team_id。
    const insertAudit = auditReady
      ? db.prepare(
          'INSERT INTO audit_log(id, actor_id, actor_email, action, target, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
      : null;
    const stateOf = (rank: number): 'live' | 'deleted' | 'dangling' =>
      rank === 0 ? 'live' : rank === 1 ? 'deleted' : 'dangling';
    for (const dupe of dupes) {
      const workspaceId = dupe['workspace_id'] as string;
      const claims = claimsOf.all(workspaceId) as Row[];
      const survivor = claims[0];
      if (survivor === undefined) continue;
      const survivorProjectId = survivor['project_id'] as string;
      const survivorLinkedAt = Number(survivor['linked_at']);
      const survivorState = stateOf(Number(survivor['rank']));
      for (const claim of claims.slice(1)) {
        const projectId = claim['project_id'] as string;
        const linkedAt = Number(claim['linked_at']);
        const projectState = stateOf(Number(claim['rank']));
        const changes = Number(removeClaim.run(workspaceId, projectId).changes);
        if (changes === 0) continue;
        removed += changes;
        const record = {
          workspaceId,
          projectId,
          linkedAt,
          projectState,
          survivorProjectId,
          survivorLinkedAt,
          survivorState
        };
        records.push(record);
        insertAudit?.run(
          globalThis.crypto.randomUUID(),
          'system',
          '',
          'workspace.owner.reconcile',
          workspaceId,
          JSON.stringify({
            projectId,
            linkedAt,
            projectState,
            survivorProjectId,
            survivorLinkedAt,
            survivorState
          }),
          Date.now()
        );
      }
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS project_workspaces_workspace ON project_workspaces(workspace_id)');
    db.exec('DROP INDEX IF EXISTS project_workspaces_by_workspace');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  if (removed > 0) {
    if (auditReady) {
      console.log(
        `[storage] 工作空间独占归属迁移：清理了 ${removed} 条重复认领，每个目录只保留一条认领（优先 live 项目，audit_log action=workspace.owner.reconcile）`
      );
    } else {
      // 没有 audit_log 的裸库：提交后逐条输出，格式与审计 detail 一致，便于直接检索。
      for (const record of records) console.log(`[storage] workspace.owner.reconcile ${JSON.stringify(record)}`);
    }
  }
  return removed;
}
