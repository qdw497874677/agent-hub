import type { Subject } from '../access.ts';
import type { DomainError } from '../errors.ts';
import { invalid, notFound } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import type { Deps } from './deps.ts';
import { authorizeSession, projectOfRef } from './authorization.ts';
import { locationOf } from './workspaces.ts';

/**
 * 交互式终端开在哪（docs/design/terminal.md §6）。
 * 只做两件事：会话的 session.read 授权 + 它实际干活的工作空间。
 */
export interface TerminalTarget {
  readonly workerId: string | null;
  readonly root: string;
}

export type TerminalTargetDeps = Pick<Deps, 'projects' | 'tasks' | 'sessions' | 'workspaces' | 'access'>;

/**
 * 终端的目标机器与目录。
 * 没工作空间时 root 是空串——调用方必须拒绝，不能把它当成 `/`。
 */
export async function terminalTarget(
  deps: TerminalTargetDeps,
  subject: Subject | null,
  sessionId: string
): Promise<Result<TerminalTarget, DomainError>> {
  const { project, session } = await projectOfRef(deps, { kind: 'session', id: sessionId });
  const allowed = await authorizeSession(deps.access, subject, project, session, 'session.read');
  if (!allowed.ok) return allowed;
  // authorizeSession 通过时 project 必然存在（project 为空会先回 notFound）；这里只收窄类型。
  if (!project) return err(notFound('项目不存在'));
  const location = await locationOf(deps, project, allowed.value);
  if (location.root === '') return err(invalid('这条会话还没有工作空间'));
  return ok({ workerId: location.workerId, root: location.root });
}
