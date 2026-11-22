import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { coordinatorsApi, type CoordinatorDto } from './api.ts';
import { coordinatorKeys } from './query-keys.ts';

/**
 * 这个项目里登记过的主会话。
 *
 * 侧栏 / 列表 / 专注页都要问「这条无任务会话是不是主会话」，三处共用一份缓存（同一个 key），
 * 所以直接在各处调用，不用从 App 往下传。登记表还没接上时接口会 404：这时按「都不是主会话」
 * 处理，界面退回中性说法，不把人家的 bot 会话冒充成主会话。
 */
export function useCoordinators(projectId: string | null | undefined): {
  readonly rows: readonly CoordinatorDto[];
  readonly ids: ReadonlySet<string>;
} {
  const enabled = typeof projectId === 'string' && projectId !== '';
  const query = useQuery({
    queryKey: coordinatorKeys.forProject(projectId ?? ''),
    queryFn: () => coordinatorsApi.list(projectId ?? ''),
    enabled,
    staleTime: 30_000,
    retry: false
  });
  const rows = useMemo(() => query.data?.coordinators ?? [], [query.data]);
  const ids = useMemo(() => new Set(rows.map((row) => row.sessionId)), [rows]);
  return { rows, ids };
}
