import { afterFailure, type Delivery } from '../delivery.ts';
import { notFound, type DomainError } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import type { SessionId } from '../ids.ts';
import type { PromptPart } from '../attachment.ts';
import type { Deps } from './deps.ts';
import type { DeliveryQueue } from '../ports/delivery-queue.ts';
import { ensureHosted } from './hosting.ts';
import { recordEvent } from './sessions.ts';

/**
 * 送达（ADR 0031 D2）。只有「依赖不在线」（unavailable）才重试：
 * 别的错误（权限、参数）重试也没用，照旧当场收尾。
 */
export type DeliveryDeps = Pick<
  Deps,
  'agents' | 'artifacts' | 'fs' | 'gateway' | 'hosting' | 'now' | 'projects' | 'queue' | 'sessions' | 'stream' | 'tasks' | 'workspaces'
> & { readonly deliveries: DeliveryQueue; readonly random?: () => number };

export interface PromptPayload {
  readonly text: string;
  readonly parts: readonly PromptPart[];
}

/** 送一次。成功记 delivered；可重试的失败排下一次；用尽或不可重试就收掉这一轮。 */
export async function attemptDelivery(deps: DeliveryDeps, delivery: Delivery): Promise<Result<void, DomainError>> {
  const sessionId = delivery.sessionId as SessionId;
  await deps.deliveries.save({ ...delivery, state: 'sending', updatedAt: deps.now() });
  const session = await deps.sessions.byId(sessionId);
  let failure: DomainError | null = null;
  if (!session) failure = notFound('会话不存在');
  else {
    const hosted = await ensureHosted(deps, session);
    if (!hosted.ok) failure = hosted.error;
    else {
      const payload = delivery.payload as PromptPayload;
      const sent = await deps.gateway.dispatch({ kind: 'prompt', sessionId, text: payload.text, parts: payload.parts, deliveryId: delivery.id });
      if (!sent.ok) failure = sent.error;
    }
  }
  const now = deps.now();
  if (!failure) {
    await deps.deliveries.save({ ...delivery, state: 'delivered', attempt: delivery.attempt + 1, nextAt: null, lastError: null, updatedAt: now });
    return ok(undefined);
  }
  const next = failure.code === 'unavailable'
    ? afterFailure(delivery, failure.message, now, deps.random)
    : { ...delivery, attempt: delivery.attempt + 1, state: 'undelivered' as const, nextAt: null, lastError: failure.message, updatedAt: now };
  await deps.deliveries.save(next);
  if (next.state === 'undelivered') {
    await endTurnFailed(deps, sessionId, failure);
    return err(failure);
  }
  return ok(undefined);
}

async function endTurnFailed(deps: DeliveryDeps, sessionId: SessionId, error: DomainError): Promise<void> {
  if (!(await deps.sessions.byId(sessionId))) return;
  await deps.queue.run(sessionId, () =>
    recordEvent(deps, { sessionId, event: { kind: 'ended', outcome: 'failed', reason: `未送达：${error.message}` } })
  );
}

/** 定时泵：每个会话只送最靠前那条到期的，严格按序。 */
export async function pumpDeliveries(deps: DeliveryDeps): Promise<number> {
  const due = await deps.deliveries.due(deps.now());
  for (const d of due) await attemptDelivery(deps, d).catch(() => undefined);
  return due.length;
}

/** 人点「立即重试」：只对未送达、或排队中的会话队首有效；重新给满 10 次。 */
export async function retryDeliveryNow(deps: DeliveryDeps, id: string): Promise<Result<void, DomainError>> {
  const d = await deps.deliveries.byId(id);
  if (!d || (d.state !== 'undelivered' && d.state !== 'queued')) return err(notFound('没有这条待送达的消息'));
  const head = (await deps.deliveries.pendingFor(d.sessionId))[0];
  if (head?.id !== d.id) return err({ code: 'conflict', message: '前面还有消息没送达，先处理前面的' });
  return attemptDelivery(deps, { ...d, attempt: 0 });
}

/** 人点「撤回」：不再送；journal 里那句话保留，另记一条说明。 */
export async function cancelDelivery(deps: DeliveryDeps, id: string): Promise<Result<void, DomainError>> {
  const d = await deps.deliveries.byId(id);
  if (!d || (d.state !== 'undelivered' && d.state !== 'queued')) return err(notFound('没有这条待送达的消息'));
  await deps.deliveries.save({ ...d, state: 'cancelled', nextAt: null, updatedAt: deps.now() });
  const sessionId = d.sessionId as SessionId;
  await deps.queue.run(sessionId, () =>
    recordEvent(deps, { sessionId, event: { kind: 'diagnostic', level: 'info', text: `已撤回第 ${d.seq} 步那条未送达的消息` } })
  );
  return ok(undefined);
}
