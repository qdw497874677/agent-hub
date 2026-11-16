import type {
  WorkLogRepository,
  Artifact,
  ArtifactRepository,
  CanvasLayout,
  JournalEntry,
  LayoutStore,
  Project,
  ProjectRepo,
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
import { asProjectId, asSessionId, asTaskId, asArtifactId, asAgentId, CHECK_COMMANDS_MAX, normalizeRepos, normalizeWorktree, primaryRepo } from '@agent-hub/domain';

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
 * 仓库清单（JSON）。解析不了 / 不合规 → 记一条日志、当作没有（回落到老的 repo_url 单仓库），
 * 手改过的行不该让整个项目读不出来。
 */
function parseRepos(raw: string | null): ProjectRepo[] | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) throw new Error('not an array');
    const normalized = normalizeRepos(value as Partial<ProjectRepo>[]);
    if (!normalized.ok) throw new Error(normalized.error.message);
    return [...normalized.value];
  } catch (error) {
    console.warn(`[storage] 项目仓库清单不合规，按没有处理：${error instanceof Error ? error.message : String(error)}`);
    return null;
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

/**
 * 项目的检查命令（JSON 字符串数组，issue #216 P1）。读取尽量宽容：解析失败 / 不是数组 → 空；
 * 非字符串元素和 trim 后为空的丢弃；最多 `CHECK_COMMANDS_MAX` 条。手改过的库不该让项目读不出来。
 */
function parseChecks(raw: string | null): readonly string[] {
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const checks: string[] = [];
    for (const entry of value) {
      if (typeof entry !== 'string') continue;
      const command = entry.trim();
      if (command === '') continue;
      checks.push(command);
      if (checks.length === CHECK_COMMANDS_MAX) break;
    }
    return checks;
  } catch {
    return [];
  }
}

export function toProject(row: Row): Project {
  const link =
    nullableStr(row, 'repo_url') === null
      ? null
      : { url: str(row, 'repo_url'), defaultBranch: nullableStr(row, 'repo_default_branch') };
  // 新列优先；老库（没有 / 坏了）回落到单仓库列，id / name 确定性派生。
  const repos = parseRepos(nullableStr(row, 'repos')) ?? (link === null ? [] : [primaryRepo({ repo: link, repos: [] })!]);
  const primary = repos[0] ?? null;
  return {
    id: asProjectId(str(row, 'id')),
    name: str(row, 'name'),
    repo: primary === null ? null : { url: primary.url, defaultBranch: primary.defaultBranch },
    repos,
    description: nullableStr(row, 'description'),
    worktree: parseWorktree(nullableStr(row, 'worktree_config')),
    ...(row['preview_port'] == null ? {} : { previewPort: Number(row['preview_port']) }),
    checks: parseChecks(nullableStr(row, 'checks')),
    assetSetIds: parseAssetSetIds(nullableStr(row, 'asset_set_ids')).assetSetIds ?? [],
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
    baseBranch: nullableStr(row, 'base_branch'),
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

function parseAssetIds(raw: string | null): { assetIds?: readonly string[] } {
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) return {};
    return { assetIds: parsed };
  } catch {
    return {};
  }
}

function parseAssetSetIds(raw: string | null): { assetSetIds?: readonly string[] } {
  if (raw === null || raw === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) return {};
    return { assetSetIds: parsed };
  } catch {
    return {};
  }
}

export function toSession(row: Row): Session {
  const originSession = nullableStr(row, 'origin_session');
  // #221 步骤 7：容器会话没有任务。空串是当年某些写入路径的哨兵，一起读成 null。
  const rawTaskId = nullableStr(row, 'task_id');
  const originSeq = nullableNum(row, 'origin_seq');
  return {
    id: asSessionId(str(row, 'id')),
    taskId: rawTaskId === null || rawTaskId === '' ? null : asTaskId(rawTaskId),
    agentId: asAgentId(str(row, 'agent_id')),
    model: str(row, 'model'),
    origin:
      originSession === null || originSeq === null
        ? { kind: 'derive' }
        : { kind: 'fork', fromSessionId: asSessionId(originSession), atSeq: originSeq },
    status: str(row, 'status') as Session['status'],
    lastSeq: num(row, 'last_seq'),
    // 老库补列前读到的可能是 undefined：按 0 处理，和刚建出来的会话一致。
    turn: row['turn'] === undefined || row['turn'] === null ? 0 : num(row, 'turn'),
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
    // 没收起 / 恢复后库里是 NULL：不带这个字段，和刚派生出来的领域对象一模一样（往返测试的护栏）
    ...(row['settled_at'] !== null && row['settled_at'] !== undefined ? { settledAt: num(row, 'settled_at') } : {}),
    ...(row['pinned'] === 1 ? { pinned: true } : {}),
    ...(row['group_id'] === undefined ? {} : { groupId: nullableStr(row, 'group_id') as Session['groupId'] }),
    // 老库补列后是 NULL：kind 没有 null 语义，缺省即 chat，所以读回 undefined。
    ...(nullableStr(row, 'kind') !== null ? { kind: nullableStr(row, 'kind') as Session['kind'] } : {}),
    ...(row['parent_session_id'] === undefined
      ? {}
      : { parentSessionId: nullableStr(row, 'parent_session_id') as Session['parentSessionId'] }),
    // #221 步骤 4：老库补列后是 NULL；派生对象里 botId 缺省也是 null，往返一致。
    ...(row['bot_id'] === undefined ? {} : { botId: nullableStr(row, 'bot_id') }),
    // 会话级资产清单：NULL = 没选（按项目生效集）；坏 JSON 当没选，不让一条脏数据打挂会话页。
    ...parseAssetIds(nullableStr(row, 'asset_ids')),
    // 会话显式选的组合：NULL = 用项目默认；有值才输出，和派生对象往返一致。
    ...parseAssetSetIds(nullableStr(row, 'asset_set_ids')),
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
    at: num(row, 'at'),
    ...(row['turn'] === undefined || row['turn'] === null ? {} : { turn: num(row, 'turn') })
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
