import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type SessionPeerDto } from '../shell/api.ts';

const STATUS: Record<string, string> = { archived: '已收起', busy: '工作中', idle: '空闲', done: '空闲', stopped: '已停止', interrupted: '被打断', failed: '失败', starting: '启动中' };

/** 同伴能互相说话的原因（和 agent 看到的 agent.peers 同一份判定）。 */
type PeerRelation = NonNullable<SessionPeerDto['relation']>;

const RELATION: Record<PeerRelation, { readonly text: string; readonly title: string }> = {
  explicit: { text: '连线', title: '在画布或连线选择器里显式连过' },
  spawn: { text: '派生', title: '同一条派生链上的父子会话' },
  task_tree: { text: '同任务树', title: '同一棵顶层任务树里的会话（不用连线）' }
};

/**
 * 这条同伴为什么能发消息：有 relation 就照它说；没有时只认真正的显式连线。
 * 老服务端不给 relation，这时不能把「没连线」一律当成派生——那会把同任务树的会话说错。
 */
export function peerRelation(peer: Pick<SessionPeerDto, 'relation' | 'connected'>): PeerRelation | null {
  if (peer.relation && Object.hasOwn(RELATION, peer.relation)) return peer.relation;
  return peer.connected === true ? 'explicit' : null;
}

/**
 * 检查器 · 同伴（会话通信 P1e）：这条会话能直接说话的会话——
 * 同一棵顶层任务树里的、显式连线的、派生关系的。每个显示短名（peer:<短名>）、状态、
 * 落在哪台机器、仓库与分支，以及为什么能联系。顶上可以改这条会话自己的短名。
 * 列表和 agent 看到的 agent.peers 同源；具体能不能发还看项目里的权限。
 */
export function SessionPeers({ sessionId }: { sessionId: string }) {
  const client = useQueryClient();
  const key = ['session-peers', sessionId];
  const data = useQuery({ queryKey: key, queryFn: () => api.sessionPeers(sessionId), refetchInterval: 10_000 });
  const own = data.data?.handle ?? '';
  const peers = (data.data?.peers ?? []).filter((p) => p.address !== `session:${sessionId}`);
  const [handle, setHandle] = useState('');
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setHandle(own);
  }, [own, editing]);
  const save = useMutation({
    mutationFn: () => api.setSessionHandle(sessionId, handle.trim()),
    onSuccess: () => {
      setEditing(false);
      void client.invalidateQueries({ queryKey: key });
    }
  });
  return (
    <section data-testid="session-peers">
      <p className="flex items-baseline gap-1.5 text-meta text-tertiary">
        同伴 <span data-testid="session-peers-count" className="rounded bg-card-raised px-1 text-[10px] text-secondary">{peers.length}</span>
      </p>
      <p data-testid="session-peers-scope" className="mb-1 text-[10px] leading-snug text-tertiary">
        同一棵任务树、连线或派生的会话可互发消息，仍受项目权限约束
      </p>
      <form
        className="mb-1.5 flex items-center gap-1.5 text-meta"
        onSubmit={(event) => {
          event.preventDefault();
          if (handle.trim()) save.mutate();
        }}
      >
        <label className="shrink-0 text-tertiary" htmlFor={`handle-${sessionId}`}>我的短名 peer:</label>
        <input
          id={`handle-${sessionId}`}
          data-testid="session-handle-input"
          className="min-h-8 min-w-0 flex-1 rounded border border-hair bg-card px-1.5 font-mono text-meta"
          value={handle}
          onChange={(e) => {
            setEditing(true);
            setHandle(e.target.value);
          }}
        />
        {editing ? (
          <button type="submit" data-testid="session-handle-save" className="min-h-8 shrink-0 rounded bg-action px-2 text-action-fg" disabled={save.isPending}>保存</button>
        ) : null}
      </form>
      {save.error ? <p className="text-meta text-rust" data-testid="session-handle-error">{save.error.message}</p> : null}
      {peers.length === 0 ? (
        <p data-testid="session-peers-empty" className="text-meta text-tertiary">
          还没有同伴：同一棵任务树里的会话会出现在这里；也可以连线，或让 agent 派生一个
        </p>
      ) : null}
      <ul className="space-y-1">
        {peers.map((peer) => {
          const relation = peerRelation(peer);
          return (
            <li key={peer.address} data-testid="session-peer-row" className="min-w-0 border-l-2 border-hair pl-2 text-meta">
              <p className="flex min-w-0 items-baseline gap-1.5">
                <span className="min-w-0 truncate font-mono text-primary">peer:{peer.handle ?? '?'}</span>
                <span className="shrink-0 text-secondary">{STATUS[peer.status] ?? peer.status}</span>
                {peer.unread ? <span className="shrink-0 rounded bg-warning/30 px-1 text-[10px] text-primary">{peer.unread} 未读</span> : null}
                <span
                  data-testid="session-peer-relation"
                  data-relation={relation ?? 'unknown'}
                  title={relation ? RELATION[relation].title : undefined}
                  className="ml-auto shrink-0 text-[10px] text-tertiary"
                >
                  {relation ? RELATION[relation].text : ''}
                </span>
              </p>
              <p className="truncate text-tertiary" title={peer.title ?? peer.label}>
                {peer.title ?? peer.label}
                {peer.repo ? ` · ${peer.repo}${peer.branch ? `@${peer.branch}` : ''}` : ''}
                {peer.workerId ? ` · ${peer.workerId}` : ''}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
