import { conflict, unavailable, type DomainError } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import type { Deps } from './deps.ts';
import { asSessionId } from '../ids.ts';
import type { Session } from '../session.ts';

/** Only a durable, exact branch outcome can authorize use of the child session. */
export async function admitBranchSession(
  deps: Pick<Deps, 'branchAttempts' | 'sessions'>,
  sessionId: string
): Promise<Result<Session | null, DomainError>> {
  if (!deps.branchAttempts) return ok(null);
  try {
    const attempt = await deps.branchAttempts.bySession(sessionId);
    if (attempt?.state === 'pending') return err(conflict('会话分支结果尚未确认，暂时不能继续'));
    if (attempt?.state === 'both_failed') return err(conflict('会话分支启动失败，不能继续'));
    if (attempt) {
      const proof = attempt.settledAgentSessionRef;
      const session = await deps.sessions.byId(asSessionId(sessionId));
      if ((attempt.state !== 'native' && attempt.state !== 'plain') || attempt.sessionId !== sessionId || !session || session.workerId !== attempt.workerId ||
          typeof proof !== 'string' || !proof.trim() || proof.trim().toLowerCase() === 'pending' || new TextEncoder().encode(proof).length > 512 || session.agentSessionRef !== proof) {
        return err(unavailable('无法确认会话分支状态，暂时不能继续'));
      }
      return ok(session);
    }
    return ok(null);
  } catch {
    return err(unavailable('无法确认会话分支状态，暂时不能继续'));
  }
}
