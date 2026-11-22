import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { delegationsApi, type DelegationDto, type DelegationPublishDto } from './api.ts';
import { delegationKeys } from './query-keys.ts';

/**
 * 一条主会话的派工记录。
 *
 * 只读、按需：面板打开时问一次，30 秒内不重复问。服务端是唯一事实来源
 * （状态、能不能确认、发布到哪一步），界面不自己推状态。
 */
export function useDelegations(coordinatorSessionId: string | null | undefined): {
  readonly rows: readonly DelegationDto[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly reload: () => void;
} {
  const enabled = typeof coordinatorSessionId === 'string' && coordinatorSessionId !== '';
  const query = useQuery({
    queryKey: delegationKeys.forCoordinator(coordinatorSessionId ?? ''),
    queryFn: () => delegationsApi.list(coordinatorSessionId ?? ''),
    enabled,
    staleTime: 30_000,
    retry: false
  });
  const rows = useMemo(() => query.data ?? [], [query.data]);
  const error = query.error instanceof Error ? query.error.message : null;
  return {
    rows,
    loading: enabled && query.isPending,
    error,
    reload: () => {
      void query.refetch();
    }
  };
}

/** 发布面板：开对话框时才查，`reload` 给人一个手动刷新的按钮（不做后台轮询）。 */
export function useDelegationPublish(delegationId: string | null): {
  readonly view: DelegationPublishDto | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly reload: () => void;
} {
  const enabled = delegationId !== null && delegationId !== '';
  const query = useQuery({
    queryKey: delegationKeys.publish(delegationId ?? ''),
    queryFn: () => delegationsApi.publishState(delegationId ?? ''),
    enabled,
    staleTime: 0,
    retry: false
  });
  return {
    view: query.data ?? null,
    loading: enabled && query.isPending,
    error: query.error instanceof Error ? query.error.message : null,
    reload: () => {
      void query.refetch();
    }
  };
}
