import { useQuery } from '@tanstack/react-query';
import { providersApi, type RuntimeOptionDto } from '../shell/api.ts';
import { resolveWorker, useWorkers } from '../shell/workers.tsx';
import { hubSwitchNote, mergeHubModelChoices } from './hub-model-choices.ts';

export interface SessionOptionsView {
  /** 补上了 hub 提供商的模型清单（可能和原来一样）。 */
  readonly options: readonly RuntimeOptionDto[];
  /** 两类模型并存时的那句提醒；否则 undefined。 */
  readonly note: string | undefined;
}

/**
 * 会话里的可调项清单：`session.optionSpec` 只有 agent 自己上报的原生模型，
 * 这里补上 hub 提供商给的 `hub-<slug>/<model>`——和派生对话框（`withHubModels`）做同一件事。
 *
 * 协议按「这台机器上这个 agent 认哪些」过滤；老 Worker 不报 `providers` 时当作不知道，
 * 不过滤（宁可多列，也别把人想要的模型藏掉）。
 *
 * 只负责算清单和提醒，渲染留给宿主：底栏和卡片对那一行小字的位置要求不同。
 */
export function useSessionOptions(
  options: readonly RuntimeOptionDto[],
  projectId: string,
  workerId: string | null | undefined,
  agentId: string
): SessionOptionsView {
  const workers = useWorkers();
  const agent = resolveWorker(workers.list, workerId)?.agentModels?.find((entry) => entry.agentId === agentId);
  const protocols = agent === undefined ? null : (agent.providers ?? null);
  const hub = useQuery({
    queryKey: ['hub-models', 'project', projectId],
    queryFn: () => providersApi.modelsExplained({ projectId }),
    enabled: projectId !== '',
    retry: false,
    // 提供商配置不常改：切会话、切视图别每次都重查。
    staleTime: 30_000
  });
  const merged = mergeHubModelChoices(options, hub.data?.providers ?? [], protocols);
  return { options: merged, note: hubSwitchNote(merged) };
}

/**
 * 「换提供商会重启这条会话的进程」那一行小字。
 *
 * 窄得很时也读得清：整行可以换行（CJK 逐字断行），不设 nowrap，也不挤占模型控件的位置。
 */
export function HubSwitchNote({ note, testId = 'hub-switch-note' }: { note: string | undefined; testId?: string }) {
  if (note === undefined) return null;
  return (
    <p data-testid={testId} className="text-meta leading-snug text-tertiary">
      {note}
    </p>
  );
}
