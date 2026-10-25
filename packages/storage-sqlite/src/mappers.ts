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
  TaskRepository
} from '@agent-hub/domain';
import { asProjectId, asSessionId, asTaskId, asArtifactId, asAgentId } from '@agent-hub/domain';

/**
 * 行映射层。`as` 在这里是本职：数据库只给 `string | number | null`，
 * 把它收窄成品牌类型正是适配器存在的理由，不是内核漏出去的 `as`。
 */
type Row = Record<string, unknown>;

const str = (row: Row, key: string): string => row[key] as string;
const num = (row: Row, key: string): number => row[key] as number;
const nullableStr = (row: Row, key: string): string | null => (row[key] as string | null) ?? null;
const nullableNum = (row: Row, key: string): number | null => (row[key] as number | null) ?? null;

export function toProject(row: Row): Project {
  return {
    id: asProjectId(str(row, 'id')),
    name: str(row, 'name'),
    rootPath: str(row, 'root_path'),
    workerId: nullableStr(row, 'worker_id'),
    directories: parseDirectories(row['directories']),
    createdAt: num(row, 'created_at')
  };
}

function parseDirectories(raw: unknown): Record<string, string> {
  try {
    const value = JSON.parse(typeof raw === 'string' ? raw : '{}') as unknown;
    if (!value || typeof value !== 'object') return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    return {};
  }
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
}

export type { ArtifactId, ProjectId, Seq, SessionId, TaskId, CanvasLayout };
