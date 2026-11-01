import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { groupApi } from './api.ts';
import { formatRoute } from './route.ts';

/** 未读走轮询（群消息本身也是轮询拉的）；切回页面时立即刷新一次。 */
export const UNREAD_KEY = ['groups-unread'] as const;
const UNREAD_POLL_MS = 10_000;

export function useGroupUnread() {
  return useQuery({ queryKey: UNREAD_KEY, queryFn: groupApi.unread, refetchInterval: UNREAD_POLL_MS, refetchOnWindowFocus: true });
}

/**
 * 顶栏常驻的「消息」入口（#/messages），有未读时右上角红点 + 条数。
 * 账号菜单里的「消息」保留。
 */
export function MessagesEntry() {
  const unread = useGroupUnread();
  const total = unread.data?.total ?? 0;
  return (
    <a
      href={formatRoute({ page: 'messages', projectId: null, groupId: null })}
      aria-label={total ? `消息（${total} 条未读）` : '消息'}
      title="消息"
      data-testid="messages-entry"
      className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-hair text-meta text-secondary hover:border-accent hover:text-accent"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      {total ? (
        <span data-testid="messages-unread" className="absolute -right-1 -top-1 min-w-[14px] rounded-full bg-rust px-1 text-center text-[10px] leading-[14px] text-canvas">
          {total > 99 ? '99+' : total}
        </span>
      ) : null}
    </a>
  );
}

/** 正在看的群：看到的最新一条标为已读（页面在前台时），并刷新红点。 */
export function useMarkGroupRead(groupId: string, latestSeq: number | null) {
  const client = useQueryClient();
  const read = useMutation({
    mutationFn: (seq: number) => groupApi.markRead(groupId, seq),
    onSuccess: () => void client.invalidateQueries({ queryKey: UNREAD_KEY })
  });
  const { mutate } = read;
  useEffect(() => {
    if (latestSeq === null || latestSeq <= 0) return;
    const mark = () => {
      if (document.visibilityState === 'visible') mutate(latestSeq);
    };
    mark();
    document.addEventListener('visibilitychange', mark);
    return () => document.removeEventListener('visibilitychange', mark);
  }, [groupId, latestSeq, mutate]);
}
