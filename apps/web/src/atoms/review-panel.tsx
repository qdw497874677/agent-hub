import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { reviewApi, type ReviewDraftDto, type ReviewNoteDto } from '../shell/api/files.ts';
import { RequestFailed } from '../shell/api/http.ts';
import { newClientMessageId } from './pending-prompt.ts';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const deliveryText: Record<NonNullable<ReviewNoteDto['delivery']>['state'], string> = {
  queued: '排队中', sending: '发送中', delivered: '已送达', undelivered: '未送达', cancelled: '已取消', unknown: '状态未知'
};
type Attempt = { batchId: string; targetSessionId: string; noteIds: string[] };

/** Reviews belong to the session, not the currently selected file or workspace. */
export function useReview(sessionId: string, accountId: string | null, enabled: boolean) {
  const [ticks, setTicks] = useState(0);
  const client = useQueryClient();
  const key = ['review', accountId, sessionId] as const;
  const review = useQuery({ queryKey: ['review', accountId, sessionId], queryFn: () => reviewApi.get(sessionId), enabled: enabled && !!accountId, retry: false, staleTime: 0, refetchOnWindowFocus: false });
  const refetch = review.refetch;
  const inFlight = review.data?.notes.some((n) => n.delivery?.state === 'queued' || n.delivery?.state === 'sending') ?? false;
  useEffect(() => {
    if (!enabled || !inFlight || ticks >= 6 || review.error) return;
    const timer = window.setTimeout(() => {
      setTicks((n) => n + 1);
      void reviewApi.get(sessionId, { statusOnly: true }).then((next) => {
        client.setQueryData<import('../shell/api/files.ts').ReviewDto>(key, (old) => old ? { ...next, notes: next.notes.map((note) => ({ ...note, anchorState: note.delivery ? 'unknown' : old.notes.find((n) => n.id === note.id)?.anchorState ?? 'unknown' })) } : next);
      }).catch(() => undefined);
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [enabled, inFlight, ticks, review.error, sessionId, accountId, client]);
  const refresh = () => { setTicks(0); return refetch(); };
  const revalidate = async (id: string) => {
    const next = await reviewApi.get(sessionId, { notes: [id] });
    client.setQueryData<import('../shell/api/files.ts').ReviewDto>(key, (old) => old ? { ...old, notes: old.notes.map((note) => note.id === id ? next.notes.find((n) => n.id === id) ?? note : note) } : next);
  };
  return { review, refresh, revalidate };
}

export function ReviewPanel({ sessionId, accountId, state, onOpen }: { sessionId: string; accountId: string | null; state: ReturnType<typeof useReview>; onOpen: (note: ReviewNoteDto) => void }) {
  const { review, refresh, revalidate } = state;
  const [selected, setSelected] = useState<string[]>([]);
  const [target, setTarget] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [canCancel, setCanCancel] = useState(false);
  const lock = useRef(false);
  const storageKey = `agent-hub:review-attempt:${encodeURIComponent(accountId ?? '')}:${encodeURIComponent(sessionId)}`;
  const [attempt, setAttempt] = useState<Attempt | null>(() => {
    try { return JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') as Attempt | null; } catch { return null; }
  });
  const remember = (value: Attempt | null): boolean => {
    try { if (value) sessionStorage.setItem(storageKey, JSON.stringify(value)); else sessionStorage.removeItem(storageKey); }
    catch { if (value) return false; }
    setAttempt(value);
    return true;
  };
  useEffect(() => {
    if (attempt && review.data?.notes.some((n) => n.delivery?.batchId === attempt.batchId)) {
      remember(null);
      setSelected([]);
    }
  }, [attempt, review.data]);
  useEffect(() => {
    if (!review.data) return;
    const ids = new Set(review.data.notes.map((note) => note.id));
    setSelected((old) => old.filter((id) => ids.has(id)));
  }, [review.data]);
  const perform = async (fn: () => Promise<unknown>, unlockOnRejection = false, refreshAfter = true) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setCanCancel(false);
    try { await fn(); if (refreshAfter) await refresh(); } catch (e) {
      if (unlockOnRejection && e instanceof RequestFailed && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) remember(null);
      setError(message(e));
      const result = await refresh();
      if (!unlockOnRejection && attempt && e instanceof RequestFailed && e.status === 409 && !result.error && !result.data?.notes.some((n) => n.delivery?.batchId === attempt.batchId)) setCanCancel(true);
    }
    finally { lock.current = false; setBusy(false); }
  };
  const notes = review.error ? [] : review.data?.notes ?? [];
  const eligible = notes.filter((n) => selected.includes(n.id) && n.anchorState === 'current' && !n.delivery);
  const send = () => {
    if (!attempt && (!target || eligible.length === 0 || eligible.length > 20 || eligible.length !== selected.length)) return;
    const next = attempt ?? { batchId: newClientMessageId().replace(/-/g, '_'), targetSessionId: target, noteIds: eligible.map((n) => n.id) };
    if (!attempt && !remember(next)) { setError('无法保存发送批次，请允许浏览器存储后重试。'); return; }
    // A rejection of a retry does not prove that an earlier ambiguous request was not admitted.
    void perform(() => reviewApi.send(sessionId, next), !attempt);
  };
  return <section data-testid="review-panel" className="border-b border-hair px-3 py-3 text-sub">
    <div className="flex items-center justify-between gap-2"><h3 className="font-medium text-primary">审阅备注 <span className="text-tertiary">{review.data?.notes.length ?? ''}</span></h3><button type="button" data-testid="review-refresh" onClick={() => void refresh()} className="min-h-8 text-link">刷新</button></div>
    {review.isPending ? <p className="text-tertiary">读取备注中…</p> : null}
    {review.error ? <p role="alert" className="text-rust">读取备注失败：{message(review.error)}</p> : null}
    {error ? <p role="alert" className="my-1 text-rust">操作失败：{error}</p> : null}
    {!review.isPending && !review.error && notes.length === 0 ? <p className="text-tertiary">在改动中选择行，添加备注。</p> : null}
    <div className="space-y-3 py-2">
      {notes.map((note) => <div key={note.id} data-testid="review-note" className="min-w-0 border-l-2 border-hair pl-2">
        <div className="flex items-start gap-2">
          <input data-testid="review-select" aria-label={`选择备注 ${note.path}:${note.start}`} type="checkbox" className="mt-1" disabled={busy || !!attempt || (!selected.includes(note.id) && (selected.length >= 20 || note.anchorState !== 'current' || !!note.delivery))} checked={selected.includes(note.id)} onChange={(e) => setSelected((old) => e.target.checked && old.length < 20 ? [...old, note.id] : e.target.checked ? old : old.filter((id) => id !== note.id))} />
          <div className="min-w-0 flex-1"><button type="button" data-testid="review-open" onClick={() => onOpen(note)} className="break-all text-left font-mono text-link">{note.member ? `${note.member} · ` : ''}{note.path}:{note.start}{note.end !== note.start ? `–${note.end}` : ''}</button>
            <p className="text-meta text-tertiary">{note.base} · {note.side === 'old' ? '改前' : '改后'} · <span className={note.anchorState === 'current' ? 'text-sage' : 'text-rust'}>{note.anchorState === 'current' ? '当前版本' : note.anchorState === 'stale' ? '版本已变化' : '版本未知'}</span>{note.delivery ? ` · ${deliveryText[note.delivery.state]}` : ' · 未发送'}</p>
            <p className="whitespace-pre-wrap break-words text-secondary">{note.text}</p>
            {!note.delivery && note.anchorState === 'unknown' ? <button type="button" data-testid="review-revalidate" disabled={busy} onClick={() => void perform(() => revalidate(note.id), false, false)} className="mr-3 min-h-8 text-meta text-link">重新确认版本</button> : null}
            {!note.delivery ? <button type="button" data-testid="review-delete" disabled={busy || !!attempt?.noteIds.includes(note.id)} onClick={() => void perform(() => reviewApi.remove(sessionId, note.id))} className="min-h-8 text-meta text-tertiary hover:text-rust">删除备注</button> : null}
            {note.delivery?.state === 'undelivered' ? <button type="button" data-testid="review-retry" disabled={busy} onClick={() => void perform(() => reviewApi.retry(sessionId, note.delivery!.batchId))} className="min-h-8 text-meta text-link">重试发送</button> : null}
          </div>
        </div>
      </div>)}
    </div>
    {notes.length ? <div className="space-y-2">
      <label className="block text-meta text-secondary">发送到会话
        <select data-testid="review-target" value={target} disabled={busy || !!attempt} onChange={(e) => setTarget(e.target.value)} className="mt-1 min-h-9 w-full rounded bg-card px-2 text-sub text-primary"><option value="">选择会话</option>{review.data?.targets.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</select>
      </label>
      {attempt ? <p className="text-meta text-rust">上次发送结果尚未确认。重试会使用同一批次；请先刷新确认。</p> : null}
      <p className="text-meta text-tertiary">一次最多选择 20 条备注{selected.length ? `，已选 ${selected.length} 条` : ''}。</p>
      <button type="button" data-testid="review-send" disabled={busy || (!attempt && (!target || eligible.length === 0 || eligible.length > 20 || eligible.length !== selected.length))} onClick={send} className="min-h-9 rounded bg-action px-3 text-action-fg disabled:opacity-50">{attempt ? '重试确认发送' : `发送已选备注${eligible.length ? ` (${eligible.length})` : ''}`}</button>
      {canCancel && attempt ? <button type="button" data-testid="review-cancel-attempt" className="ml-2 min-h-9 text-meta text-secondary" onClick={() => { remember(null); setCanCancel(false); }}>取消这次重试</button> : null}
    </div> : null}
  </section>;
}

export function ReviewEditor({ draft, sessionId, disabled, onSaved, onCancel }: { draft: Omit<ReviewDraftDto, 'text'>; sessionId: string; disabled: boolean; onSaved: () => void; onCancel: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const save = async () => {
    if (lock.current || disabled || !text.trim()) return;
    lock.current = true; setBusy(true); setError('');
    try { await reviewApi.save(sessionId, { ...draft, text }); onSaved(); }
    catch (e) { setError(message(e)); }
    finally { lock.current = false; setBusy(false); }
  };
  return <div className="shrink-0 space-y-2 border-b border-hair bg-card px-3 py-2" data-testid="review-editor">
    <p className="text-meta text-secondary">备注 · {draft.side === 'old' ? '改前' : '改后'} {draft.start}{draft.end === draft.start ? '' : `–${draft.end}`} 行</p>
    <label className="sr-only" htmlFor="review-text">备注内容</label><textarea id="review-text" data-testid="review-text" value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={8000} className="w-full rounded bg-canvas p-2 text-sub text-primary" placeholder="写下你的备注…" />
    {error ? <p role="alert" className="text-meta text-rust">保存失败：{error}</p> : null}
    {disabled ? <p role="alert" className="text-meta text-rust">差异版本正在更新或无法确认，暂不能保存。请重新选择行。</p> : null}
    <div className="flex gap-3"><button type="button" data-testid="review-save" disabled={disabled || busy || !text.trim()} onClick={() => void save()} className="min-h-9 rounded bg-action px-3 text-sub text-action-fg disabled:opacity-50">保存备注</button><button type="button" disabled={busy} onClick={onCancel} className="min-h-9 text-sub text-secondary">取消</button></div>
  </div>;
}
