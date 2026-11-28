import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { groupApi } from '../shell/api.ts';

/** 未读走轮询（群消息本身也是轮询拉的）；切回页面时立即刷新一次。 */
export const UNREAD_KEY = ['groups-unread'] as const;
const UNREAD_POLL_MS = 10_000;

export function useGroupUnread() {
  return useQuery({ queryKey: UNREAD_KEY, queryFn: groupApi.unread, refetchInterval: UNREAD_POLL_MS, refetchOnWindowFocus: true });
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
