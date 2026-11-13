import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { memoryApi, type MemoryEntryDto } from './api.ts';
import { AccountMenu, useAccount } from './auth.tsx';
import { formatRoute } from './route.ts';
import { INPUT, SMALL, DANGER, at, errorText, Section, Panel, Empty } from './admin/shared.tsx';

/**
 * 记忆页（#/memory[/<作用域>]，ADR 0019 · P1 最小界面）：待审、某个作用域的条目、忘掉、手写一条。
 * 不做蒸馏、不做编辑——取代靠追加。390px 下单列。
 */
const KEY = ['memory'] as const;
const KIND_TEXT: Record<MemoryEntryDto['kind'], string> = { semantic: '事实', episodic: '经历', procedural: '做法' };
const STATUS_TEXT: Partial<Record<MemoryEntryDto['status'], string>> = { staged: '暂存', proposed: '待审', active: '生效' };

function useMemoryAction<T>(run: (input: T) => Promise<unknown>) {
  const client = useQueryClient();
  return useMutation({ mutationFn: run, onSuccess: () => client.invalidateQueries({ queryKey: KEY }) });
}

function EntryRow({ entry, canReview }: { entry: MemoryEntryDto; canReview: boolean }) {
  const review = useMemoryAction((approve: boolean) => memoryApi.review(entry.id, approve));
  const forget = useMemoryAction((reason: string) => memoryApi.forget(entry.id, reason));
  const error = review.error ?? forget.error;
  return (
    <li data-testid="memory-entry" className="border-b border-hair px-3 py-2 last:border-0">
      <div className="flex flex-wrap items-center gap-1.5 text-meta">
        <span className="rounded-sm bg-card px-1.5 text-secondary">{KIND_TEXT[entry.kind]}</span>
        <span className={entry.status === 'proposed' || entry.status === 'staged' ? 'text-rust' : 'text-tertiary'}>{STATUS_TEXT[entry.status] ?? entry.status}</span>
        {entry.trust === 'untrusted' ? <span className="text-tertiary">· agent 写的</span> : null}
        {entry.stale ? <span data-testid="memory-stale" className="text-rust">· 来源已变化</span> : null}
        <span className="ml-auto text-tertiary">{at(entry.updatedAt)}</span>
      </div>
      <p className="mt-1 break-words text-body text-primary">{entry.title}</p>
      <p className="mt-0.5 whitespace-pre-wrap break-words text-meta text-secondary">{entry.body}</p>
      <div className="mt-1.5 flex flex-wrap gap-2">
        {(entry.status === 'proposed' || entry.status === 'staged') && canReview ? (
          <>
            <button className={SMALL} data-testid="memory-approve" disabled={review.isPending} onClick={() => review.mutate(true)}>{entry.status === 'staged' ? '采纳' : '通过'}</button>
            <button className={SMALL} data-testid="memory-reject" disabled={review.isPending} onClick={() => review.mutate(false)}>拒绝</button>
          </>
        ) : null}
        <button
          className={DANGER}
          data-testid="memory-forget"
          disabled={forget.isPending}
          onClick={() => {
            const reason = window.prompt('为什么忘掉这条？');
            if (reason?.trim()) forget.mutate(reason.trim());
          }}
        >
          忘掉
        </button>
      </div>
      {error ? <p className="mt-1 text-meta text-rust">{errorText(error)}</p> : null}
    </li>
  );
}

function WriteForm({ scope }: { scope: string }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<MemoryEntryDto['kind']>('semantic');
  const write = useMemoryAction(() => memoryApi.write({ scope, kind, title: title.trim(), body: body.trim() }));
  return (
    <form
      className="flex flex-col gap-2 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (title.trim() && body.trim()) write.mutate(undefined, { onSuccess: () => { setTitle(''); setBody(''); } });
      }}
    >
      <div className="flex gap-2">
        <select aria-label="类型" className={`${INPUT} w-24 shrink-0`} value={kind} onChange={(e) => setKind(e.target.value as MemoryEntryDto['kind'])}>
          {Object.entries(KIND_TEXT).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <input aria-label="标题" data-testid="memory-title" className={`${INPUT} min-w-0 flex-1`} placeholder="标题" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <textarea aria-label="内容" data-testid="memory-body" className={`${INPUT} min-h-20`} placeholder="内容（不超过 4000 字，别放密钥）" maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="flex items-center gap-2">
        <button type="submit" className={SMALL} data-testid="memory-save" disabled={write.isPending || !title.trim() || !body.trim()}>记下</button>
        {write.error ? <p className="text-meta text-rust">{errorText(write.error)}</p> : null}
      </div>
    </form>
  );
}

export function MemoryPage({ scope }: { scope: string | null }) {
  const account = useAccount();
  const scopes = useQuery({ queryKey: [...KEY, 'scopes'], queryFn: memoryApi.scopes, enabled: !!account });
  const pending = useQuery({ queryKey: [...KEY, 'pending'], queryFn: memoryApi.pending, enabled: !!account });
  const all = scopes.data?.scopes ?? [];
  const current = all.find((s) => s.key === scope) ?? all[0] ?? null;
  const entries = useQuery({ queryKey: [...KEY, 'list', current?.key], queryFn: () => memoryApi.list(current!.key), enabled: !!current });
  if (!account) return null;
  const reviewable = new Set(all.filter((s) => s.canReview).map((s) => s.key));
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-hair px-3 py-2">
        <div className="min-w-0">
          <a className="text-meta text-tertiary hover:text-accent" href={formatRoute({ page: 'home' })}>← agent-hub</a>
          <h1 className="text-head text-primary">记忆</h1>
        </div>
        <AccountMenu />
      </header>
      <nav aria-label="记忆作用域" className="flex gap-1 overflow-x-auto border-b border-hair px-2 py-1.5">
        {all.map((s) => (
          <a
            key={s.key}
            href={formatRoute({ page: 'memory', scope: s.key })}
            data-testid="memory-scope"
            aria-current={s.key === current?.key ? 'page' : undefined}
            className={`shrink-0 rounded-sm px-3 py-1.5 text-body ${s.key === current?.key ? 'bg-card text-primary' : 'text-secondary hover:bg-card'}`}
          >
            {s.label}
          </a>
        ))}
      </nav>
      <main className="min-h-0 flex-1 overflow-y-auto px-3 py-4 md:px-6">
        <div className="mx-auto flex max-w-[960px] flex-col gap-6">
          {pending.data?.entries.length ? (
            <Section title={`待审（${pending.data.entries.length}）`}>
              <Panel>
                <ul data-testid="memory-pending">
                  {pending.data.entries.map((e) => <EntryRow key={e.id} entry={e} canReview />)}
                </ul>
              </Panel>
            </Section>
          ) : null}
          {current ? (
            <Section title={current.label}>
              {current.canWrite ? <Panel><WriteForm scope={current.key} /></Panel> : null}
              <Panel>
                {entries.data?.entries.length ? (
                  <ul data-testid="memory-list">
                    {entries.data.entries.map((e) => <EntryRow key={e.id} entry={e} canReview={reviewable.has(current.key)} />)}
                  </ul>
                ) : (
                  <Empty text={entries.isLoading ? '加载中…' : '这里还没有记忆。agent 会先搜再写。'} />
                )}
              </Panel>
            </Section>
          ) : (
            <Empty text={scopes.isLoading ? '加载中…' : '没有可看的记忆作用域'} />
          )}
        </div>
      </main>
    </div>
  );
}
