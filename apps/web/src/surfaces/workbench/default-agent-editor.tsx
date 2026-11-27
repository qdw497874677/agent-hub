import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SaveStatus } from '../../atoms/save-status.tsx';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../shell/dialog-shell.tsx';
import { providersApi, RequestFailed } from '../../shell/api.ts';
import { useWorkers } from '../../shell/workers.tsx';
import { runtimeLabel } from '../../shell/agent-defaults.ts';
import {
  agentDraft,
  draftAgent,
  hasDefaultAgent,
  modelChoices,
  optionChoices,
  runtimeChoices,
  sameDraft,
  thinkingOption,
  type AgentDraft,
  type DefaultAgentCatalogEntry,
  type DefaultAgentRef,
  type RuntimeOptionLike
} from '../../shell/default-agent.ts';

/**
 * 「默认 Agent」的三件套：运行时 / 模型 / 思考强度。
 *
 * 项目设置和任务详情共用这一块（testid 前缀分别是 `pda-` 与 `tda-`），
 * 只是外面那句话和保存去向不同。运行时候选来自各台机器的 agentIds（离线也列，标一下）；
 * 模型候选来自在线机器上报的 agentModels + hub 提供商，取不到就纯手填；思考强度只列
 * 这个运行时真的有的那一项，没有就整行不显示。
 */
function errorText(error: unknown): string {
  if (error === null || error === undefined) return '';
  if (error instanceof RequestFailed) return error.detail.message;
  return error instanceof Error && error.message !== '' ? error.message : '保存失败，再试一次。';
}

export function DefaultAgentEditor({
  prefix,
  projectId,
  modelFallback,
  value,
  agents,
  editable,
  saving,
  saved,
  error,
  onSave
}: {
  readonly prefix: string;
  readonly projectId: string;
  readonly modelFallback: string;
  readonly value: DefaultAgentRef | null | undefined;
  readonly agents: readonly DefaultAgentCatalogEntry[];
  readonly editable: boolean;
  readonly saving: boolean;
  readonly saved: boolean;
  /** 保存失败的原始错误，这里统一翻成人话。 */
  readonly error: unknown;
  readonly onSave: (agent: DefaultAgentRef | null) => void;
}) {
  const workers = useWorkers();
  // 和会话里的模型选择共用同一份缓存，打开这个面板通常不会多发请求。
  const hub = useQuery({
    queryKey: ['hub-models', 'project', projectId],
    queryFn: () => providersApi.modelsExplained({ projectId }),
    enabled: projectId !== '',
    retry: false,
    staleTime: 30_000
  });

  const optionsFor = (runtime: string): readonly RuntimeOptionLike[] =>
    agents.find((agent) => agent.id === runtime)?.options ?? [];
  const storedDraft = (stored: DefaultAgentRef | null | undefined): AgentDraft =>
    agentDraft(stored, thinkingOption(optionsFor(stored?.runtime ?? ''))?.id ?? null);

  // 服务端值是唯一的真源：项目设置里别处保存、画布刷新都会把它带回来。
  const storedKey = JSON.stringify(value ?? null);
  const [draft, setDraft] = useState<AgentDraft>(() => storedDraft(value));
  useEffect(() => {
    setDraft(storedDraft(value));
    // 只在服务端值变化时重置；agents 后到时画布也一起到了，跟着走一遍即可。
  }, [storedKey]);

  const runtimes = useMemo(
    () => runtimeChoices(workers.list, draft.runtime === '' ? [] : [draft.runtime]),
    [workers.list, draft.runtime]
  );
  const models = useMemo(
    () => modelChoices(workers.list, draft.runtime, agents, hub.data?.providers ?? []),
    [workers.list, draft.runtime, agents, hub.data]
  );
  const thinking = useMemo(() => thinkingOption(optionsFor(draft.runtime)), [agents, draft.runtime]);
  const efforts = useMemo(() => optionChoices(thinking), [thinking]);
  const dirty = !sameDraft(draft, storedDraft(value));

  const changeRuntime = (runtime: string): void => {
    if (runtime === draft.runtime) return;
    // 换了运行时，模型与思考档位都是旧运行时的词，清掉重选，别带着假值保存。
    const next = thinkingOption(optionsFor(runtime));
    setDraft({ runtime, model: '', effort: '', effortKey: next?.id ?? '' });
  };

  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid min-w-0 gap-1 text-meta text-tertiary">
          <span>运行时</span>
          <select
            className={INPUT}
            data-testid={`${prefix}-runtime`}
            disabled={!editable || saving}
            value={draft.runtime}
            onChange={(event) => changeRuntime(event.target.value)}
          >
            <option value="">未设置</option>
            {runtimes.map((choice) => (
              <option key={choice.runtimeId} value={choice.runtimeId}>
                {runtimeLabel(choice.runtimeId)}
                {choice.offline ? '（离线）' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="grid min-w-0 gap-1 text-meta text-tertiary">
          <span>模型</span>
          <input
            className={INPUT}
            data-testid={`${prefix}-model`}
            list={`${prefix}-models`}
            disabled={!editable || saving}
            placeholder="留空则使用默认模型"
            value={draft.model}
            onChange={(event) => setDraft({ ...draft, model: event.target.value })}
          />
          <datalist id={`${prefix}-models`}>
            {models.map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>
          <span className="text-[11px] text-tertiary">{modelFallback}</span>
        </label>
        {thinking === null ? null : (
          <label className="grid min-w-0 gap-1 text-meta text-tertiary sm:col-span-2">
            <span>思考强度</span>
            <select
              className={INPUT}
              data-testid={`${prefix}-effort`}
              disabled={!editable || saving}
              value={draft.effort}
              onChange={(event) =>
                setDraft({ ...draft, effort: event.target.value, effortKey: thinking.id })
              }
            >
              <option value="">不指定</option>
              {efforts.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
              {draft.effort !== '' && !efforts.some((choice) => choice.value === draft.effort) ? (
                <option value={draft.effort}>{draft.effort}</option>
              ) : null}
            </select>
          </label>
        )}
      </div>
      {editable ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={PRIMARY_BUTTON}
            data-testid={`${prefix}-save`}
            disabled={saving || !dirty || draft.runtime.trim() === ''}
            onClick={() => onSave(draftAgent(value, draft))}
          >
            保存
          </button>
          <button
            type="button"
            className={SECONDARY_BUTTON}
            data-testid={`${prefix}-clear`}
            disabled={saving || !hasDefaultAgent(value)}
            onClick={() => onSave(null)}
          >
            清掉默认
          </button>
          <SaveStatus dirty={dirty} saved={saved} testId={`${prefix}-saved`} />
        </div>
      ) : (
        <p className="mt-2 text-meta text-tertiary">只有项目管理员能改这一块，现在只能看。</p>
      )}
      {error === null || error === undefined ? null : (
        <p role="alert" data-testid={`${prefix}-error`} className="mt-2 text-meta text-rust">
          {errorText(error)}
        </p>
      )}
    </div>
  );
}
