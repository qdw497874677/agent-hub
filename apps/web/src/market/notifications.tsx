import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { marketApi } from '../api.ts';
import { at } from '../admin/shared.tsx';

/** 站内通知铃铛：审核请求 / 结果、评论、下架、安装申请。每分钟拉一次，打开即标已读。 */
export function NotificationBell() {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const notes = useQuery({ queryKey: ['notifications'], queryFn: marketApi.notifications, refetchInterval: 60_000 });
  const read = useMutation({ mutationFn: () => marketApi.markRead(null), onSuccess: () => client.invalidateQueries({ queryKey: ['notifications'] }) });
  const unread = notes.data?.unread ?? 0;
  return (
    <div className="relative">
      <button
        aria-label={unread ? `通知（${unread} 条未读）` : '通知'}
        aria-expanded={open}
        data-testid="notification-bell"
        className="relative flex h-7 w-7 items-center justify-center rounded-full border border-hair text-meta text-secondary hover:border-accent hover:text-accent"
        onClick={() => {
          setOpen(!open);
          if (!open && unread) read.mutate();
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        {unread ? (
          <span data-testid="notification-unread" className="absolute -right-1 -top-1 rounded-full bg-rust px-1 text-[10px] leading-[14px] text-canvas">
            {unread}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="absolute right-0 top-9 z-40 max-h-[60vh] w-[min(320px,calc(100vw-24px))] overflow-y-auto rounded-md border border-strong bg-panel p-1 text-meta">
          {(notes.data?.items ?? []).map((n) => (
            <a key={n.id} href={n.link} data-testid="notification" className="block rounded-sm px-2 py-1.5 hover:bg-card" onClick={() => setOpen(false)}>
              <p className={n.readAt ? 'text-secondary' : 'text-primary'}>{n.title}</p>
              <p className="text-tertiary">{n.body}</p>
              <p className="text-[11px] text-tertiary">{at(n.at)}</p>
            </a>
          ))}
          {!notes.data?.items.length ? <p className="px-2 py-3 text-tertiary">没有通知</p> : null}
        </div>
      ) : null}
    </div>
  );
}
