import type { Workspace } from '../workspace.ts';
import type { Deps } from './deps.ts';
import { newId } from '../ids.ts';
import { conflict, type DomainError } from '../errors.ts';
import { err, type Result } from '../result.ts';

export const workdirTarget = (workspace: Workspace) => ({ workspaceId: workspace.id, workerId: workspace.workerId, cwd: workspace.path });

/** Acquire a durable fence only after re-reading the exact target inside the lease. */
export async function fenceWorkspace(deps: Pick<Deps, 'workspaces' | 'workdirSafety'>, workspace: Workspace, validate?: (current: Workspace) => Promise<boolean>): Promise<string | null> {
  const safety = deps.workdirSafety;
  if (!safety) return null;
  return safety.runExclusive(async () => {
    const current = await deps.workspaces.byId(workspace.id);
    if (!current || current.state !== workspace.state || current.path !== workspace.path || current.workerId !== workspace.workerId || current.projectId !== workspace.projectId) throw new Error('workdir changed');
    if (validate && !(await validate(current))) throw new Error('workdir ownership changed');
    return safety.beginRemoval(workdirTarget(current));
  });
}

export async function finishFence(deps: Pick<Deps, 'workdirSafety'>, fence: string | null): Promise<void> {
  if (fence && deps.workdirSafety) await deps.workdirSafety.runExclusive(() => deps.workdirSafety!.finishRemoval(fence));
}

/** Only an explicit transport/adapter proof means a failed RPC can no longer mutate the directory. */
export async function finishSettledFailure(deps: Pick<Deps, 'workdirSafety'>, fence: string | null, error: DomainError): Promise<void> {
  if (error.operationSettled === true) await finishFence(deps, fence);
}

/** Fence operations whose Worker-side rollback may recursively remove a destination. */
export async function withRollbackFence<T>(
  deps: Partial<Pick<Deps, 'workdirSafety'>>,
  target: { workerId: string | null; cwd: string },
  operation: () => Promise<Result<T, DomainError>>
): Promise<Result<T, DomainError>> {
  let fence: string | null = null;
  if (deps.workdirSafety) {
    try {
      fence = await deps.workdirSafety.runExclusive(() => deps.workdirSafety!.beginRemoval({ ...target, workspaceId: `rollback:${newId()}` }));
    } catch {
      return err(conflict('Hub 上有终端或待确认的目录删除，暂不能执行此操作'));
    }
  }
  const result = await operation();
  // A gateway-marked application reply proves Worker rollback completed;
  // transport failures, thrown calls and unmarked errors stay fenced.
  if (result.ok || ('operationSettled' in result.error && result.error.operationSettled === true)) await finishFence(deps, fence);
  return result;
}

export function withOptionalRollbackFence<T>(deps: Partial<Pick<Deps, 'workdirSafety'>>, enabled: boolean, target: { workerId: string | null; cwd: string }, operation: () => Promise<Result<T, DomainError>>): Promise<Result<T, DomainError>> {
  return enabled ? withRollbackFence(deps, target, operation) : operation();
}
