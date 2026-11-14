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
 *
 * 终端还要额外过 `terminalAccess`（session.prompt）：能往 PTY 里打字等于能以
 * 会话身份执行命令，viewer 只有 session.read，不该有（issue #213）。
 * 预览链接等只读用途只走这里，权限不变。
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

/**
 * 交互式终端额外要求的授权：`session.prompt`。
 *
 * 单独立一个函数而不是改 `terminalTarget`，是因为预览链接（`use-cases/previews.ts`
 * 与 `preview-share.ts`）复用了 `terminalTarget`，它们要的是 `session.read`；
 * 而 member 的 `session.prompt` 范围是 `own`，塞进共享函数会让同团队 member
 * 连别人会话的预览都打不开。
 */
export async function terminalAccess(
  deps: TerminalTargetDeps,
  subject: Subject | null,
  sessionId: string
): Promise<Result<void, DomainError>> {
  const { project, session } = await projectOfRef(deps, { kind: 'session', id: sessionId });
  const allowed = await authorizeSession(deps.access, subject, project, session, 'session.prompt');
  if (!allowed.ok) return allowed;
  return ok(undefined);
}
