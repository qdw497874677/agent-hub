import { DatabaseSync } from 'node:sqlite';
import type {
  Artifact,
  CanvasLayout,
  JournalEntry,
  Project,
  Seq,
  Session,
  SessionEvent,
  Task
} from '@agent-hub/domain';
import { asProjectId, asSessionId, asTaskId } from '@agent-hub/domain';
import { createSearch } from './search.ts';
import { createAccountRepositories } from './accounts.ts';
import type { AssetRepository, AssetReviewRepository, NotificationRepository, AssetSyncBoard, AuditLog, EnrollmentRepository, ToolGrantRepository, MessageStore, MemoryStore, MemoryIndex, MemorySettingsStore, LoginRepository, OneTimeTokenRepository, InviteRepository, SettingsRepository, TeamRepository, UserRepository } from '@agent-hub/domain';
import { createSqliteAccess } from './access.ts';
import type { AccessRepos } from '@agent-hub/domain';
import { SCHEMA } from './schema.ts';
import { cleanLegacyLogText, createWorkLogRepository, migrateTasksV2 } from './work-log.ts';
import { createToolGrantRepository } from './tool-grants.ts';
import { createSqliteMessageStore } from './messages.ts';
import { createSqliteMemoryIndex, createSqliteMemorySettings, createSqliteMemoryStore } from './memory.ts';
import { createEnrollmentRepository } from './enrollment.ts';
import { createAssetRepository, createAssetSyncBoard } from './assets.ts';
import { createAssetReviewRepository, createNotificationRepository } from './asset-review.ts';
import { WORKSPACE_SCHEMA, createWorkspaceRepository, migrateWorkspaces } from './workspaces.ts';
import { toArtifact, toJournalEntry, toProject, toSession, toTask } from './mappers.ts';
import type { RepositorySet } from './mappers.ts';

export interface SqliteStore extends RepositorySet {
  readonly search: ReturnType<typeof createSearch>;
  readonly users: UserRepository;
  readonly logins: LoginRepository;
  readonly teams: TeamRepository;
  readonly settings: SettingsRepository;
  readonly audit: AuditLog;
  readonly oneTimeTokens: OneTimeTokenRepository;
  readonly invites: InviteRepository;
  /** 能力层：工具授权（只存令牌 hash）与调用审计。 */
  readonly toolGrants: ToolGrantRepository;
  /** agent 间通信（ADR 0018）：消息队列、派生记录、项目配置、审计。 */
  readonly messages: MessageStore;
  readonly memory: { readonly store: MemoryStore; readonly index: MemoryIndex; readonly settings: MemorySettingsStore };
  /** 单台机器接入：Pairing Code 与 Worker 凭据（都只存 hash）。 */
  readonly enrollment: EnrollmentRepository;
  /** 资产中心：技能 / 指令、不可变版本、内容 blob、Worker 安装关系。 */
  readonly assets: AssetRepository;
  /** 每台 Worker 的资产同步状态（跨 hub 重启保留）。 */
  readonly assetSync: AssetSyncBoard;
  /** 资产审核：提交、评论、安装申请、审核设置（ADR 0016）。 */
  readonly assetReview: AssetReviewRepository;
  readonly notifications: NotificationRepository;
  /** ADR 0017：显式授权 + 团队自定义角色。 */
  readonly access: AccessRepos;
  /** 只给测试与 ops 用；内核永远拿不到它。 */
  readonly db: DatabaseSync;
  close(): void;
}

/**
 * 一个 store 实例 = 一个写者进程（server）。worker 不碰这个库，
 * 它只通过网关把事件送上来，序号由 server 分配。
 */
