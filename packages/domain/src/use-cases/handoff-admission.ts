import { conflict, unavailable, type DomainError } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import type { AgentHandoffRecord } from '../ports/agent-handoff-store.ts';
import type { DeliveryQueue } from '../ports/delivery-queue.ts';
import type { Deps } from './deps.ts';
import { asSessionId, type Seq } from '../ids.ts';
import { isUnknownOutcomeEnded } from '../attention.ts';

export async function handoffRecord(deps: Pick<Deps, 'agentHandoffs'>, sessionId: string): Promise<Result<AgentHandoffRecord | null, DomainError>> {
  try {
    return ok(await deps.agentHandoffs?.byTarget(sessionId) ?? null);
  } catch {
    return err(unavailable('无法确认交接状态，暂时不能继续'));
  }
}

/** Ordinary sources may enqueue only after the dedicated atomic first admission. */
export async function admitHandoffIngress(deps: Pick<Deps, 'agentHandoffs'>, sessionId: string, clientMessageId?: string): Promise<Result<void, DomainError>> {
  const record = await handoffRecord(deps, sessionId);
  if (!record.ok) return record;
  if (record.value && !record.value.first) return err(conflict('交接首条消息尚未确认'));
  if (clientMessageId !== undefined && record.value?.first?.requestKey === clientMessageId) {
    return err(conflict('请通过交接首条消息入口核对原回执'));
  }
  return ok(undefined);
}

/** End evidence is keyed to the exact first delivery, never inferred from status or timeout. */
export async function handoffFirstEnded(deps: Pick<Deps, 'sessions' | 'agentHandoffs'> & { readonly deliveries?: DeliveryQueue }, record: AgentHandoffRecord): Promise<boolean> {
  const first = record.first?.delivery;
  if (!first || !deps.deliveries) return false;
  try {
    if (deps.agentHandoffs?.firstEnded) return await deps.agentHandoffs.firstEnded(record.reservation.target.id, first.id, first.seq);
    const delivery = await deps.deliveries.byId(first.id);
    if (!delivery || delivery.sessionId !== record.reservation.target.id || delivery.seq !== first.seq || delivery.state !== 'delivered') return false;
    const events = await deps.sessions.eventsAfter(asSessionId(delivery.sessionId), delivery.seq as Seq);
    const ends = events.filter(({ event }) => event.kind === 'ended' && event.deliveryId === delivery.id);
    const event = ends[0]?.event;
    return ends.length === 1 && event?.kind === 'ended' && ['done', 'failed', 'interrupted', 'stopped'].includes(event.outcome) && !isUnknownOutcomeEnded(event);
  } catch {
    return false;
  }
}

/** Before dispatch, even ordinary Worker frames cannot claim the first turn. */
export async function handoffWorkerEventsAllowed(deps: Pick<Deps, 'agentHandoffs' | 'deliveries'>, sessionId: string): Promise<boolean> {
  const record = await handoffRecord(deps, sessionId);
  if (!record.ok) return false;
  if (!record.value) return true;
  const first = record.value.first?.delivery;
  if (!first || !deps.deliveries) return false;
  const delivery = await deps.deliveries.byId(first.id).catch(() => null);
  return !!delivery && delivery.sessionId === sessionId && delivery.seq === first.seq && (delivery.state === 'sending' || delivery.state === 'delivered');
}
