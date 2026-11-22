import { asProjectId, asSessionId, asTaskId } from '../ids.ts';
import type { TaskId } from '../ids.ts';
import { conflict, invalid, notFound, type DomainError } from '../errors.ts';
import { requestFingerprint, requestReplayKey } from '../request-replay.ts';
import { err, ok, type Result } from '../result.ts';
import { createTask, type Task } from '../task.ts';
import type { ProjectRepository } from '../ports/project-repository.ts';
import type { TaskRepository } from '../ports/task-repository.ts';
import type { TaskCreationStore } from '../ports/task-creation-store.ts';
import type { TaskGate } from '../ports/task-gate.ts';
import { withActiveTask } from './task-admission.ts';

/** 请求回执里的操作名：换操作不共用请求键。 */
export const TASK_CREATE_OPERATION = 'task.create';
/** 指纹格式版本：以后改规范化规则时换版本，老键不会被误判成同参。 */
const TASK_CREATE_FINGERPRINT_VERSION = 'task.create.v1';

export interface CreateTaskWithReplayCommand {
  /** 发起人（账号 id）。同时写进审计回执，但不作为授权依据。 */
  readonly actorId: string;
  /** 来源会话；不同源会话不共用请求键。 */
  readonly sourceSessionId: string;
  readonly projectId: string;
  /** 调用方的幂等键（MCP clientRequestId 之类）。 */
  readonly requestKey: string;
  readonly title: string;
  readonly goal?: string;
  readonly ownerId?: string | null;
  readonly baseBranch?: string | null;
  /** 可选父任务；必须与本次任务同项目。 */
  readonly parentTaskId?: string | null;
}

export interface TaskCreationDeps {
  readonly projects: ProjectRepository;
  readonly tasks: TaskRepository;
  readonly taskCreations: TaskCreationStore;
  readonly now: () => number;
  /** 有直接父任务时共享持有父任务；归档中的父任务不能再长出子任务。 */
  readonly taskGate?: TaskGate;
}

/**
 * 在会话里创建任务（可直接由项目 MCP 写工具调用）。
 *
 * - 只创建任务：不建会话、不派工、不改父任务状态（创建与派工是两次独立写入）。
 * - 父任务关系只在创建时写死：父任务必须存在且同项目；旧任务没有父级。
 * - 同键同参返回第一次创建的任务；同键异参返回 conflict；不同源会话互不占键。
 */
export async function createTaskWithReplayUseCase(
  deps: TaskCreationDeps,
  command: CreateTaskWithReplayCommand
): Promise<Result<Task, DomainError>> {
  const actorId = command.actorId.trim();
  const sourceSessionId = command.sourceSessionId.trim();
  const requestKey = command.requestKey.trim();
  if (!actorId) return err(invalid('缺少调用人'));
  // 没有来源会话就不算「会话内写工具」：交回普通创建入口，不生成跨会话共享的键。
  if (!sourceSessionId) return err(invalid('缺少来源会话'));
  if (!requestKey || requestKey.length > 200) return err(invalid('请求键不合法'));

  const project = await deps.projects.byId(asProjectId(command.projectId));
  if (!project) return err(notFound('项目不存在'));

  let parent: Task | null = null;
  let parentTaskId: TaskId | null = null;
  const rawParent = command.parentTaskId?.trim();
  if (rawParent) {
    parent = await deps.tasks.byId(asTaskId(rawParent));
    if (!parent) return err(notFound('父任务不存在'));
    // 领域层还会复核一次；这里提前给出更明确的错误，避免无谓地生成回执。
    if (parent.projectId !== project.id) return err(invalid('父任务必须与子任务同项目'));
    parentTaskId = parent.id;
  }

  // 只共享直接父任务：兄弟 / 其它父级的任务创建互不影响；没有父任务时不占用任何准入。
  return withActiveTask(deps, parentTaskId, async () => {
    const created = createTask({
      projectId: project.id,
      title: command.title,
      goal: command.goal,
      ownerId: command.ownerId ?? null,
      baseBranch: command.baseBranch ?? null,
      parentTaskId,
      parent,
      now: deps.now()
    });
    if (!created.ok) return created;
    const task = created.value;

    const key = requestReplayKey(
      {
        actorId,
        sourceSessionId: asSessionId(sourceSessionId),
        projectId: project.id,
        operation: TASK_CREATE_OPERATION
      },
      requestKey
    );
    // 规范化后的输入才进指纹：标题首尾空白、goal 空串等差异不算「新参数」。
    const fingerprint = requestFingerprint([
      TASK_CREATE_FINGERPRINT_VERSION,
      task.title,
      task.goal,
      task.ownerId,
      task.baseBranch,
      task.parentTaskId ?? null
    ]);

    const outcome = await deps.taskCreations.createWithReplay({
      key,
      fingerprint,
      actorId,
      sourceSessionId: asSessionId(sourceSessionId),
      projectId: project.id,
      operation: TASK_CREATE_OPERATION,
      task
    });
    if (outcome.status === 'conflict') return err(conflict('同一请求键对应不同参数'));
    return ok(outcome.task);
  });
}
