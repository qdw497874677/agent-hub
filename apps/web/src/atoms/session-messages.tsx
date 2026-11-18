import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type AgentMessageDto, type AgentMessagePartDto } from '../shell/api.ts';
import { localTime } from '../shell/local-time.ts';

const STATUS_TEXT: Record<AgentMessageDto['status'], string> = {
  queued: '排队中',
  awaiting_approval: '等人批准',
  held: '被拦下',
  delivered: '已投递',
  answered: '已回复',
  done: '已完成',
  failed: '失败',
  denied: '被拒绝'
};
const KIND_TEXT: Record<AgentMessageDto['kind'], string> = { send: '通知', ask: '提问', reply: '回复' };
const HOLD_TEXT: Record<string, string> = {
  pingpong: '两边来回太多次，像在打转',
  privilege: '要审批的会话发给免审批的会话（可能借它绕过审批）'
};
const REPLY_STATUS: Record<string, string> = { ok: '完成', failed: '失败', refused: '拒绝' };

/** 附件一行字：data 显示 schema，ref 显示仓库@分支，file 显示路径，link 显示标题。 */
export function partLabel(part: AgentMessagePartDto): string {
  if (part.type === 'data') return `数据${part.schema ? ` · ${part.schema}` : ''}`;
  if (part.type === 'ref') return `${part.repo}${part.branch ? `@${part.branch}` : ''}${part.sha ? ` · ${part.sha.slice(0, 7)}` : ''}`;
  if (part.type === 'file') return `文件 · ${part.path}`;
  return part.label ?? part.url;
}

function Parts({ parts }: { parts: readonly AgentMessagePartDto[] | undefined }) {
  if (!parts || parts.length === 0) return null;
  return (
    <ul className="my-0.5 flex flex-wrap gap-1" aria-label="附件">
      {parts.map((part, index) => (
        <li key={index} data-testid="agent-message-part" data-type={part.type} className="max-w-[220px] truncate rounded-sm border border-hair px-1 font-mono text-[10px] text-secondary" title={part.type === 'data' ? JSON.stringify(part.data) : partLabel(part)}>
          {part.type === 'link' ? <a href={part.url} target="_blank" rel="noreferrer" className="text-link">{partLabel(part)}</a> : partLabel(part)}
        </li>
      ))}
    </ul>
  );
}

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
  const all = data.data?.messages ?? [];
  const held = all.filter((m) => m.status === 'held');
  const messages = all.filter((m) => m.status !== 'held');
  const pending = data.data?.awaitingApproval ?? [];
  const self = `session:${sessionId}`;
  return (
    <section data-testid="session-messages">
      <p className="mb-1 text-meta text-tertiary">协作消息</p>
      {pending.map((m) => (
        <div key={m.messageId} data-testid="spawn-approval" className="mb-2 rounded border border-warning/50 bg-card-raised p-2 text-meta">
          <p className="text-primary">要派生新会话 <span className="font-mono">{m.to}</span> 来{KIND_TEXT[m.kind]}：</p>
          <p className="my-1 line-clamp-3 break-words text-secondary">{m.body}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" data-testid="spawn-approve" className="min-h-9 rounded bg-action px-3 text-action-fg" disabled={decide.isPending} onClick={() => decide.mutate({ id: m.messageId, approve: true })}>批准</button>
            <button type="button" data-testid="spawn-reject" className="min-h-9 rounded border border-strong px-3 text-secondary" disabled={decide.isPending} onClick={() => decide.mutate({ id: m.messageId, approve: false })}>拒绝</button>
          </div>
        </div>
      ))}
      {held.map((m) => (
        <div key={m.messageId} data-testid="held-message" data-reason={m.holdReason ?? ''} className="mb-2 rounded border border-warning/50 bg-card-raised p-2 text-meta">
          <p className="text-primary">
            一条{KIND_TEXT[m.kind]}被拦下：<span className="font-mono">{m.from === self ? m.to : (m.fromLabel ?? m.from)}</span>
          </p>
          <p className="text-tertiary">{HOLD_TEXT[m.holdReason ?? ''] ?? '等人确认'}</p>
          <p className="my-1 line-clamp-3 break-words text-secondary">{m.body}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" data-testid="held-release" className="min-h-9 rounded bg-action px-3 text-action-fg" disabled={decide.isPending} onClick={() => decide.mutate({ id: m.messageId, approve: true })}>放行</button>
            <button type="button" data-testid="held-reject" className="min-h-9 rounded border border-strong px-3 text-secondary" disabled={decide.isPending} onClick={() => decide.mutate({ id: m.messageId, approve: false })}>拒绝</button>
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
              <span className="min-w-0 truncate font-mono text-tertiary" title={outgoing ? m.to : m.from}>{outgoing ? m.to : (m.fromLabel ?? m.from)}</span>
              {m.wake === false ? <span data-testid="agent-message-quiet" className="shrink-0 rounded bg-card-raised px-1 text-[10px] text-tertiary">不唤醒{outgoing ? '' : m.readAt ? '·已读' : '·未读'}</span> : null}
              <span className={`shrink-0 ${m.status === 'failed' || m.status === 'denied' ? 'text-rust' : 'text-secondary'}`}>{STATUS_TEXT[m.status]}{m.failure ? `（${m.failure}）` : ''}</span>
              <span className="ml-auto shrink-0 font-mono text-tertiary">{localTime(m.createdAt)}</span>
            </p>
            <p className="line-clamp-2 break-words text-secondary">{m.body || m.failureDetail}</p>
            <Parts parts={m.parts} />
            {m.reply ? (
              <p className="line-clamp-3 break-words text-primary" data-testid="agent-message-reply">
                ↳ {m.replyStatus && m.replyStatus !== 'ok' ? <span className="text-rust">[{REPLY_STATUS[m.replyStatus]}] </span> : null}
                {m.reply}
              </p>
            ) : null}
            <Parts parts={m.replyParts} />
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
          <input data-testid="agent-message-to" className="min-h-9 min-w-0 flex-1 rounded border border-hair bg-card px-2 font-mono text-meta" placeholder="peer:<短名>、session:<id> 或 bot:<名字>" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <textarea data-testid="agent-message-body" className="min-h-16 w-full rounded border border-hair bg-card px-2 py-1 text-meta" placeholder="替这条会话发给另一个 agent…" value={body} onChange={(e) => setBody(e.target.value)} />
        <button type="submit" data-testid="agent-message-send" className="min-h-9 self-end rounded bg-action px-3 text-meta text-action-fg" disabled={send.isPending}>发送</button>
        {send.error ? <p className="text-meta text-rust" data-testid="agent-message-error">{send.error.message}</p> : null}
      </form>
    </section>
  );
}
