import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { agentDefaultsApi, RequestFailed } from './api.ts';
import { teamKeys } from './query-keys.ts';
import { useWorkers } from './workers.tsx';
import {
  AGENT_DEFAULTS_MAX,
  defaultRows,
  defaultsFromRows,
  knownRuntimes,
  remainingRuntimes,
  runtimeLabel,
  sameDefaults,
  type DefaultRow
} from './agent-defaults.ts';

/** 行里的输入框：和团队对话框其它小控件同一套边框/圆角，别在 390px 上撑出横向滚动。 */
const FIELD =
  'min-w-0 flex-1 rounded-sm border border-hair bg-card px-2 py-1.5 text-meta text-primary outline-none placeholder:text-tertiary focus:border-ring disabled:opacity-60';
const ADD_SELECT =
  'max-w-full shrink-0 rounded-sm border border-hair bg-card px-1.5 py-1.5 text-meta text-secondary hover:text-primary disabled:opacity-40';
const SAVE_BUTTON =
  'shrink-0 rounded-sm bg-action px-2.5 py-1.5 text-meta text-action-fg hover:bg-action/90 disabled:opacity-40';
const REMOVE_BUTTON =
  'shrink-0 rounded-sm border border-hair px-2 py-1.5 text-meta text-secondary hover:border-rust hover:text-rust disabled:opacity-40';

function errorText(error: unknown): string {
  if (error instanceof RequestFailed) return error.detail.message;
  return error instanceof Error && error.message !== '' ? error.message : '保存失败，再试一次。';
}

/**
 * 团队设置里的「默认模型」：每个运行时一行，写模型名。
 *
 * 只影响新会话（服务端在调用方没点名模型时按运行时取），已有会话不动。
 * 有写权限的人一次 PUT 整份对象；没有权限（成员 / 只读）就整块只读。
 *
 * 候选模型来自各台机器上报的 agentModels 并集（离线机器也算），但输入框不设限——
 * hub 提供商的模型可能没上报过，得让人手填。
 */
export function AgentDefaultsSection({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient();
  const defaults = useQuery({ queryKey: teamKeys.agentDefaults, queryFn: agentDefaultsApi.get });
  const workers = useWorkers();
  const known = useMemo(() => knownRuntimes(workers.list), [workers.list]);
  const saved = useMemo(() => defaults.data?.defaults ?? {}, [defaults.data]);
  // 编辑中的行。null = 跟着服务端走；一旦改过就固定在本地，保存成功再交还。
  const [draft, setDraft] = useState<DefaultRow[] | null>(null);
  const rows = useMemo(() => draft ?? defaultRows(saved, known), [draft, saved, known]);
  const canAdd = canManage && rows.length < AGENT_DEFAULTS_MAX;
  const remaining = canAdd ? remainingRuntimes(known, rows) : [];
  const dirty = !sameDefaults(defaultsFromRows(rows), saved);

  const save = useMutation({
    mutationFn: () => agentDefaultsApi.set(defaultsFromRows(rows)),
    onSuccess: async (result) => {
      queryClient.setQueryData(teamKeys.agentDefaults, result);
      setDraft(null);
      await queryClient.invalidateQueries({ queryKey: teamKeys.agentDefaults });
      await queryClient.invalidateQueries({ queryKey: teamKeys.all });
    }
  });

  const update = (runtime: string, model: string) =>
    setDraft(rows.map((row) => (row.runtime === runtime ? { ...row, model } : row)));
  const remove = (runtime: string) => setDraft(rows.filter((row) => row.runtime !== runtime));
  const add = (runtime: string) => {
    if (runtime === '' || rows.some((row) => row.runtime === runtime)) return;
    setDraft([...rows, { runtime, model: '' }]);
  };

  const empty = known.length === 0 && Object.keys(saved).length === 0;
  const failure = save.error ?? defaults.error;

  return (
    <section data-testid="agent-defaults" className="mt-4 border-t border-hair pt-3">
      <p className="text-meta text-secondary">默认模型</p>
      <p className="mt-1 text-[11px] leading-relaxed text-tertiary">
        新会话没选模型时，按运行时用这里的默认；已有会话不受影响。
      </p>

      {defaults.isPending ? (
        <p className="mt-2 text-[11px] text-tertiary">加载中…</p>
      ) : empty ? (
        <p data-testid="agent-defaults-empty" className="mt-2 text-[11px] leading-relaxed text-tertiary">
          这台 hub 还没上报运行时；先在机器上装一个，再回来配默认模型。
        </p>
      ) : (
        <>
          <ul className="mt-2 flex flex-col gap-1.5">
            {rows.map((row) => (
              <li key={row.runtime} data-testid="agent-defaults-row" data-runtime={row.runtime} className="flex items-center gap-2">
                <span className="w-20 shrink-0 truncate text-meta text-secondary" title={row.runtime}>
                  {runtimeLabel(row.runtime)}
                </span>
                <input
                  data-testid="agent-defaults-input"
                  aria-label={`${runtimeLabel(row.runtime)} 的默认模型`}
                  className={FIELD}
                  list={`agent-defaults-models-${row.runtime}`}
                  maxLength={200}
                  placeholder="模型名，留空表示不设默认"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={!canManage}
                  value={row.model}
                  onChange={(event) => update(row.runtime, event.target.value)}
                />
                <datalist id={`agent-defaults-models-${row.runtime}`}>
                  {(known.find((item) => item.runtimeId === row.runtime)?.models ?? []).map((model) => (
                    <option key={model} value={model} />
                  ))}
                </datalist>
                {canManage && (
                  <button
                    type="button"
                    data-testid="agent-defaults-remove"
                    aria-label={`不设 ${runtimeLabel(row.runtime)} 的默认模型`}
                    className={REMOVE_BUTTON}
                    disabled={save.isPending}
                    onClick={() => remove(row.runtime)}
                  >
                    删除
                  </button>
                )}
              </li>
            ))}
          </ul>

          {canManage && rows.length >= AGENT_DEFAULTS_MAX && (
            <p className="mt-2 text-[11px] text-tertiary">最多 {AGENT_DEFAULTS_MAX} 个运行时。</p>
          )}

          {canManage ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {canAdd && remaining.length > 0 && (
                <select
                  data-testid="agent-defaults-add"
                  aria-label="添加运行时"
                  className={ADD_SELECT}
                  value=""
                  disabled={save.isPending}
                  onChange={(event) => add(event.target.value)}
                >
                  <option value="">添加运行时…</option>
                  {remaining.map((runtime) => (
                    <option key={runtime.runtimeId} value={runtime.runtimeId}>
                      {runtimeLabel(runtime.runtimeId)}
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                data-testid="agent-defaults-save"
                className={SAVE_BUTTON}
                disabled={!dirty || save.isPending}
                onClick={() => save.mutate()}
              >
                {save.isPending ? '保存中…' : '保存默认模型'}
              </button>
              <p data-testid="agent-defaults-note" role="status" className="min-w-0 flex-1 text-[11px] text-tertiary">
                {save.isPending ? '' : dirty ? '还没保存' : save.isSuccess ? '已保存' : ''}
              </p>
            </div>
          ) : (
            <p data-testid="agent-defaults-readonly" className="mt-2 text-[11px] text-tertiary">
              只有团队 owner / admin 能改。
            </p>
          )}
        </>
      )}

      {failure !== null && (
        <p data-testid="agent-defaults-error" role="alert" className="mt-2 text-[11px] text-rust">
          {errorText(failure)}
        </p>
      )}
    </section>
  );
}
