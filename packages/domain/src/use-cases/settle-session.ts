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
import { projectOfSession } from './workspaces.ts';
import { releaseSessionWorktrees, restoreSessionWorktrees, type SessionWorktreeDeps, type WorktreeCleanupItem } from './session-worktrees.ts';

export interface SettleSessionDeps extends Pick<Deps, 'sessions' | 'tasks' | 'projects' | 'access'>,
  // 容器会话没有任务：按组合工作空间 / bot 找回项目（#221 步骤 7）。
  Pick<Deps, 'workspaceGroups' | 'bots' | 'workspaces'>,
  Partial<Pick<SessionWorktreeDeps, 'gateway' | 'git' | 'now'>> {
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

export interface SessionCleanupReport {
  readonly items: readonly WorktreeCleanupItem[];
}

/** 收起 / 恢复的结果：会话字段原样保留，另带每个 worktree 的清理明细。 */
export type SettleSessionResult = Session & { readonly cleanup: SessionCleanupReport };

const signedIn = (actor: Principal | null): Result<Principal, DomainError> =>
  !actor || actor.user.disabledAt !== null || actor.user.deletedAt !== null ? err(forbidden('需要登录')) : ok(actor);

/**
 * 收起 / 恢复会话：改 `settledAt`，并在收起时拆掉独占的临时 worktree（有未提交改动则留下）。
 * 还在跑的会话不允许收起（先停，不做隐式停止）；恢复时尽量按原分支加回 worktree。
 * 权限与打断同一档（session.settle）：会话创建者、团队 owner / admin 或被授权的人。
 */
export async function settleSessionUseCase(
  deps: SettleSessionDeps,
  command: SettleSessionCommand
): Promise<Result<SettleSessionResult, DomainError>> {
  const who = signedIn(command.actor);
  if (!who.ok) return who;
  const session = await deps.sessions.byId(command.sessionId);
  if (!session) return err(notFound('会话不存在'));
  const project = await projectOfSession(deps, session);
  const allowed = await authorizeSession(deps.access, who.value, project, session, 'session.settle');
  if (!allowed.ok) return allowed;
  const current = allowed.value;
  if (command.settled && current.status === 'running') return err(conflict('会话还在跑，先停止再收起'));
  const next: Session = { ...current, settledAt: command.settled ? command.now : null };
  let items: WorktreeCleanupItem[] = [];
  if (command.settled) {
    if (deps.gateway || deps.git) {
      items = [...(await releaseSessionWorktrees(deps as SessionWorktreeDeps, current, { force: false }))];
    } else if (current.workspaceId) {
      items = [{ workspaceId: current.workspaceId, action: 'deferred', reason: '本机未接 Git，留给 workspace_sweep' }];
    } else if (current.groupId) {
      items = [{ workspaceId: current.groupId, action: 'deferred', reason: '本机未接 Git，留给 workspace_sweep' }];
    }
  } else if (deps.gateway || deps.git) {
    await restoreSessionWorktrees(deps as SessionWorktreeDeps, next);
  }
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
  return ok({ ...next, cleanup: { items } });
}
