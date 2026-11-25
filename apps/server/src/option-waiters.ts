/**
 * 等某条会话的下一次可调项回报（用户改完模型/档位的那一次）。
 *
 * agent 不回就等 `timeoutMs`：宁可让界面显示「没变」，也不要挂住一个请求。
 */
import { randomUUID } from 'node:crypto';
import { recordSessionOptions } from '@agent-hub/domain';
import type { Deps, RuntimeOption, SessionId } from '@agent-hub/domain';

/** Persist an exact, gateway-fenced receipt as an observation, even after its HTTP waiter expires. */
export async function ingestOptionReceipt(
  deps: Pick<Deps, 'queue' | 'sessions' | 'now'>,
  waiters: Pick<ReturnType<typeof createOptionWaiters>, 'receipt'>,
  sessionId: SessionId,
  requestId: string,
  optionId: string,
  outcome: 'applied' | 'rejected' | 'unknown',
  options: readonly RuntimeOption[] | undefined,
  isCurrent: () => boolean
): Promise<void> {
  if (!isCurrent()) return;
  if (outcome === 'applied' && options) {
    const persisted = await deps.queue.run(sessionId, async () => {
      if (!isCurrent()) return false;
      let saved = false;
      const sessions = {
        ...deps.sessions,
        async save(session: Parameters<typeof deps.sessions.save>[0]): Promise<void> {
          if (!isCurrent()) return;
          await deps.sessions.save(session);
          saved = true;
        }
      };
      const result = await recordSessionOptions({ ...deps, sessions }, { sessionId, options });
      return saved && result.ok && result.value.optionSpec === options && isCurrent();
    });
    if (!persisted) return;
  }
  if (isCurrent()) waiters.receipt(sessionId, requestId, optionId, outcome, options);
}

export function createOptionWaiters(timeoutMs = 8000) {
  const waiters = new Map<string, () => void>();
  const exact = new Map<string, { sessionId: string; optionId: string; value: string | boolean; finish: (state: 'confirmed' | 'rejected' | 'unconfirmed') => void }>();
  const tails = new Map<string, Promise<void>>();
  return {
    async serialize<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
      const previous = tails.get(sessionId) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => { release = resolve; });
      tails.set(sessionId, current);
      await previous;
      try { return await run(); } finally { release(); if (tails.get(sessionId) === current) tails.delete(sessionId); }
    },
    register(sessionId: string, optionId: string, value: string | boolean) {
      const requestId = randomUUID();
      let finish!: (state: 'confirmed' | 'rejected' | 'unconfirmed') => void;
      const result = new Promise<'confirmed' | 'rejected' | 'unconfirmed'>((resolve) => {
        const timer = setTimeout(() => finish('unconfirmed'), timeoutMs);
        finish = (state) => { if (!exact.delete(requestId)) return; clearTimeout(timer); resolve(state); };
      });
      exact.set(requestId, { sessionId, optionId, value, finish });
      return { requestId, result, cancel: () => finish('unconfirmed') };
    },
    receipt(sessionId: string, requestId: string, optionId: string, outcome: 'applied' | 'rejected' | 'unknown', options?: readonly RuntimeOption[]): void {
      const pending = exact.get(requestId);
      if (!pending || pending.sessionId !== sessionId || pending.optionId !== optionId) return;
      pending.finish(outcome === 'rejected' ? 'rejected' : outcome === 'applied' && options?.some((option) => option.id === optionId && option.current === pending.value) ? 'confirmed' : 'unconfirmed');
    },
    has(sessionId: string, requestId: string, optionId: string): boolean {
      const pending = exact.get(requestId);
      return !!pending && pending.sessionId === sessionId && pending.optionId === optionId;
    },
    wait(sessionId: string): Promise<void> {
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(sessionId);
          resolve();
        }, timeoutMs);
        waiters.set(sessionId, () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
    resolve(sessionId: string): void {
      waiters.get(sessionId)?.();
      waiters.delete(sessionId);
    }
  };
}
