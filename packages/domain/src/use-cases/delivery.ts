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

/** 上一轮还在跑时，排队的消息隔多久再看一眼（回合结束时也会被立刻叫醒）。 */
export const TURN_WAIT_MS = 5_000;
/** 上一轮多久没动静就不再算「在跑」。 */
export const TURN_STALE_MS = 30 * 60_000;

/**
 * 会话里是不是还有一轮没结束：从 journal 末尾往回看，跳过还没送出去的（排队中 / 未送达 / 撤回的）prompt，
 * 先碰到 ended 就是空闲，先碰到已送出的 prompt 就是那一轮还在跑（定时触发、派来的消息、人上一句都算）。
 * 这时把消息直接交给 agent，运行时会以「Agent is already processing」拒掉。
 */
export async function turnInProgress(deps: Pick<Deps, 'sessions' | 'now'> & { readonly deliveries?: DeliveryQueue }, sessionId: SessionId): Promise<boolean> {
  const recent = deps.deliveries ? await deps.deliveries.recent(sessionId, 200) : [];
  const unsent = new Set(recent.filter((d) => d.state !== 'delivered' && d.state !== 'sending').map((d) => d.seq));
  const tail = (await deps.sessions.tail(sessionId, 2_000)).filter((e) => !(e.event.kind === 'prompt' && unsent.has(e.seq)));
  // 兜底：最后一次动静已经过去 30 分钟（进程没了、漏了 ended），不再挡着后面的消息
  const last = tail[tail.length - 1];
  if (!last || deps.now() - last.at > TURN_STALE_MS) return false;
  for (let i = tail.length - 1; i >= 0; i--) {
    const e = tail[i]!;
    if (e.event.kind === 'ended') return false;
    if (e.event.kind === 'prompt') return true;
  }
  return false;
}

/**
 * 送一次。上一轮还没结束就原样排着（不算失败、不扣次数），等回合结束再送；
 * 成功记 delivered；可重试的失败排下一次；用尽或不可重试就收掉这一轮。
 */
export async function attemptDelivery(deps: DeliveryDeps, delivery: Delivery): Promise<Result<void, DomainError>> {
  const sessionId = delivery.sessionId as SessionId;
  if (delivery.kind === 'prompt' && (await turnInProgress(deps, sessionId))) {
    const now = deps.now();
    await deps.deliveries.save({ ...delivery, state: 'queued', nextAt: now + TURN_WAIT_MS, lastError: null, updatedAt: now });
    return ok(undefined);
  }
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

/** 回合结束：这个会话排在队首、等上一轮的那条马上送（不等下一次泵）。 */
export async function releaseAfterTurn(deps: DeliveryDeps, sessionId: string): Promise<boolean> {
  const head = (await deps.deliveries.pendingFor(sessionId))[0];
  if (!head || head.state !== 'queued') return false;
  await attemptDelivery(deps, head);
  return true;
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
