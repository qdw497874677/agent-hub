import type { Principal } from '../account.ts';
import type { DomainError } from '../errors.ts';
import { conflict, forbidden, notFound } from '../errors.ts';
import type { SessionId } from '../ids.ts';
import type { Result } from '../result.ts';
import { err, ok } from '../result.ts';
import { isBusy } from '../session.ts';
import type { Session } from '../session.ts';
import type { Deps } from './deps.ts';
import { authorizeSession } from './authorization.ts';

export interface DeleteSessionDeps extends Pick<Deps, 'sessions' | 'tasks' | 'projects' | 'access'> {}

const signedIn = (actor: Principal | null): Result<Principal, DomainError> =>
  !actor || actor.user.disabledAt !== null || actor.user.deletedAt !== null ? err(forbidden('需要登录')) : ok(actor);

/**
 * 彻底删除一条会话：会话行、journal、搜索投影、artifacts、连线等所有按 session_id 关联的数据一起清掉，不可恢复。
 *
 * 不删磁盘工作空间目录，也不动 Task。会话还在跑就拒绝（先停，不做隐式停止）。
 * 只有会话创建者、团队 owner / admin 或被授权的人能删（session.delete）。
 * 审计与操作记录由 HTTP 层写（需要 IP 和 actor 上下文），所以这里只返回被删的会话。
 */
export async function deleteSessionUseCase(
  deps: DeleteSessionDeps,
  actor: Principal | null,
  sessionId: SessionId
): Promise<Result<Session, DomainError>> {
  const who = signedIn(actor);
  if (!who.ok) return who;
  const session = await deps.sessions.byId(sessionId);
  if (!session) return err(notFound('会话不存在'));
  const task = await deps.tasks.byId(session.taskId);
  const project = task ? await deps.projects.byId(task.projectId) : null;
  const allowed = await authorizeSession(deps.access, who.value, project, session, 'session.delete');
  if (!allowed.ok) return allowed;
  if (isBusy(allowed.value)) return err(conflict('会话还在跑，先停止再删除'));
  await deps.sessions.remove(allowed.value.id);
  return ok(allowed.value);
}