export function openSqliteStore(file: string): SqliteStore {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  // 老库补列：`CREATE TABLE IF NOT EXISTS` 不会给已有表加字段。
  const columns = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
  if (!columns.some((column) => column.name === 'options')) {
    db.exec("ALTER TABLE sessions ADD COLUMN options TEXT NOT NULL DEFAULT '{}'");
  }
  if (!columns.some((column) => column.name === 'option_spec')) {
    db.exec("ALTER TABLE sessions ADD COLUMN option_spec TEXT NOT NULL DEFAULT '[]'");
  }
  // 多机：会话绑在哪台 worker、项目目录在哪台机器上。老数据为 NULL = 「当初就在唯一那台上」。
  if (!columns.some((column) => column.name === 'worker_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN worker_id TEXT');
  }
  const projectColumns = db.prepare('PRAGMA table_info(projects)').all() as { name: string }[];
  if (!projectColumns.some((column) => column.name === 'worker_id')) {
    db.exec('ALTER TABLE projects ADD COLUMN worker_id TEXT');
  }
  if (!projectColumns.some((column) => column.name === 'directories')) {
    db.exec("ALTER TABLE projects ADD COLUMN directories TEXT NOT NULL DEFAULT '{}'");
  }
  if (!projectColumns.some((column) => column.name === 'repo_url')) {
    db.exec('ALTER TABLE projects ADD COLUMN repo_url TEXT');
    db.exec('ALTER TABLE projects ADD COLUMN repo_default_branch TEXT');
  }
  // 团队与归属（ADR 0011）：只加列。NULL 的老数据在账号迁移后归到 hub 管理员的团队、算他建的。
  if (!projectColumns.some((column) => column.name === 'team_id')) db.exec('ALTER TABLE projects ADD COLUMN team_id TEXT');
  if (!projectColumns.some((column) => column.name === 'created_by')) db.exec('ALTER TABLE projects ADD COLUMN created_by TEXT');
  if (!projectColumns.some((column) => column.name === 'members')) db.exec("ALTER TABLE projects ADD COLUMN members TEXT NOT NULL DEFAULT '[]'");
  if (!projectColumns.some((column) => column.name === 'deleted_at')) db.exec('ALTER TABLE projects ADD COLUMN deleted_at INTEGER');
  if (!projectColumns.some((column) => column.name === 'description')) {
    db.exec('ALTER TABLE projects ADD COLUMN description TEXT');
  }
  if (!columns.some((column) => column.name === 'workspace_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN workspace_id TEXT');
  }
  // ADR 0017：会话创建者（说话 / 中断只给他）。老会话从审计里的 session.start / session.fork 回填。
  const addedCreatedBy = !columns.some((column) => column.name === 'created_by');
  if (addedCreatedBy) db.exec('ALTER TABLE sessions ADD COLUMN created_by TEXT');
  db.exec(WORKSPACE_SCHEMA);
  migrateTasksV2(db);
  migrateWorkspaces(db);
  cleanLegacyLogText(db);
  const layoutColumns = db.prepare('PRAGMA table_info(layout)').all() as { name: string }[];
  if (!layoutColumns.some((column) => column.name === 'sizes')) {
    db.exec("ALTER TABLE layout ADD COLUMN sizes TEXT NOT NULL DEFAULT '{}'");
  }

  const insertProject = db.prepare(
    'INSERT INTO projects(id, name, root_path, worker_id, directories, repo_url, repo_default_branch, description, created_at, team_id, created_by, members, deleted_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
      // root_path / worker_id / directories 是 W1 之前的旧列：只留给迁移读，不再写
      'ON CONFLICT(id) DO UPDATE SET name = excluded.name, repo_url = excluded.repo_url, repo_default_branch = excluded.repo_default_branch, description = excluded.description, ' +
      'team_id = excluded.team_id, created_by = excluded.created_by, members = excluded.members, deleted_at = excluded.deleted_at'
  );
  const selectProject = db.prepare('SELECT * FROM projects WHERE id = ?');
  const selectProjects = db.prepare('SELECT * FROM projects WHERE deleted_at IS NULL ORDER BY created_at DESC');
  const selectDeletedProjects = db.prepare('SELECT * FROM projects WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC');

  const upsertTask = db.prepare(
    'INSERT INTO tasks(id, project_id, title, goal, status, owner_id, branch, summary, log_seq, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET title = excluded.title, goal = excluded.goal, ' +
      'status = excluded.status, owner_id = excluded.owner_id, branch = excluded.branch, summary = excluded.summary, ' +
      'log_seq = MAX(tasks.log_seq, excluded.log_seq), updated_at = excluded.updated_at'
  );
  const selectTask = db.prepare('SELECT * FROM tasks WHERE id = ?');
  const selectTasksByProject = db.prepare(
    'SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at ASC'
  );

  const upsertSession = db.prepare(
    'INSERT INTO sessions(id, task_id, agent_id, model, origin_kind, origin_session, origin_seq, ' +
      'status, last_seq, agent_session, options, option_spec, worker_id, workspace_id, created_by, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET model = excluded.model, status = excluded.status, ' +
      'last_seq = excluded.last_seq, agent_session = excluded.agent_session, ' +
      'options = excluded.options, option_spec = excluded.option_spec, worker_id = excluded.worker_id, workspace_id = excluded.workspace_id, ' +
      'updated_at = excluded.updated_at'
  );
  const selectSession = db.prepare('SELECT * FROM sessions WHERE id = ?');
  const selectSessionsByTask = db.prepare(
    'SELECT * FROM sessions WHERE task_id = ? ORDER BY created_at ASC'
  );
  const selectSessionsByProject = db.prepare(
    'SELECT s.* FROM sessions s JOIN tasks t ON t.id = s.task_id ' +
      'WHERE t.project_id = ? ORDER BY s.created_at ASC'
  );
  const selectAllSessions = db.prepare('SELECT * FROM sessions ORDER BY created_at ASC');
  const appendJournal = db.prepare(
    'INSERT OR IGNORE INTO journal(session_id, seq, type, payload, at) VALUES (?, ?, ?, ?, ?)'
  );
  // 文本投影跟着 append 走：搜索读的是「这个会话说过的话」，不是单条 delta。
  const appendSessionText = db.prepare(
    'INSERT INTO session_text(session_id, text, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(session_id) DO UPDATE SET text = session_text.text || excluded.text, updated_at = excluded.updated_at'
  );
  const updateSessionCursor = db.prepare(
    'UPDATE sessions SET last_seq = ?, status = ?, updated_at = ? WHERE id = ?'
  );
  const selectEventsTail = db.prepare(
    'SELECT seq, payload, at FROM journal WHERE session_id = ? ORDER BY seq DESC LIMIT ?'
  );
  const selectEventsAfter = db.prepare(
    'SELECT seq, payload, at FROM journal WHERE session_id = ? AND seq > ? ORDER BY seq ASC'
  );
  const insertEntryMap = db.prepare(
    'INSERT OR REPLACE INTO entry_map(session_id, seq, entry_id) VALUES (?, ?, ?)'
  );
  const selectEntryId = db.prepare(
    'SELECT entry_id FROM entry_map WHERE session_id = ? AND seq = ?'
  );

  const upsertArtifact = db.prepare(
    'INSERT INTO artifacts(id, session_id, task_id, path, bytes, label, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING'
  );
  const selectArtifactsBySession = db.prepare(
    'SELECT * FROM artifacts WHERE session_id = ? ORDER BY created_at ASC'
  );
  const selectArtifactsByTask = db.prepare(
    'SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at ASC'
  );

  const upsertLayout = db.prepare(
    'INSERT INTO layout(project_id, positions, sizes, updated_at) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(project_id) DO UPDATE SET positions = excluded.positions, sizes = excluded.sizes, ' +
      'updated_at = excluded.updated_at'
  );
  const selectLayout = db.prepare('SELECT * FROM layout WHERE project_id = ?');

  const sessionsOf = 'SELECT s.id FROM sessions s JOIN tasks t ON t.id = s.task_id WHERE t.project_id = ?';
  const removeProjectStatements = [
    `DELETE FROM entry_map WHERE session_id IN (${sessionsOf})`,
    `DELETE FROM session_text WHERE session_id IN (${sessionsOf})`,
    `DELETE FROM journal WHERE session_id IN (${sessionsOf})`,
    `DELETE FROM artifacts WHERE session_id IN (${sessionsOf})`,
    'DELETE FROM sessions WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)',
    'DELETE FROM task_log_entries WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)',
    'DELETE FROM tasks WHERE project_id = ?',
    'DELETE FROM layout WHERE project_id = ?',
    'DELETE FROM workspaces WHERE project_id = ?',
    'DELETE FROM projects WHERE id = ?'
  ].map((sql) => db.prepare(sql));

  function transaction(work: () => void): void {
    db.exec('BEGIN IMMEDIATE');
    try {
      work();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function originColumns(session: Session): [string, string | null, number | null] {
    return session.origin.kind === 'fork'
      ? ['fork', session.origin.fromSessionId, session.origin.atSeq]
      : ['derive', null, null];
  }

  const projects = {
    async save(project: Project): Promise<void> {
      insertProject.run(
        project.id,
        project.name,
        '',
        null,
        '{}',
        project.repo?.url ?? null,
        project.repo?.defaultBranch ?? null,
        project.description,
        project.createdAt,
        project.teamId,
        project.createdBy,
        JSON.stringify(project.members),
        project.deletedAt
      );
    },
    async listDeleted(): Promise<Project[]> {
      return selectDeletedProjects.all().map((row) => toProject(row));
    },
    async byId(id: Parameters<typeof asProjectId>[0]): Promise<Project | null> {
      const row = selectProject.get(id);
      return row ? toProject(row) : null;
    },
    async list(): Promise<Project[]> {
      return selectProjects.all().map((row) => toProject(row));
    },
    /** 子表先删（外键）；同一次提交，删一半不会留下孤儿。 */
    async remove(id: Parameters<typeof asProjectId>[0]): Promise<void> {
      transaction(() => {
        for (const statement of removeProjectStatements) statement.run(id);
      });
    }
  };

  const tasks = {
    async save(task: Task): Promise<void> {
      upsertTask.run(
        task.id,
        task.projectId,
        task.title,
        task.goal ?? null,
        task.status,
        task.ownerId,
        task.branch,
        task.summary,
        task.logSeq,
        task.createdAt,
        task.updatedAt
      );
    },
    async byId(id: Parameters<typeof asTaskId>[0]): Promise<Task | null> {
      const row = selectTask.get(id);
      return row ? toTask(row) : null;
    },
    async listByProject(projectId: Parameters<typeof asProjectId>[0]): Promise<Task[]> {
      return selectTasksByProject.all(projectId).map((row) => toTask(row));
    }
  };

  const sessions = {
    async save(session: Session): Promise<void> {
      const [kind, from, seq] = originColumns(session);
      upsertSession.run(
        session.id,
        session.taskId,
        session.agentId,
        session.model,
        kind,
        from,
        seq,
        session.status,
        session.lastSeq,
        session.agentSessionRef,
        JSON.stringify(session.options),
        JSON.stringify(session.optionSpec),
        session.workerId,
        session.workspaceId,
        session.createdBy ?? null,
        session.createdAt,
        session.updatedAt
      );
    },
    async byId(id: Parameters<typeof asSessionId>[0]): Promise<Session | null> {
      const row = selectSession.get(id);
      return row ? toSession(row) : null;
    },
    async listByTask(taskId: Parameters<typeof asTaskId>[0]): Promise<Session[]> {
      return selectSessionsByTask.all(taskId).map((row) => toSession(row));
    },
    async listByProject(projectId: Parameters<typeof asProjectId>[0]): Promise<Session[]> {
      return selectSessionsByProject.all(projectId).map((row) => toSession(row));
    },
    async listAll(): Promise<Session[]> {
      return selectAllSessions.all().map((row) => toSession(row));
    },
    /** 事件与游标必须同一次提交，否则崩溃会留下"库里多了事件但 seq 没动"。 */
    async append(session: Session, event: SessionEvent, at: number): Promise<void> {
      transaction(() => {
        appendJournal.run(
          session.id,
          session.lastSeq,
          event.kind,
          JSON.stringify(event),
          at
        );
        if (event.kind === 'text') appendSessionText.run(session.id, event.delta, at);
        updateSessionCursor.run(session.lastSeq, session.status, session.updatedAt, session.id);
      });
    },
    async eventsAfter(sessionId: Parameters<typeof asSessionId>[0], seq: Seq): Promise<JournalEntry[]> {
      return selectEventsAfter
        .all(sessionId, seq)
        .map((row) => toJournalEntry(row));
    },
    async tail(
      sessionId: Parameters<typeof asSessionId>[0],
      limit: number
    ): Promise<JournalEntry[]> {
      // DESC 取尾部再翻回来：正序切片要先数完整个会话，会话越长越慢。
      return selectEventsTail
        .all(sessionId, limit)
        .reverse()
        .map((row) => toJournalEntry(row));
    },
    async linkEntry(sessionId: Parameters<typeof asSessionId>[0], seq: Seq, entryId: string): Promise<void> {
      insertEntryMap.run(sessionId, seq, entryId);
    },
    async entryIdAt(sessionId: Parameters<typeof asSessionId>[0], seq: Seq): Promise<string | null> {
      const row = selectEntryId.get(sessionId, seq) as { entry_id?: string } | undefined;
      return row?.entry_id ?? null;
    }
  };

  const artifacts = {
    async save(artifact: Artifact): Promise<void> {
      upsertArtifact.run(
        artifact.id,
        artifact.sessionId,
        artifact.taskId,
        artifact.path,
        artifact.bytes,
        artifact.label,
        artifact.createdAt
      );
    },
    async bySession(sessionId: Parameters<typeof asSessionId>[0]): Promise<Artifact[]> {
      return selectArtifactsBySession.all(sessionId).map((row) => toArtifact(row));
    },
    async byTask(taskId: Parameters<typeof asTaskId>[0]): Promise<Artifact[]> {
      return selectArtifactsByTask.all(taskId).map((row) => toArtifact(row));
    }
  };

  const layout = {
    async load(projectId: Parameters<typeof asProjectId>[0]): Promise<CanvasLayout | null> {
      const row = selectLayout.get(projectId) as { positions?: string; sizes?: string; updated_at?: number } | undefined;
      if (!row?.positions) return null;
      return {
        projectId: asProjectId(projectId),
        positions: JSON.parse(row.positions) as CanvasLayout['positions'],
        sizes: JSON.parse(row.sizes ?? '{}') as CanvasLayout['sizes'],
        updatedAt: row.updated_at ?? 0
      };
    },
    async save(value: CanvasLayout): Promise<void> {
      upsertLayout.run(value.projectId, JSON.stringify(value.positions), JSON.stringify(value.sizes), value.updatedAt);
    }
  };

  const accountRepos = createAccountRepositories(db);
  backfillSessionCreators(db);
  backfillProjectTeams(db);
  return {
    projects,
    tasks,
    workLog: createWorkLogRepository(db),
    toolGrants: createToolGrantRepository(db),
    messages: createSqliteMessageStore(db),
    memory: { store: createSqliteMemoryStore(db), index: createSqliteMemoryIndex(db), settings: createSqliteMemorySettings(db) },
    workspaces: createWorkspaceRepository(db),
    enrollment: createEnrollmentRepository(db),
    assets: createAssetRepository(db),
    assetSync: createAssetSyncBoard(db),
    assetReview: createAssetReviewRepository(db),
    notifications: createNotificationRepository(db),
    sessions,
    artifacts,
    layout,
    search: createSearch(db),
    ...accountRepos,
    access: createSqliteAccess(db),
    db,
    close(): void {
      db.close();
    }
  };
}

/** 老项目（team_id 为 NULL）归 hub 管理员的团队、算 hub 管理员建的。幂等；还没有 hub 管理员时什么也不做。 */
export function backfillProjectTeams(db: DatabaseSync): void {
  const admin = db.prepare('SELECT id, team_id FROM users WHERE hub_admin = 1 AND team_id IS NOT NULL ORDER BY created_at ASC LIMIT 1').get() as
    | { id: string; team_id: string }
    | undefined;
  if (!admin) return;
  db.prepare('UPDATE projects SET team_id = ? WHERE team_id IS NULL').run(admin.team_id);
  db.prepare('UPDATE projects SET created_by = ? WHERE created_by IS NULL').run(admin.id);
}

/** 老会话的 created_by：取审计里最早的 session.start / session.fork 操作人。幂等，每次启动只补还空着的。 */
function backfillSessionCreators(db: DatabaseSync): void {
  db.exec(
    "UPDATE sessions SET created_by = (SELECT a.actor_id FROM audit_log a WHERE a.target = sessions.id " +
      "AND a.action IN ('session.start', 'session.fork') ORDER BY a.at LIMIT 1) WHERE created_by IS NULL"
  );
}
