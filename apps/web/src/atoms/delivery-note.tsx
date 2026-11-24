import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { deliveryApi, type DeliveryDto } from '../shell/api.ts';
import { deliveryNeedsAction, HELD_DELIVERY_STATES, queuedBehind } from './turn-hint.ts';

/**
 * 送达状态（ADR 0031 D2）：按 prompt 的 seq 查。送达了就什么都不显示（安静）。
 *
 * `quiet` 给窄屏用：纯等待（还在投递 / 排队等前面那条）由对话末尾那一条进度说，
 * 气泡下面就不再重复；要人动手的（未送达、重试倒计时、带回撤的排队）照旧显示在这儿。
 */
export const DeliveryContext = createContext<{
  sessionId: string;
  bySeq: ReadonlyMap<number, DeliveryDto>;
  quiet?: boolean;
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
  if (ctx.quiet === true && (d.state === 'sending' || (d.state === 'queued' && !deliveryNeedsAction(d, ctx.bySeq.values())))) {
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
    }
  };
  const retry = <button className="underline underline-offset-2 disabled:opacity-50" disabled={busy} onClick={act(deliveryApi.retry)}>立即重试</button>;
  const cancel = <button className="underline underline-offset-2 disabled:opacity-50" disabled={busy} onClick={act(deliveryApi.cancel)}>撤回</button>;
  const actions = (
    <>
      {' · '}
      {retry}
      {' · '}
      {cancel}
    </>
  );
  let body;
  if (d.state === 'sending') body = <span className="text-tertiary">发送中…</span>;
  else if (d.state === 'undelivered')
    body = <span className="text-rust" title={d.lastError ?? undefined}>未送达{d.lastError ? `：${d.lastError}` : ''}{actions}</span>;
  else if (d.attempt === 0) {
    const behind = queuedBehind(d, ctx.bySeq.values());
    body = behind
      ? <span className="text-tertiary">排队中 · 等上一条送达</span>
      : <span className="text-tertiary">排队中 · {cancel}</span>;
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
