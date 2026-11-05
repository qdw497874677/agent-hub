import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, connectorApi, type AttentionItemDto, type AttentionPhase } from './api.ts';
import { formatRoute } from './route.ts';
import { relativeTime } from './workers.tsx';

/**
 * 「等我处理」（ADR 0031 D1）：不推送，只给角标、标题前的 (N) 和首页收件箱。
 * 只算我发起的 / 我负责的会话；看过（打开会话停几秒，或点「稍后」）就收起，阶段变了再上榜。
 */
export const PHASE_LABEL: Readonly<Record<AttentionPhase, string>> = {
  needs_approval: '等审批',
  undelivered: '未送达',
  failed: '失败了',
  needs_answer: '等回答',
  needs_review: '等审查'
};

const BASE_TITLE = typeof document === 'undefined' ? '' : document.title.replace(/^\(\d+\)\s*/, '');

export function useAttention() {
  const query = useQuery({ queryKey: ['attention'], queryFn: api.attention, refetchInterval: 10_000 });
  const count = query.data?.items.length ?? 0;
  useEffect(() => {
    document.title = count > 0 ? `(${count}) ${BASE_TITLE}` : BASE_TITLE;
  }, [count]);
  return query;
}

export function useAckAttention() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (item: AttentionItemDto) => api.ackAttention(item),
    onSuccess: () => client.invalidateQueries({ queryKey: ['attention'] })
  });
}

/** 顶栏角标：有事才露脸，点了回首页收件箱。 */
export function AttentionBadge({ onClick, compact = false }: { onClick(): void; compact?: boolean }) {
  const count = useAttention().data?.items.length ?? 0;
  if (count === 0) return null;
  return (
    <button
      data-testid="attention-badge"
      aria-label={`等我处理（${count}）`}
      title="等我处理"
      onClick={onClick}
      className="flex h-7 shrink-0 items-center gap-1 rounded-full bg-rust px-2 text-meta text-canvas hover:opacity-90"
    >
      {compact ? null : <span className="hidden sm:inline">待办</span>}
      <span>{count}</span>
    </button>
  );
}

/** 打开某条会话停几秒 = 看过了。 */
export function useAutoAck(sessionId: string | null, delayMs = 3000) {
  const attention = useAttention();
  const ack = useAckAttention();
  const item = sessionId ? attention.data?.items.find((i) => i.sessionId === sessionId) : undefined;
  const key = item ? `${item.sessionId}|${item.phase}|${item.since}` : null;
  useEffect(() => {
    if (!item) return;
    const timer = setTimeout(() => ack.mutate(item), delayMs);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

/** 首页顶部收件箱；没事时收成一行灰字。 */
export function AttentionInbox({ onOpen }: { onOpen(item: AttentionItemDto): void }) {
  const attention = useAttention();
  const ack = useAckAttention();
  if (!attention.data) return <ConnectorNotices />;
  const { items, working } = attention.data;
  if (items.length === 0) {
    return (
      <><ConnectorNotices /><p data-testid="attention-quiet" className="mb-4 text-meta text-tertiary">
        没有等你处理的{working > 0 ? ` · ${working} 条在跑` : ''}
      </p></>
    );
  }
  return (
    <><ConnectorNotices />
    <section data-testid="attention-inbox" className="mb-5 rounded-md border border-rust/40 bg-card">
      <p className="border-b border-hair px-3 py-2 text-meta text-primary">
        等我处理 · {items.length}
        {working > 0 ? <span className="text-tertiary"> （另有 {working} 条在跑）</span> : null}
      </p>
      <ul>
        {items.map((item) => (
          <li key={`${item.sessionId}|${item.phase}`} data-testid="attention-item" data-phase={item.phase}
            className="flex items-center gap-2 border-b border-hair px-3 py-2 last:border-b-0">
            <span className={`shrink-0 rounded px-1.5 text-[11px] leading-[18px] ${item.possible ? 'border border-hair text-secondary' : 'bg-rust/15 text-rust'}`}>
              {item.possible ? '可能在等你' : PHASE_LABEL[item.phase]}
            </span>
            <button className="min-w-0 flex-1 text-left" onClick={() => onOpen(item)}>
              <span className="block truncate text-body text-primary">{item.taskTitle}</span>
              <span className="block truncate text-meta text-tertiary">
                {item.projectName} · {item.agentId} · {item.reason} · {relativeTime(item.since)}
              </span>
            </button>
            <button data-testid="attention-later" className="shrink-0 text-meta text-secondary hover:text-accent" onClick={() => ack.mutate(item)}>
              稍后
            </button>
          </li>
        ))}
      </ul>
    </section></>
  );
}

/** 连接器的事（ADR 0032）：自动暂停的触发、超额等批准的 bot 任务。 */
function ConnectorNotices() {
  const client = useQueryClient();
  const notices = useQuery({ queryKey: ['connector-notices'], queryFn: connectorApi.notices, refetchInterval: 15_000 });
  const decide = useMutation({
    mutationFn: ({ id, approve }: { id: string; approve: boolean }) => connectorApi.decide(id, approve),
    onSuccess: () => client.invalidateQueries({ queryKey: ['connector-notices'] })
  });
  const list = notices.data?.notices ?? [];
  if (!list.length) return null;
  return (
    <section data-testid="connector-notices" className="mb-3 rounded-md border border-rust/40 bg-card">
      <ul>
        {list.map((n) => (
          <li key={`${n.kind}|${n.id}`} data-testid="connector-notice" data-kind={n.kind} className="flex flex-wrap items-center gap-2 border-b border-hair px-3 py-2 last:border-b-0">
            <span className="shrink-0 rounded bg-rust/15 px-1.5 text-[11px] leading-[18px] text-rust">{n.kind === 'binding_paused' ? '触发已暂停' : n.kind === 'inbound_quarantined' ? '疑似注入已隔离' : 'bot 建任务待批'}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-body text-primary">{n.title}</span>
              <span className="block truncate text-meta text-tertiary">{n.reason} · {relativeTime(n.since)}</span>
            </span>
            {n.kind === 'task_pending' ? (
              <span className="flex gap-1">
                <button data-testid="agent-task-approve" className="text-meta text-accent" disabled={decide.isPending} onClick={() => decide.mutate({ id: n.id, approve: true })}>批准</button>
                <button data-testid="agent-task-reject" className="text-meta text-secondary" disabled={decide.isPending} onClick={() => decide.mutate({ id: n.id, approve: false })}>拒绝</button>
              </span>
            ) : (
              <a className="text-meta text-accent" href={formatRoute({ page: 'bots', projectId: n.projectId })}>去 Bot 页</a>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 放在会话页里：停留几秒自动标「看过」。 */
export function AttentionAutoAck({ sessionId }: { sessionId: string }) {
  useAutoAck(sessionId);
  return null;
}
