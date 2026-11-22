import type { AgentRef } from './agent-ref.ts';
import type { ProjectId, TaskId } from './ids.ts';
import { newTaskId } from './ids.ts';
import { conflict, invalid, type DomainError } from './errors.ts';
import { err, ok, type Result } from './result.ts';

/**
 * 任务状态机（tasks-and-capabilities.md §2.1）。`abandoned` 是死路记录，**不隐藏也不删除**（S4.2）。
 * 老库的 `open` 在读出时映射：有过会话 → in_progress，否则 → todo（见 storage 迁移）。
 */
export type TaskStatus = 'todo' | 'in_progress' | 'blocked' | 'in_review' | 'done' | 'abandoned';

export const TASK_STATUSES: readonly TaskStatus[] = ['todo', 'in_progress', 'blocked', 'in_review', 'done', 'abandoned'];

export interface Task {
  readonly id: TaskId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly goal: string | null;
  readonly status: TaskStatus;
  /** 负责人（人）。agent 不当 owner，它是会话。 */
  readonly ownerId: string | null;
  /** git 项目的任务分支（workspaces.md）；首次运行时定下。 */
  readonly branch: string | null;
  /** 任务从哪个远端分支开工（agent-git-tools.md §5）；隔离 worktree 的起点，null = 按项目默认分支。 */
  readonly baseBranch: string | null;
  /** 「当前进展」一句话：最近一条人或 agent 写的日志自动刷新，也可手改。 */
  readonly summary: string | null;
  /**
   * 归档时间；null / 缺省 = 未归档（老数据也读作 null）。
   * 只经 `TaskRepository.setArchived` 的比较并设置写：整行 save 在更新时不碰这个字段，
   * 否则归档 / 恢复后迟到的旧快照会把状态盖回去。
   */
  readonly archivedAt?: number | null;
  /** 任务默认 Agent：覆盖项目默认；会话里显式选的仍然优先。null = 没配。 */
  readonly defaultAgent?: AgentRef | null;
  /**
   * 显式父任务（项目内的子任务，docs/design/project-session-mcp.md）。关系只在创建时写，
   * 首版不开放换父级。旧任务没有这个字段，读作 null；子任务本身不会因为父任务状态而联动。
   */
  readonly parentTaskId?: TaskId | null;
  /** 工作日志当前最大序号；追加日志时 +1。 */
  readonly logSeq: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CreateTaskInput {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly goal?: string;
  readonly ownerId?: string | null;
  /** 远端分支名（不含 `origin/` 也接受，worktree 起点由 use case 规范化）。 */
  readonly baseBranch?: string | null;
  /**
   * 父任务的当前快照。给 `parentTaskId` 时必须一起给：领域层据此核对「父任务存在且同项目」，
   * 不把跨项目父子关系写进库。只用于校验，不会修改父任务。
   */
  readonly parent?: Task | null;
  readonly parentTaskId?: TaskId | null;
  readonly now: number;
  readonly id?: TaskId;
}

const BASE_BRANCH_MAX = 200;

/** 分支名的基本合法性：1–200 字符，不含空白 / `..` / `~` / 首尾 `/`。 */
function parseBaseBranch(raw: string | null | undefined): Result<string | null, DomainError> {
  if (raw === null || raw === undefined) return ok(null);
  const value = raw.trim();
  if (value.length === 0 || value.length > BASE_BRANCH_MAX) return err(invalid('base_branch 不合法'));
  if (/\s/.test(value) || value.includes('..') || value.includes('~')) return err(invalid('base_branch 不合法'));
  if (value.startsWith('/') || value.endsWith('/')) return err(invalid('base_branch 不合法'));
  return ok(value);
}

export function createTask(input: CreateTaskInput): Result<Task, DomainError> {
  const title = input.title.trim();
  if (!title) return err(invalid('任务标题不能为空'));
  const baseBranch = parseBaseBranch(input.baseBranch);
  if (!baseBranch.ok) return baseBranch;
  const parentTaskId = input.parentTaskId ?? null;
  if (parentTaskId !== null) {
    // 没有父任务快照就没法核对项目：拒绝，而不是默认放行。
    if (!input.parent) return err(invalid('父任务不存在'));
    if (input.parent.id !== parentTaskId) return err(invalid('父任务与 parentTaskId 不一致'));
    if (input.parent.projectId !== input.projectId) return err(invalid('父任务必须与子任务同项目'));
  }
  return ok({
    id: input.id ?? newTaskId(),
    projectId: input.projectId,
    title,
    goal: input.goal?.trim() || null,
    status: 'todo',
    ownerId: input.ownerId ?? null,
    branch: null,
    baseBranch: baseBranch.value,
    parentTaskId,
    summary: null,
    archivedAt: null,
    defaultAgent: null,
    logSeq: 0,
    createdAt: input.now,
    updatedAt: input.now
  });
}

const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  todo: ['in_progress', 'done', 'abandoned'],
  in_progress: ['blocked', 'in_review', 'done', 'abandoned', 'todo'],
  blocked: ['in_progress', 'abandoned'],
  in_review: ['in_progress', 'done', 'abandoned'],
  done: ['in_progress'],
  abandoned: ['todo']
};

/** agent（经能力层）只能走的迁移：最多到 in_review，done/abandoned 只有人能设（§7 决定 3）。 */
const AGENT_TARGETS: readonly TaskStatus[] = ['in_progress', 'blocked', 'in_review'];

export type StatusActor = 'user' | 'agent' | 'system';

export function setTaskStatus(
  task: Task,
  status: TaskStatus,
  now: number,
  actor: StatusActor = 'user'
): Result<Task, DomainError> {
  if (task.status === status) return ok(task);
  if (actor === 'agent' && !AGENT_TARGETS.includes(status)) {
    return err(conflict(`agent 不能把任务设为 ${status}，只能是 ${AGENT_TARGETS.join(' / ')}`));
  }
  if (!TRANSITIONS[task.status].includes(status)) {
    return err(conflict(`任务不能从 ${task.status} 变为 ${status}`));
  }
  return ok({ ...task, status, updatedAt: now });
}

/** 会话开跑时把 todo 推到 in_progress；其它状态不动。 */
export function markStarted(task: Task, now: number): Task {
  return task.status === 'todo' ? { ...task, status: 'in_progress', updatedAt: now } : task;
}

export function isAbandoned(task: Task): boolean {
  return task.status === 'abandoned';
}

/** 给人看的状态名：日志正文里写中文，不写枚举值。 */
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  todo: '待开始', in_progress: '进行中', blocked: '受阻', in_review: '待验收', done: '已收尾', abandoned: '已放弃'
};
