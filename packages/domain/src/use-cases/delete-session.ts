import type { Principal } from '../account.ts';
import type { DomainError } from '../errors.ts';
import { conflict, forbidden, notFound } from '../errors.ts';
import type { SessionId } from '../ids.ts';
import type { Result } from '../result.ts';
import { err, ok } from '../result.ts';
import { isBusy } from '../session.ts';
import type { Session } from '../session.ts';
import type { Deps } from './deps.ts';
import { authorizeSession, projectOfSessionOrigin } from './authorization.ts';
import { releaseSessionWorktrees, type SessionWorktreeDeps } from './session-worktrees.ts';
import { cleanupPolicyFor } from './workspace-cleanup.ts';

export interface DeleteSessionDeps extends Pick<Deps, 'sessions' | 'tasks' | 'projects' | 'access'>,
  // 容器会话没有任务：按组合工作空间 / bot 找回项目（#221 步骤 7）。
  Pick<Deps, 'workspaceGroups' | 'bots' | 'workspaces'>,
  Partial<Pick<SessionWorktreeDeps, 'gateway' | 'git' | 'now' | 'workdirSafety'>>,
  Partial<Pick<Deps, 'cleanup'>> {}

export interface DeleteSessionOptions {
  /** 同时拆独占的临时 worktree。不传则按项目规则 deleteWorktreeOnSessionDelete（默认关）。 */
  readonly removeWorktree?: boolean;
}
const signedIn = (actor: Principal | null): Result<Principal, DomainError> =>
  !actor || actor.user.disabledAt !== null || actor.user.deletedAt !== null ? err(forbidden('需要登录')) : ok(actor);

/**
 * 彻底删除一条会话：会话行、journal、搜索投影、artifacts、连线等所有按 session_id 关联的数据一起清掉，不可恢复。
 *
 * 是否同时拆独占的临时 worktree 由 options.removeWorktree 或项目清理规则决定（默认不拆，要人确认）。
 * 长期工作空间和别人还在用的目录不动。也不动 Task。从不自动删会话。
 * 会话还在跑就拒绝（先停，不做隐式停止）。
 * 只有会话创建者、团队 owner / admin 或被授权的人能删（session.delete）。
 * 审计与操作记录由 HTTP 层写（需要 IP 和 actor 上下文），所以这里只返回被删的会话。
 */
export async function deleteSessionUseCase(
  deps: DeleteSessionDeps,
  actor: Principal | null,
  sessionId: SessionId,
  options: DeleteSessionOptions = {}
): Promise<Result<Session, DomainError>> {
  const who = signedIn(actor);
  if (!who.ok) return who;
  const session = await deps.sessions.byId(sessionId);
  if (!session) return err(notFound('会话不存在'));
  const project = await projectOfSessionOrigin(deps, session);
  const allowed = await authorizeSession(deps.access, who.value, project, session, 'session.delete');
  if (!allowed.ok) return allowed;
  if (isBusy(allowed.value)) return err(conflict('会话还在跑，先停止再删除'));
  let removeWorktree = options.removeWorktree;
  if (removeWorktree === undefined && project) {
    const policy = await cleanupPolicyFor(deps, project.id);
    removeWorktree = policy.deleteWorktreeOnSessionDelete;
  }
  if (removeWorktree === true && (deps.gateway || deps.git)) {
    await releaseSessionWorktrees(deps as SessionWorktreeDeps, allowed.value, { force: true });
  }
  await deps.sessions.remove(allowed.value.id);
  return ok(allowed.value);
}
