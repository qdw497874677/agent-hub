import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { marketApi } from '../api.ts';
import { at } from '../admin/shared.tsx';

export function useNotifications() {
  return useQuery({ queryKey: ['notifications'], queryFn: marketApi.notifications, refetchInterval: 60_000 });
}

/** 仅在用户打开站内通知时标读；加载慢时也要处理随后到达的未读。 */
export function NotificationList({ onNavigate }: { onNavigate?: () => void }) {
  const client = useQueryClient();
  const notes = useNotifications();
  const read = useMutation({ mutationFn: () => marketApi.markRead(null), onSuccess: () => client.invalidateQueries({ queryKey: ['notifications'] }) });
  const { mutate, isPending, isError } = read;
  const started = useRef(false);
  useEffect(() => {
    if ((notes.data?.unread ?? 0) > 0 && !started.current) {
      started.current = true;
      mutate();
    }
  }, [notes.data?.unread, isPending, isError, mutate]);
  return <div>
    {notes.isPending ? <p className="px-2 py-3 text-tertiary">正在加载通知…</p> : notes.isError ? <p role="alert" className="px-2 py-3 text-rust">通知加载失败，请稍后重试</p> : null}
    {(notes.data?.items ?? []).map((n) => <a key={n.id} href={n.link} data-testid="notification" className="block rounded-sm px-2 py-2 hover:bg-card" onClick={onNavigate}>
      <p className={n.readAt ? 'text-secondary' : 'text-primary'}>{n.title}</p>
      <p className="text-tertiary">{n.body}</p><p className="text-[11px] text-tertiary">{at(n.at)}</p>
    </a>)}
    {notes.data && !notes.data.items.length ? <p className="px-2 py-3 text-tertiary">没有通知</p> : null}
    {isError ? <p role="alert" className="px-2 text-rust">未能标记已读</p> : null}
  </div>;
}
