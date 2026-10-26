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
import type { AuditLog, EnrollmentRepository, ToolGrantRepository, LoginRepository, SettingsRepository, UserRepository } from '@agent-hub/domain';
import { SCHEMA } from './schema.ts';
import { cleanLegacyLogText, createWorkLogRepository, migrateTasksV2 } from './work-log.ts';
import { createToolGrantRepository } from './tool-grants.ts';
import { createEnrollmentRepository } from './enrollment.ts';
import { WORKSPACE_SCHEMA, createWorkspaceRepository, migrateWorkspaces } from './workspaces.ts';
import { toArtifact, toJournalEntry, toProject, toSession, toTask } from './mappers.ts';
import type { RepositorySet } from './mappers.ts';

export interface SqliteStore extends RepositorySet {
  readonly search: ReturnType<typeof createSearch>;
  readonly users: UserRepository;
  readonly logins: LoginRepository;
  readonly settings: SettingsRepository;
  readonly audit: AuditLog;
  /** 能力层：工具授权（只存令牌 hash）与调用审计。 */
  readonly toolGrants: ToolGrantRepository;
  /** 单台机器接入：Pairing Code 与 Worker 凭据（都只存 hash）。 */
  readonly enrollment: EnrollmentRepository;
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
  if (!columns.some((column) => column.name === 'workspace_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN workspace_id TEXT');
  }
  db.exec(WORKSPACE_SCHEMA);
  migrateTasksV2(db);
  migrateWorkspaces(db);
  cleanLegacyLogText(db);
  const layoutColumns = db.prepare('PRAGMA table_info(layout)').all() as { name: string }[];
  if (!layoutColumns.some((column) => column.name === 'sizes')) {
    db.exec("ALTER TABLE layout ADD COLUMN sizes TEXT NOT NULL DEFAULT '{}'");
  }

  const insertProject = db.prepare(
    'INSERT INTO projects(id, name, root_path, worker_id, directories, created_at) VALUES (?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET name = excluded.name, root_path = excluded.root_path, worker_id = excluded.worker_id, ' +
      'directories = excluded.directories'
  );
  const selectProject = db.prepare('SELECT * FROM projects WHERE id = ?');
  const selectProjects = db.prepare('SELECT * FROM projects ORDER BY created_at DESC');

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
      'status, last_seq, agent_session, options, option_spec, worker_id, workspace_id, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
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
      insertProject.run(project.id, project.name, project.rootPath, project.workerId, JSON.stringify(project.directories), project.createdAt);
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

  return {
    projects,
    tasks,
    workLog: createWorkLogRepository(db),
    toolGrants: createToolGrantRepository(db),
    workspaces: createWorkspaceRepository(db),
    enrollment: createEnrollmentRepository(db),
    sessions,
    artifacts,
    layout,
    search: createSearch(db),
    ...createAccountRepositories(db),
    db,
    close(): void {
      db.close();
    }
  };
}
