import type { AuditLog } from '../ports/audit-log.ts';
import type { Principal } from '../account.ts';
import type { DomainError } from '../errors.ts';
import { conflict, forbidden, notFound } from '../errors.ts';
import type { SessionId } from '../ids.ts';
import { newId } from '../ids.ts';
import type { Result } from '../result.ts';
import { err, ok } from '../result.ts';
import type { Session } from '../session.ts';
import type { Deps } from './deps.ts';
import { authorizeSession } from './authorization.ts';

export interface SettleSessionDeps extends Pick<Deps, 'sessions' | 'tasks' | 'projects' | 'access'> {
  /** 没登录态（或测试里没接审计）就不记。 */
  readonly audit?: AuditLog;
}

export interface SettleSessionCommand {
  readonly sessionId: SessionId;
  /** true = 移出活跃列表；false = 恢复。 */
  readonly settled: boolean;
  readonly actor: Principal | null;
  readonly now: number;
}

const signedIn = (actor: Principal | null): Result<Principal, DomainError> =>
  !actor || actor.user.disabledAt !== null || actor.user.deletedAt !== null ? err(forbidden('需要登录')) : ok(actor);

/**
 * 收起 / 恢复会话：只改 `settledAt`，不改状态、不停进程、不动 journal。
 * 还在跑的会话不允许收起（先停，不做隐式停止）；恢复无条件允许。
 * 权限与打断同一档（session.settle）：会话创建者、团队 owner / admin 或被授权的人。
 */
export async function settleSessionUseCase(
  deps: SettleSessionDeps,
  command: SettleSessionCommand
): Promise<Result<Session, DomainError>> {
  const who = signedIn(command.actor);
  if (!who.ok) return who;
  const session = await deps.sessions.byId(command.sessionId);
  if (!session) return err(notFound('会话不存在'));
  const task = await deps.tasks.byId(session.taskId);
  const project = task ? await deps.projects.byId(task.projectId) : null;
  const allowed = await authorizeSession(deps.access, who.value, project, session, 'session.settle');
  if (!allowed.ok) return allowed;
  const current = allowed.value;
  if (command.settled && current.status === 'running') return err(conflict('会话还在跑，先停止再收起'));
  const next: Session = { ...current, settledAt: command.settled ? command.now : null };
  await deps.sessions.save(next);
  if (deps.audit) {
    await deps.audit.append({
      id: newId(),
      actorId: who.value.user.id,
      actorEmail: who.value.user.email,
      action: 'session.settle',
      target: next.id,
      detail: command.settled ? '收起' : '恢复',
      at: command.now,
      teamId: project?.teamId ?? null
    });
  }
  return ok(next);
}
