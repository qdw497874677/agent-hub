import type { AuditLog } from '../ports/audit-log.ts';
import type { Principal } from '../account.ts';
import type { DomainError } from '../errors.ts';
import { forbidden, notFound } from '../errors.ts';
import type { SessionId } from '../ids.ts';
import { newId } from '../ids.ts';
import type { Result } from '../result.ts';
import { err, ok } from '../result.ts';
import type { Session } from '../session.ts';
import type { Deps } from './deps.ts';
import { authorizeSession } from './authorization.ts';
import { projectOfSession } from './workspaces.ts';

export interface PinSessionDeps extends Pick<Deps, 'sessions' | 'tasks' | 'projects' | 'access'>,
  Pick<Deps, 'workspaceGroups' | 'bots' | 'workspaces'> {
  /** 没登录态（或测试里没接审计）就不记。 */
  readonly audit?: AuditLog;
}

export interface PinSessionCommand {
  readonly sessionId: SessionId;
  /** true = 常驻（Worker 不按空闲回收）；false = 恢复普通会话。 */
  readonly pinned: boolean;
  readonly actor: Principal | null;
  readonly now: number;
}

const signedIn = (actor: Principal | null): Result<Principal, DomainError> =>
  !actor || actor.user.disabledAt !== null || actor.user.deletedAt !== null ? err(forbidden('需要登录')) : ok(actor);

/**
 * 常驻 / 取消常驻（一个任务下留一条长期用的会话）。
 *
 * 只改 `pinned`：不影响会话状态、不动 journal、不重启进程。真正生效在 Worker：
 * 下一条 `start_session` 带上 `pinned`，Worker 不按 `HUB_SESSION_IDLE_MS` 回收它，
 * 也不拿它去凑 `HUB_KEEPALIVE_MAX`。已经在跑的会话要等下次重新托管才吃到这个标记。
 *
 * 权限与说话同一档（session.prompt）：会话创建者、团队 owner / admin 或被授权的人。
 */
export async function pinSessionUseCase(
  deps: PinSessionDeps,
  command: PinSessionCommand
): Promise<Result<Session, DomainError>> {
  const who = signedIn(command.actor);
  if (!who.ok) return who;
  const session = await deps.sessions.byId(command.sessionId);
  if (!session) return err(notFound('会话不存在'));
  const project = await projectOfSession(deps, session);
  const allowed = await authorizeSession(deps.access, who.value, project, session, 'session.prompt');
  if (!allowed.ok) return allowed;
  await deps.sessions.setPinned(command.sessionId, command.pinned, command.now);
  const next = await deps.sessions.byId(command.sessionId);
  if (!next) return err(notFound('会话不存在'));
  if (deps.audit) {
    await deps.audit.append({
      id: newId(),
      actorId: who.value.user.id,
      actorEmail: who.value.user.email,
      action: 'session.pin',
      target: next.id,
      detail: command.pinned ? '设为常驻' : '取消常驻',
      at: command.now
    });
  }
  return ok(next);
}
