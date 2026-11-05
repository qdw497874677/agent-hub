import { createContext, useContext, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { deliveryApi, type DeliveryDto } from './api.ts';

/** 送达状态（ADR 0031 D2）：按 prompt 的 seq 查。送达了就什么都不显示（安静）。 */
export const DeliveryContext = createContext<{ sessionId: string; bySeq: ReadonlyMap<number, DeliveryDto> } | null>(null);

const PENDING = new Set(['queued', 'sending', 'undelivered']);

export function useDeliveries(sessionId: string, eventCount: number) {
  const query = useQuery({
    queryKey: ['deliveries', sessionId, eventCount],
    queryFn: () => deliveryApi.list(sessionId),
    retry: false,
    refetchInterval: (q) => ((q.state.data ?? []).some((d) => PENDING.has(d.state)) ? 2_000 : false)
  });
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
  if (!ctx || !d || !PENDING.has(d.state)) {
    return d?.state === 'cancelled' ? <p className="text-meta text-tertiary" data-testid="delivery-note">已撤回 · 没有发给 agent</p> : null;
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
  const actions = (
    <>
      {' · '}
      <button className="underline underline-offset-2 disabled:opacity-50" disabled={busy} onClick={act(deliveryApi.retry)}>立即重试</button>
      {' · '}
      <button className="underline underline-offset-2 disabled:opacity-50" disabled={busy} onClick={act(deliveryApi.cancel)}>撤回</button>
    </>
  );
  let body;
  if (d.state === 'sending') body = <span className="text-tertiary">发送中…</span>;
  else if (d.state === 'undelivered')
    body = <span className="text-rust" title={d.lastError ?? undefined}>未送达{d.lastError ? `：${d.lastError}` : ''}{actions}</span>;
  else if (d.attempt === 0) {
    const behind = [...ctx.bySeq.values()].some((o) => o.seq < d.seq && PENDING.has(o.state));
    body = <span className="text-tertiary">{behind ? '排队中 · 等上一条送达' : '排队中 · 等这一轮结束'}</span>;
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
