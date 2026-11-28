import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { deliveryApi, type DeliveryDto } from '../shell/api.ts';
import { deliveryNeedsAction, HELD_DELIVERY_STATES, queuedBehind, queuedDeliveryText, uncertainSending, type QueueReason } from './turn-hint.ts';

/**
 * 送达状态（ADR 0031 D2）：按 prompt 的 seq 查。送达了就什么都不显示（安静）。
 *
 * `quietSeq` 避免和对话末尾同一条进度重复；其他消息和要人动手的状态照旧显示。
 */
export const DeliveryContext = createContext<{
  sessionId: string;
  bySeq: ReadonlyMap<number, DeliveryDto>;
  quiet?: boolean;
  quietSeq?: number;
  withdrawQueued?: boolean;
  startupFailed?: boolean;
  queueReason?: QueueReason | undefined;
  uncertainDeliveryIds?: readonly string[];
} | null>(null);

/**
 * 送达状态按会话缓存。eventCount 只当「又有事件了」的提醒，不进 key：
 * 以前进 key 会让每个事件都多一份缓存，也会让别处 ['deliveries', sessionId] 的失效前缀对不上。
 */
export function useDeliveries(sessionId: string, eventCount: number) {
  const query = useQuery({
    queryKey: ['deliveries', sessionId],
    queryFn: () => deliveryApi.list(sessionId),
    retry: false,
    staleTime: 0,
    refetchInterval: (q) => ((q.state.data ?? []).some((d) => HELD_DELIVERY_STATES.has(d.state)) ? 2_000 : false)
  });
  const lastCount = useRef(eventCount);
  useEffect(() => {
    if (lastCount.current === eventCount) return;
    lastCount.current = eventCount;
    void query.refetch();
  }, [eventCount, query.refetch]);
  const bySeq = new Map<number, DeliveryDto>();
  for (const d of query.data ?? []) bySeq.set(d.seq, d);
  return bySeq;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function DeliveryNote({ seq }: { seq: number }) {
  const ctx = useContext(DeliveryContext);
  const d = ctx?.bySeq.get(seq);
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(d?.state === 'queued' && d.nextAt !== null);
  if (!ctx || !d || !HELD_DELIVERY_STATES.has(d.state)) {
    return d?.state === 'cancelled' ? <p className="text-meta text-tertiary" data-testid="delivery-note">已撤回 · 没有发给 agent</p> : null;
  }
  // 窄屏：纯等待的两种（投递在途、排队等前面那条）由 turn-hint 统一说，这里不重复。
  if ((ctx.quiet === true || ctx.quietSeq === seq) && (d.state === 'sending' || (d.state === 'queued' && !deliveryNeedsAction(d, ctx.bySeq.values(), ctx.withdrawQueued)))) {
    return null;
  }
  const act = (run: typeof deliveryApi.retry) => async () => {
    setBusy(true);
    setError(null);
    try {
      await run(ctx.sessionId, d.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      void client.invalidateQueries({ queryKey: ['deliveries', ctx.sessionId] });
      void client.invalidateQueries({ queryKey: ['session-startup', ctx.sessionId] });
    }
  };
  const retry = <button type="button" className="min-h-11 underline underline-offset-2 disabled:opacity-50 md:min-h-0" disabled={busy} onClick={act(deliveryApi.retry)}>立即重试</button>;
  const cancel = <button type="button" className="min-h-11 underline underline-offset-2 disabled:opacity-50 md:min-h-0" disabled={busy} onClick={act(deliveryApi.cancel)}>撤回</button>;
  const behind = queuedBehind(d, ctx.bySeq.values());
  const uncertain = ctx.uncertainDeliveryIds ?? [];
  const actions = (
    <>
      {' · '}
      {!behind ? <>{retry}{' · '}</> : null}
      {cancel}
    </>
  );
  let body;
  if (d.state === 'sending') body = <span className="text-tertiary">{uncertainSending(d, uncertain) ? '暂未确认这一轮的结果' : '发送中…'}</span>;
  else if (d.state === 'undelivered')
    body = <span className="text-rust" title={d.lastError ?? undefined}>未送达{d.lastError ? `：${d.lastError}` : ''}{actions}</span>;
  else if (d.attempt === 0) {
    const text = queuedDeliveryText(d.seq, ctx.bySeq.values(), uncertain, ctx.queueReason);
    body = <span className="text-tertiary">{text}{ctx.startupFailed && !behind ? <> · {retry}</> : null}{(!behind || ctx.withdrawQueued) ? <> · {cancel}</> : null}</span>;
  }
  else {
    const secs = Math.max(0, Math.ceil(((d.nextAt ?? now) - now) / 1000));
    body = <span className="text-rust" title={d.lastError ?? undefined}>未送达 · 第 {d.attempt + 1} 次重试 {secs} 秒后{actions}</span>;
  }
  return (
    <p className="max-w-[85%] text-right text-meta" data-testid="delivery-note" data-state={d.state}>
      {body}
      {error ? <span className="block text-rust">{error}</span> : null}
    </p>
  );
}
