import { homedir } from 'node:os';
import {
  asTaskId,
  defaultWorkspaceFor,
  ok,
  prepareTemporaryWorkspaceUseCase,
  type Deps,
  type DomainError,
  type Result,
  type Subject
} from '@agent-hub/domain';

/**
 * 开放 API / MCP 开会话时替调用方找个工作目录（issue：MCP 建会话报「没有工作空间」）。
 *
 * 界面里这件事是派生对话框做的（选已有工作空间，或勾一个临时），但开放 API 的调用方
 * 只给 taskId：项目没绑长期工作目录时，deriveSessionUseCase 只能回 409。这里对齐界面的默认：
 * 项目在这台机器上有可用的长期工作空间就让它走默认，否则按项目档位现建一个临时工作空间。
 *
 * 返回 null = 不用改（已指定 workspaceId/组合，或容器会话），调用方照原样传给 derive。
 */
export async function workspaceForApiStart(
  deps: Pick<Deps, 'projects' | 'tasks' | 'workspaces' | 'fs' | 'git' | 'gateway' | 'now' | 'access'>,
  input: {
    readonly taskId?: string | null;
    readonly workspaceId?: string | null;
    readonly groupId?: string | null;
    readonly workerId?: string | null;
    /** 显式档位：界面「新建临时空间」传 isolated；不传按项目配置。 */
    readonly mode?: 'shared' | 'isolated';
  },
  actor: Subject | null
): Promise<Result<string | null, DomainError>> {
  if (input.groupId || input.workspaceId || !input.taskId) return ok(null);
  const task = await deps.tasks.byId(asTaskId(input.taskId));
  if (!task) return ok(null); // 让 derive 自己回「任务不存在」，不在这一层抢错误文案
  const project = await deps.projects.byId(task.projectId);
  if (!project) return ok(null);
  // 有长期工作空间时 derive 的 defaultWorkspaceFor 会选中它：不替调用方建新的，避免每个任务多一个目录。
  const longLived = await defaultWorkspaceFor(deps, project.id, input.workerId ?? undefined);
  if (longLived) return ok(null);
  const prepared = await prepareTemporaryWorkspaceUseCase(deps, {
    projectId: project.id,
    taskId: task.id,
    workerId: input.workerId ?? null,
    home: homedir(),
    ...(input.mode ? { mode: input.mode } : {}),
    actor
  });
  if (!prepared.ok) return prepared;
  return ok(prepared.value.id);
}
