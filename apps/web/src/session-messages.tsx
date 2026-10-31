import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type AgentMessageDto } from './api.ts';
import { localTime } from './local-time.ts';

const STATUS_TEXT: Record<AgentMessageDto['status'], string> = {
  queued: '排队中',
  awaiting_approval: '等人批准',
  delivered: '已投递',
  answered: '已回复',
  done: '已完成',
  failed: '失败',
  denied: '被拒绝'
};
const KIND_TEXT: Record<AgentMessageDto['kind'], string> = { send: '通知', ask: '提问', reply: '回复' };

/**
 * 检查器 · 协作消息（ADR 0018）：这条会话和别的 agent 之间的往来、等人批的派生请求（批准卡片），
 * 以及人替这条会话发一条（send / ask）。窄屏下整块纵向排、按钮够大。
 */
export function SessionMessages({ sessionId }: { sessionId: string }) {
  const client = useQueryClient();
  const key = ['session-messages', sessionId];
  const data = useQuery({ queryKey: key, queryFn: () => api.sessionMessages(sessionId), refetchInterval: 5_000 });
  const [to, setTo] = useState('');
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<'send' | 'ask'>('ask');
  const send = useMutation({
    mutationFn: () => api.sendAgentMessage(sessionId, { kind, to: to.trim(), body }),
    onSuccess: () => {
      setBody('');
      void client.invalidateQueries({ queryKey: key });
    }
  });
  const decide = useMutation({
    mutationFn: ({ id, approve }: { id: string; approve: boolean }) => api.decideAgentSpawn(id, approve),
    onSettled: () => void client.invalidateQueries({ queryKey: key })
  });
  const messages = data.data?.messages ?? [];
  const pending = data.data?.awaitingApproval ?? [];
  const self = `session:${sessionId}`;
  return (
    <section data-testid="session-messages">
      <p className="mb-1 text-meta text-tertiary">协作消息</p>
      {pending.map((m) => (
        <div key={m.messageId} data-testid="spawn-approval" className="mb-2 rounded border border-accent/50 bg-card-raised p-2 text-meta">
          <p className="text-primary">要派生新会话 <span className="font-mono">{m.to}</span> 来{KIND_TEXT[m.kind]}：</p>
          <p className="my-1 line-clamp-3 break-words text-secondary">{m.body}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" data-testid="spawn-approve" className="min-h-9 rounded bg-accent px-3 text-primary" disabled={decide.isPending} onClick={() => decide.mutate({ id: m.messageId, approve: true })}>批准</button>
            <button type="button" data-testid="spawn-reject" className="min-h-9 rounded border border-strong px-3 text-secondary" disabled={decide.isPending} onClick={() => decide.mutate({ id: m.messageId, approve: false })}>拒绝</button>
          </div>
        </div>
      ))}
      {decide.error ? <p className="text-meta text-rust">{decide.error.message}</p> : null}
      {messages.length === 0 ? <p className="text-meta text-tertiary">还没有和别的 agent 往来</p> : null}
      {messages.map((m) => {
        const outgoing = m.from === self;
        return (
          <div key={m.messageId} data-testid="agent-message-row" data-status={m.status} className="mb-1 min-w-0 border-l-2 border-hair pl-2 text-meta">
            <p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
              <span className="shrink-0 text-primary">{outgoing ? '发出' : '收到'}·{KIND_TEXT[m.kind]}</span>
              <span className="min-w-0 truncate font-mono text-tertiary">{outgoing ? m.to : m.from}</span>
              <span className={`shrink-0 ${m.status === 'failed' || m.status === 'denied' ? 'text-rust' : 'text-secondary'}`}>{STATUS_TEXT[m.status]}{m.failure ? `（${m.failure}）` : ''}</span>
              <span className="ml-auto shrink-0 font-mono text-tertiary">{localTime(m.createdAt)}</span>
            </p>
            <p className="line-clamp-2 break-words text-secondary">{m.body || m.failureDetail}</p>
            {m.reply ? <p className="line-clamp-3 break-words text-primary" data-testid="agent-message-reply">↳ {m.reply}</p> : null}
          </div>
        );
      })}
      <form
        className="mt-2 flex flex-col gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (to.trim() && body.trim()) send.mutate();
        }}
      >
        <div className="flex gap-1.5">
          <select aria-label="类型" className="min-h-9 rounded border border-hair bg-card px-1 text-meta" value={kind} onChange={(e) => setKind(e.target.value as 'send' | 'ask')}>
            <option value="ask">提问</option>
            <option value="send">通知</option>
          </select>
          <input data-testid="agent-message-to" className="min-h-9 min-w-0 flex-1 rounded border border-hair bg-card px-2 font-mono text-meta" placeholder="session:<id> 或 role:<名字>" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <textarea data-testid="agent-message-body" className="min-h-16 w-full rounded border border-hair bg-card px-2 py-1 text-meta" placeholder="替这条会话发给另一个 agent…" value={body} onChange={(e) => setBody(e.target.value)} />
        <button type="submit" data-testid="agent-message-send" className="min-h-9 self-end rounded bg-accent px-3 text-meta text-primary" disabled={send.isPending}>发送</button>
        {send.error ? <p className="text-meta text-rust" data-testid="agent-message-error">{send.error.message}</p> : null}
      </form>
    </section>
  );
}
