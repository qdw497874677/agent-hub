/**
 * 等某条会话的下一次可调项回报（用户改完模型/档位的那一次）。
 *
 * agent 不回就等 `timeoutMs`：宁可让界面显示「没变」，也不要挂住一个请求。
 */
import { randomUUID } from 'node:crypto';
import { recordSessionOptions } from '@agent-hub/domain';
import type { Deps, RuntimeOption, SessionId } from '@agent-hub/domain';

/** Persist gateway-fenced non-model observations; model receipts require a live exact waiter. */
export async function ingestOptionReceipt(
  deps: Pick<Deps, 'queue' | 'sessions' | 'now'>,
  waiters: Pick<ReturnType<typeof createOptionWaiters>, 'receipt' | 'target' | 'expectedModel'>,
  sessionId: SessionId,
  requestId: string,
  optionId: string,
  outcome: 'applied' | 'rejected' | 'unknown',
  options: readonly RuntimeOption[] | undefined,
  isCurrent: () => boolean
): Promise<void> {
  if (!isCurrent()) return;
  const target = waiters.target(sessionId, requestId, optionId);
  // A model receipt is authoritative only for a still-live exact request and its
  // exact value. Late, unrelated and ambiguous snapshots cannot pin a model.
  const models = options?.filter((option) => option.id === 'model');
  if (optionId === 'model' && (target === undefined || outcome !== 'applied' || typeof target !== 'string' || models?.length !== 1 || models[0]?.current !== target)) {
    waiters.receipt(sessionId, requestId, optionId, outcome, options);
    return;
  }
  if (outcome === 'applied' && options) {
    const persisted = await deps.queue.run(sessionId, async () => {
      if (!isCurrent()) return false;
      let saved = false;
      const sessions = {
        ...deps.sessions,
        async save(session: Parameters<typeof deps.sessions.save>[0], intent?: Parameters<typeof deps.sessions.save>[1]): Promise<void> {
          if (!isCurrent() || (optionId === 'model' && waiters.target(sessionId, requestId, optionId) !== target)) return;
          await deps.sessions.save(session, intent);
          saved = true;
        }
      };
      if (optionId === 'model' && waiters.target(sessionId, requestId, optionId) !== target) return false;
      const expectedModel = waiters.expectedModel(sessionId, requestId, optionId);
      if (optionId === 'model' && expectedModel !== undefined && (await deps.sessions.byId(sessionId))?.model !== expectedModel) return false;
      if (!isCurrent() || (optionId === 'model' && waiters.target(sessionId, requestId, optionId) !== target)) return false;
      const result = await recordSessionOptions({ ...deps, sessions }, { sessionId, options, ...(optionId === 'model' && typeof target === 'string' ? { confirmedModel: target } : {}) });
      return saved && result.ok && result.value.optionSpec === options && isCurrent();
    });
    if (!persisted) return;
  }
  if (isCurrent()) waiters.receipt(sessionId, requestId, optionId, outcome, options);
}

export function createOptionWaiters(timeoutMs = 8000) {
  const waiters = new Map<string, () => void>();
  const exact = new Map<string, { sessionId: string; optionId: string; value: string | boolean; expectedModel?: string; finish: (state: 'confirmed' | 'rejected' | 'unconfirmed') => void }>();
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
    register(sessionId: string, optionId: string, value: string | boolean, expectedModel?: string) {
      const requestId = randomUUID();
      let finish!: (state: 'confirmed' | 'rejected' | 'unconfirmed') => void;
      const result = new Promise<'confirmed' | 'rejected' | 'unconfirmed'>((resolve) => {
        const timer = setTimeout(() => finish('unconfirmed'), timeoutMs);
        finish = (state) => { if (!exact.delete(requestId)) return; clearTimeout(timer); resolve(state); };
      });
      exact.set(requestId, { sessionId, optionId, value, ...(expectedModel === undefined ? {} : { expectedModel }), finish });
      return { requestId, result, cancel: () => finish('unconfirmed') };
    },
    receipt(sessionId: string, requestId: string, optionId: string, outcome: 'applied' | 'rejected' | 'unknown', options?: readonly RuntimeOption[]): void {
      const pending = exact.get(requestId);
      if (!pending || pending.sessionId !== sessionId || pending.optionId !== optionId) return;
      const matches = options?.filter((option) => option.id === optionId);
      pending.finish(outcome === 'rejected' ? 'rejected' : outcome === 'applied' && matches?.length === 1 && matches[0]?.current === pending.value ? 'confirmed' : 'unconfirmed');
    },
    has(sessionId: string, requestId: string, optionId: string): boolean {
      const pending = exact.get(requestId);
      return !!pending && pending.sessionId === sessionId && pending.optionId === optionId;
    },
    target(sessionId: string, requestId: string, optionId: string): string | boolean | undefined {
      const pending = exact.get(requestId);
      return pending?.sessionId === sessionId && pending.optionId === optionId ? pending.value : undefined;
    },
    expectedModel(sessionId: string, requestId: string, optionId: string): string | undefined {
      const pending = exact.get(requestId);
      return pending?.sessionId === sessionId && pending.optionId === optionId ? pending.expectedModel : undefined;
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
