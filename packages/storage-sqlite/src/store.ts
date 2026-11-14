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
import type { AssetRepository, AssetReviewRepository, NotificationRepository, AssetSyncBoard, AuditLog, EnrollmentRepository, ToolGrantRepository, MessageStore, GroupStore, ContextSettingsStore, SessionBaseStore, CheckpointStore,
  TurnRefStore, DeliveryQueue, ProvenanceStore, AttentionStore, MemoryStore, MemoryIndex, MemorySettingsStore, LoginRepository, OneTimeTokenRepository, InviteRepository, SettingsRepository, TeamRepository, UserRepository, SessionLinkRepository, AgentProfileRepository, BotRepository, WorkerAgentsRepository } from '@agent-hub/domain';
import { createSqliteAccess } from './access.ts';
import type { AccessRepos } from '@agent-hub/domain';
import { SCHEMA } from './schema.ts';
import { cleanLegacyLogText, createWorkLogRepository, migrateTasksV2 } from './work-log.ts';
import { createToolGrantRepository } from './tool-grants.ts';
import { createSqliteMessageStore } from './messages.ts';
import { createSqliteSessionLinks } from './session-links.ts';
import { createSqlitePreviewLinks } from './preview-links.ts';
import { createSqliteAgentProfiles } from './agent-profiles.ts';
import { createSqliteBotRepository } from './bots.ts';
import { createSqliteWorkerAgents } from './worker-agents.ts';
import { createSqliteGroupStore } from './groups.ts';
import { createSqliteContextSettings } from './context-settings.ts';
import { createSqliteSessionBases } from './session-bases.ts';
import { createSqliteCheckpoints, createSqliteTurnRefs } from './turn-checkpoints.ts';
import { createSqliteDeliveries } from './deliveries.ts';
import { createSqliteProvenance } from './provenance.ts';
import { createSqliteConnectors } from './connectors.ts';
import { createSqliteTaskDispatch } from './task-dispatch.ts';
import { createSqliteAttention } from './attention.ts';
import { createSqliteMemoryIndex, createSqliteMemorySettings, createSqliteMemoryStore } from './memory.ts';
import { createEnrollmentRepository } from './enrollment.ts';
import { createAssetRepository, createAssetSyncBoard } from './assets.ts';
import { createAssetReviewRepository, createNotificationRepository } from './asset-review.ts';
import { WORKSPACE_SCHEMA, createWorkspaceRepository, migrateSharedWorkspaces, migrateWorkspaces, upgradeWorkspaceTable } from './workspaces.ts';
import { createSqliteWorkspaceGroups } from './workspace-groups.ts';
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
  readonly bots: BotRepository;
  /** 组合工作空间（docs/design/multi-repo.md）。 */
  readonly workspaceGroups: ReturnType<typeof createSqliteWorkspaceGroups>;
  /** 每台 Worker 的自定义运行时别名（CAP-1）。 */
  readonly workerAgents: WorkerAgentsRepository;
  readonly groups: GroupStore;
  /** 上下文策略的选择（ADR 0020）。 */
  readonly contextSettings: ContextSettingsStore;
  /** 会话开始时的 HEAD（ADR 0025）。 */
  readonly sessionBases: SessionBaseStore;
  /** 回合检查点（ADR 0027）。 */
  readonly checkpoints: CheckpointStore;
  readonly turnRefs: TurnRefStore;
  /** 送达队列（ADR 0031）。 */
  readonly deliveries: DeliveryQueue;
  readonly provenance: ProvenanceStore;
  readonly connectors: import('@agent-hub/domain').ConnectorStore;
  readonly agentTasks: import('@agent-hub/domain').AgentTaskStore;
  readonly dispatches: import('@agent-hub/domain').TaskDispatchStore;
  readonly attention: AttentionStore;
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
  /** 画布/对话页的会话连线（无向关系）。 */
  readonly links: SessionLinkRepository;
  /** 预览链接（docs/design/preview.md §4）：会话端口 → hub 端口的映射。 */
  readonly previewLinks: ReturnType<typeof createSqlitePreviewLinks>;
  /** 可复用的 Agent 启动配置（按 owner 隔离）。 */
  readonly agentProfiles: AgentProfileRepository;
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
  if (!columns.some((column) => column.name === 'environment_revision')) {
    db.exec('ALTER TABLE sessions ADD COLUMN environment_revision TEXT');
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
  // 项目级 worktree 配置（docs/design/worktree.md §3）：JSON；NULL = 没配，按 shared 处理。
  if (!projectColumns.some((column) => column.name === 'worktree_config')) {
    db.exec('ALTER TABLE projects ADD COLUMN worktree_config TEXT');
  }
  if (!projectColumns.some((column) => column.name === 'preview_port')) {
    db.exec('ALTER TABLE projects ADD COLUMN preview_port INTEGER');
  }
  // 项目仓库清单（docs/design/multi-repo.md §11.2）：JSON 数组；NULL = 老数据，读时从 repo_url 单仓库回填。
  if (!projectColumns.some((column) => column.name === 'repos')) {
    db.exec('ALTER TABLE projects ADD COLUMN repos TEXT');
  }
  if (!columns.some((column) => column.name === 'workspace_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN workspace_id TEXT');
  }
  // ADR 0017：会话创建者（说话 / 中断只给他）。老会话从审计里的 session.start / session.fork 回填。
  const addedCreatedBy = !columns.some((column) => column.name === 'created_by');
  if (addedCreatedBy) db.exec('ALTER TABLE sessions ADD COLUMN created_by TEXT');
  // 会话名（用户可改）。NULL = 没起名。
  if (!columns.some((column) => column.name === 'title')) db.exec('ALTER TABLE sessions ADD COLUMN title TEXT');
  // 收起时间（I1）：只表示移出活跃列表，不影响状态与进程。NULL = 仍在活跃列表里。
  if (!columns.some((column) => column.name === 'settled_at')) db.exec('ALTER TABLE sessions ADD COLUMN settled_at INTEGER');
  if (!columns.some((column) => column.name === 'group_id')) db.exec('ALTER TABLE sessions ADD COLUMN group_id TEXT');
  // 会话类型（I4 侧聊）：老库补列；NULL = 老会话，读回时按缺省（chat）处理。
  if (!columns.some((column) => column.name === 'kind')) db.exec('ALTER TABLE sessions ADD COLUMN kind TEXT');
  if (!columns.some((column) => column.name === 'parent_session_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN parent_session_id TEXT');
  }
  upgradeWorkspaceTable(db);
  db.exec(WORKSPACE_SCHEMA);
  // 准备命令状态（docs/design/worktree.md §4）：老库补列；v2 表也要补（upgradeWorkspaceTable 不会再加列）。
  const workspaceColumns = db.prepare('PRAGMA table_info(workspaces)').all() as { name: string }[];
  if (!workspaceColumns.some((column) => column.name === 'setup')) {
    db.exec('ALTER TABLE workspaces ADD COLUMN setup TEXT');
  }
  // 组合工作空间归属（docs/design/multi-repo.md §11.2）：老库补列。
  if (!workspaceColumns.some((column) => column.name === 'group_id')) {
    db.exec('ALTER TABLE workspaces ADD COLUMN group_id TEXT');
  }
  migrateTasksV2(db);
  migrateWorkspaces(db);
  cleanLegacyLogText(db);
  const layoutColumns = db.prepare('PRAGMA table_info(layout)').all() as { name: string }[];
  if (!layoutColumns.some((column) => column.name === 'sizes')) {
    db.exec("ALTER TABLE layout ADD COLUMN sizes TEXT NOT NULL DEFAULT '{}'");
  }

  const insertProject = db.prepare(
    'INSERT INTO projects(id, name, root_path, worker_id, directories, repo_url, repo_default_branch, repos, description, worktree_config, preview_port, created_at, team_id, created_by, members, deleted_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
      // root_path / worker_id / directories 是 W1 之前的旧列：只留给迁移读，不再写
      'ON CONFLICT(id) DO UPDATE SET name = excluded.name, repo_url = excluded.repo_url, repo_default_branch = excluded.repo_default_branch, repos = excluded.repos, description = excluded.description, ' +
      'worktree_config = excluded.worktree_config, preview_port = excluded.preview_port, ' +
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

  const updateSessionTitle = db.prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?');
  const updateSessionEnvironment = db.prepare(
    'UPDATE sessions SET environment_revision = ?, updated_at = ? WHERE id = ?'
  );
  const upsertSession = db.prepare(
    'INSERT INTO sessions(id, task_id, agent_id, model, origin_kind, origin_session, origin_seq, ' +
      'status, last_seq, agent_session, options, option_spec, worker_id, workspace_id, environment_revision, created_by, title, settled_at, group_id, kind, parent_session_id, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET model = excluded.model, status = excluded.status, ' +
      'last_seq = excluded.last_seq, agent_session = excluded.agent_session, ' +
      'options = excluded.options, option_spec = excluded.option_spec, worker_id = excluded.worker_id, workspace_id = excluded.workspace_id, ' +
      'environment_revision = excluded.environment_revision, settled_at = excluded.settled_at, group_id = excluded.group_id, ' +
      'kind = excluded.kind, parent_session_id = excluded.parent_session_id, ' +
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
  const selectSessionsByWorkspace = db.prepare('SELECT * FROM sessions WHERE workspace_id = ? ORDER BY created_at ASC');
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
  const selectFirstPrompt = db.prepare(
    "SELECT seq, payload, at FROM journal WHERE session_id = ? AND type = 'prompt' ORDER BY seq ASC LIMIT 1"
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
    'DELETE FROM session_links WHERE project_id = ?',
    'DELETE FROM sessions WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)',
    'DELETE FROM task_log_entries WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)',
    'DELETE FROM tasks WHERE project_id = ?',
    'DELETE FROM layout WHERE project_id = ?',
    // ADR 0026：长期工作空间属于团队——还关联着别的项目的留下（只去掉「最早为谁建」），其余连登记一起删
    'DELETE FROM project_workspaces WHERE project_id = ?',
    "UPDATE workspaces SET project_id = NULL WHERE project_id = ? AND kind = 'long_lived' AND id IN (SELECT workspace_id FROM project_workspaces)",
    'DELETE FROM project_workspaces WHERE workspace_id IN (SELECT id FROM workspaces WHERE project_id = ?)',
    'DELETE FROM workspaces WHERE project_id = ?',
    'DELETE FROM projects WHERE id = ?'
  ].map((sql) => db.prepare(sql));

  // 彻底删除单条会话：所有按 session_id 关联的行一起清掉（外键开着，子表先删）。
  // 可空的历史引用（工作日志、派发、连接器、PR 回链）置 NULL，保留记录本身。
  // 这些模块的表由组合根单独建（在 openSqliteStore 之后），worker / 单测里可能没有，
  // 所以每张表执行前探测，不能在建库时把语句一次性准备好。
  const removeSessionStatements: ReadonlyArray<{ readonly sql: string; readonly bindings: 1 | 2 }> = [
    { sql: 'DELETE FROM entry_map WHERE session_id = ?', bindings: 1 },
    { sql: 'DELETE FROM session_text WHERE session_id = ?', bindings: 1 },
    { sql: 'DELETE FROM journal WHERE session_id = ?', bindings: 1 },
    { sql: 'DELETE FROM artifacts WHERE session_id = ?', bindings: 1 },
    { sql: 'DELETE FROM session_links WHERE a_session_id = ? OR b_session_id = ?', bindings: 2 },
    { sql: 'DELETE FROM preview_links WHERE session_id = ?', bindings: 1 },
    { sql: 'DELETE FROM session_git_bases WHERE session_id = ?', bindings: 1 },
    { sql: 'DELETE FROM session_assets WHERE session_id = ?', bindings: 1 },
    { sql: 'DELETE FROM turn_refs WHERE session_id = ?', bindings: 1 },
    { sql: 'DELETE FROM turn_checkpoints WHERE session_id = ?', bindings: 1 },
    { sql: 'DELETE FROM tool_calls WHERE session_id = ?', bindings: 1 },
    { sql: 'DELETE FROM tool_grants WHERE session_id = ?', bindings: 1 },
    { sql: 'DELETE FROM message_delivery WHERE session_id = ?', bindings: 1 },
    { sql: 'DELETE FROM attention_ack WHERE session_id = ?', bindings: 1 },
    { sql: 'DELETE FROM agent_group_deliveries WHERE session_id = ?', bindings: 1 },
    { sql: 'DELETE FROM agent_group_sessions WHERE session_id = ?', bindings: 1 },
    { sql: 'DELETE FROM agent_messages WHERE from_session_id = ? OR target_session_id = ?', bindings: 2 },
    { sql: 'DELETE FROM agent_spawns WHERE session_id = ? OR spawner_session_id = ?', bindings: 2 },
    { sql: 'DELETE FROM agent_task_request WHERE session_id = ?', bindings: 1 },
    { sql: 'DELETE FROM session_provenance WHERE session_id = ?', bindings: 1 },
    // 显式授权按资源键关联（审核人共用这张表），也要跟着会话清掉
    { sql: "DELETE FROM access_grants WHERE resource_type = 'session' AND resource_id = ?", bindings: 1 },
    { sql: 'UPDATE task_log_entries SET session_id = NULL WHERE session_id = ?', bindings: 1 },
    { sql: 'UPDATE task_dispatch SET session_id = NULL WHERE session_id = ?', bindings: 1 },
    { sql: 'UPDATE task_dispatch SET notify_session_id = NULL WHERE notify_session_id = ?', bindings: 1 },
    { sql: 'UPDATE connector_binding SET main_session_id = NULL WHERE main_session_id = ?', bindings: 1 },
    { sql: 'UPDATE trigger_run SET session_id = NULL WHERE session_id = ?', bindings: 1 },
    { sql: 'DELETE FROM sessions WHERE id = ?', bindings: 1 }
  ];
  const hasTable = (table: string): boolean =>
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
  const runSessionCascade = (id: string): void => {
    for (const { sql, bindings } of removeSessionStatements) {
      const table = /(?:FROM|UPDATE) (\w+)/.exec(sql)?.[1];
      if (table === undefined || !hasTable(table)) continue;
      const params = bindings === 2 ? [id, id] : [id];
      db.prepare(sql).run(...params);
    }
    if (hasTable('task_pull_requests')) db.prepare('DELETE FROM task_pull_requests WHERE session_id = ?').run(id);
  };

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
      const primary = project.repos[0] ?? null;
      insertProject.run(
        project.id,
        project.name,
        '',
        null,
        '{}',
        // 双写：老列只留给还没看 repos 的读路径（worker / 前端过渡期），新列是权威。
        primary?.url ?? null,
        primary?.defaultBranch ?? null,
        JSON.stringify(project.repos),
        project.description,
        project.worktree ? JSON.stringify(project.worktree) : null,
        project.previewPort ?? null,
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
        session.environmentRevision ?? null,
        session.createdBy ?? null,
        session.title ?? null,
        session.settledAt ?? null,
        session.groupId ?? null,
        session.kind ?? null,
        session.parentSessionId ?? null,
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
    async listByWorkspace(workspaceId: string): Promise<Session[]> {
      return selectSessionsByWorkspace.all(workspaceId).map((row) => toSession(row));
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
    async firstPrompt(sessionId: Parameters<typeof asSessionId>[0]): Promise<JournalEntry | null> {
      const row = selectFirstPrompt.get(sessionId);
      return row ? toJournalEntry(row) : null;
    },
    async linkEntry(sessionId: Parameters<typeof asSessionId>[0], seq: Seq, entryId: string): Promise<void> {
      insertEntryMap.run(sessionId, seq, entryId);
    },
    async entryIdAt(sessionId: Parameters<typeof asSessionId>[0], seq: Seq): Promise<string | null> {
      const row = selectEntryId.get(sessionId, seq) as { entry_id?: string } | undefined;
      return row?.entry_id ?? null;
    },
    async setTitle(sessionId: Parameters<typeof asSessionId>[0], title: string | null, at: number): Promise<void> {
      updateSessionTitle.run(title, at, sessionId);
    },
    async setEnvironmentRevision(
      sessionId: Parameters<typeof asSessionId>[0],
      revision: string | null,
      at: number
    ): Promise<void> {
      updateSessionEnvironment.run(revision, at, sessionId);
    },
    /** 彻底删除：子表先删，同一事务；工作空间目录和 Task 不动。 */
    async remove(id: Parameters<typeof asSessionId>[0]): Promise<void> {
      transaction(() => runSessionCascade(id));
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
  const shared = migrateSharedWorkspaces(db);
  if (shared.linked + shared.teamed + shared.merged > 0) {
    console.log(`[storage] 共享工作空间迁移（ADR 0026）：新增关联 ${shared.linked}，补团队 ${shared.teamed}，合并重复登记 ${shared.merged}`);
  }
  return {
    projects,
    tasks,
    workLog: createWorkLogRepository(db),
    toolGrants: createToolGrantRepository(db),
    messages: createSqliteMessageStore(db),
    groups: createSqliteGroupStore(db),
    contextSettings: createSqliteContextSettings(db),
    sessionBases: createSqliteSessionBases(db),
    checkpoints: createSqliteCheckpoints(db),
    turnRefs: createSqliteTurnRefs(db),
    deliveries: createSqliteDeliveries(db),
    provenance: createSqliteProvenance(db),
    ...createSqliteConnectors(db),
    dispatches: createSqliteTaskDispatch(db),
    attention: createSqliteAttention(db),
    memory: { store: createSqliteMemoryStore(db), index: createSqliteMemoryIndex(db), settings: createSqliteMemorySettings(db) },
    workspaces: createWorkspaceRepository(db),
    workspaceGroups: createSqliteWorkspaceGroups(db),
    enrollment: createEnrollmentRepository(db),
    assets: createAssetRepository(db),
    assetSync: createAssetSyncBoard(db),
    assetReview: createAssetReviewRepository(db),
    notifications: createNotificationRepository(db),
    sessions,
    artifacts,
    layout,
    links: createSqliteSessionLinks(db),
    previewLinks: createSqlitePreviewLinks(db),
    agentProfiles: createSqliteAgentProfiles(db),
    bots: createSqliteBotRepository(db),
    workerAgents: createSqliteWorkerAgents(db),
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
