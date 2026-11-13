import type {
  WorkLogRepository,
  Artifact,
  ArtifactRepository,
  CanvasLayout,
  JournalEntry,
  LayoutStore,
  Project,
  ProjectRepository,
  Seq,
  Session,
  SessionEvent,
  SessionRepository,
  Task,
  ArtifactId,
  ProjectId,
  SessionId,
  TaskId,
  TaskRepository,
  WorkspaceRepository
} from '@agent-hub/domain';
import { asProjectId, asSessionId, asTaskId, asArtifactId, asAgentId, normalizeWorktree } from '@agent-hub/domain';

/**
 * 行映射层。`as` 在这里是本职：数据库只给 `string | number | null`，
 * 把它收窄成品牌类型正是适配器存在的理由，不是内核漏出去的 `as`。
 */
type Row = Record<string, unknown>;

const str = (row: Row, key: string): string => row[key] as string;
const num = (row: Row, key: string): number => row[key] as number;
const nullableStr = (row: Row, key: string): string | null => (row[key] as string | null) ?? null;
const nullableNum = (row: Row, key: string): number | null => (row[key] as number | null) ?? null;

function parseMembers(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * 项目级 worktree 配置（JSON）。解析不了 / 不合规 → 记一条日志、按「没配过」处理：
 * 老库、手改过的行不该让整个项目读不出来。
 */
function parseWorktree(raw: string | null): Project['worktree'] {
  if (raw === null) return null;
  try {
    const normalized = normalizeWorktree(JSON.parse(raw) as unknown);
    if (normalized.ok) return normalized.value;
    console.warn(`[storage] 项目 worktree 配置不合规，按「没配过」处理：${normalized.error.message}`);
    return null;
  } catch {
    console.warn('[storage] 项目 worktree 配置不是合法 JSON，按「没配过」处理');
    return null;
  }
}

export function toProject(row: Row): Project {
  return {
    id: asProjectId(str(row, 'id')),
    name: str(row, 'name'),
    repo: nullableStr(row, 'repo_url') === null ? null : { url: str(row, 'repo_url'), defaultBranch: nullableStr(row, 'repo_default_branch') },
    description: nullableStr(row, 'description'),
    worktree: parseWorktree(nullableStr(row, 'worktree_config')),
    teamId: nullableStr(row, 'team_id'),
    createdBy: nullableStr(row, 'created_by'),
    members: parseMembers(nullableStr(row, 'members')),
    deletedAt: nullableNum(row, 'deleted_at'),
    createdAt: num(row, 'created_at')
  };
}


export function toTask(row: Row): Task {
  return {
    id: asTaskId(str(row, 'id')),
    projectId: asProjectId(str(row, 'project_id')),
    title: str(row, 'title'),
    goal: nullableStr(row, 'goal'),
    status: str(row, 'status') as Task['status'],
    ownerId: nullableStr(row, 'owner_id'),
    branch: nullableStr(row, 'branch'),
    summary: nullableStr(row, 'summary'),
    logSeq: nullableNum(row, 'log_seq') ?? 0,
    createdAt: num(row, 'created_at'),
    updatedAt: num(row, 'updated_at')
  };
}

/** 坏 JSON 不该让整个画布打不开：读不出来就当「还不知道」。 */
function parseOptions(raw: string | null): Readonly<Record<string, string | boolean>> {
  if (raw === null || raw === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, string | boolean>)
      : {};
  } catch {
    return {};
  }
}

/** 可调项清单同样是 agent 报的 JSON；读不出来就当还没人报过。 */
function parseOptionSpec(raw: string | null): Session['optionSpec'] {
  if (raw === null || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Session['optionSpec']) : [];
  } catch {
    return [];
  }
}

export function toSession(row: Row): Session {
  const originSession = nullableStr(row, 'origin_session');
  const originSeq = nullableNum(row, 'origin_seq');
  return {
    id: asSessionId(str(row, 'id')),
    taskId: asTaskId(str(row, 'task_id')),
    agentId: asAgentId(str(row, 'agent_id')),
    model: str(row, 'model'),
    origin:
      originSession === null || originSeq === null
        ? { kind: 'derive' }
        : { kind: 'fork', fromSessionId: asSessionId(originSession), atSeq: originSeq },
    status: str(row, 'status') as Session['status'],
    lastSeq: num(row, 'last_seq'),
    agentSessionRef: nullableStr(row, 'agent_session'),
    options: parseOptions(nullableStr(row, 'options')),
    optionSpec: parseOptionSpec(nullableStr(row, 'option_spec')),
    workerId: nullableStr(row, 'worker_id'),
    workspaceId: nullableStr(row, 'workspace_id') as Session['workspaceId'],
    ...(nullableStr(row, 'environment_revision') !== null
      ? { environmentRevision: nullableStr(row, 'environment_revision') }
      : {}),
    createdBy: nullableStr(row, 'created_by'),
    // 没起名时不带这个字段，和刚派生出来的领域对象一模一样（往返测试的护栏）
    ...(typeof row['title'] === 'string' ? { title: row['title'] } : {}),
    createdAt: num(row, 'created_at'),
    updatedAt: num(row, 'updated_at')
  };
}

export function toArtifact(row: Row): Artifact {
  return {
    id: asArtifactId(str(row, 'id')),
    sessionId: asSessionId(str(row, 'session_id')),
    taskId: asTaskId(str(row, 'task_id')),
    path: str(row, 'path'),
    bytes: num(row, 'bytes'),
    label: str(row, 'label'),
    createdAt: num(row, 'created_at')
  };
}

export function toJournalEntry(row: Row): JournalEntry {
  return {
    seq: num(row, 'seq'),
    event: JSON.parse(str(row, 'payload')) as SessionEvent,
    at: num(row, 'at')
  };
}

export interface RepositorySet {
  projects: ProjectRepository;
  tasks: TaskRepository;
  workLog: WorkLogRepository;
  sessions: SessionRepository;
  artifacts: ArtifactRepository;
  layout: LayoutStore;
  workspaces: WorkspaceRepository;
}

export type { ArtifactId, ProjectId, Seq, SessionId, TaskId, CanvasLayout };
