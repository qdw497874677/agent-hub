import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectDto } from '../../shell/api.ts';
import { api, assetSetsApi } from '../../shell/api.ts';
import { useAccount } from '../../shell/auth.tsx';
import { canAdminister } from '../../shell/account-context.ts';
import { SECONDARY_BUTTON } from '../../shell/dialog-shell.tsx';
import { MAX_ASSET_SETS, itemCountText, moveSetId, orderedSetIds, setLimitProblem, toggleSetId } from '../../atoms/asset-sets.ts';

/**
 * 项目设置 · 代码与工作目录 · 「默认资产组合」。
 *
 * 项目可以按顺序叠几组资产组合（后选的盖住先选的同名资产），新会话默认全带上；
 * 派生会话时还能临时整组取消。所以这里只关心「哪几组、什么顺序」，具体资产在派生对话框里看。
 */
export function ProjectAssetSets({ project }: { project: ProjectDto }) {
  const account = useAccount();
  const editable = canAdminister(account);
  const queryClient = useQueryClient();
  const sets = useQuery({ queryKey: ['asset-sets'], queryFn: assetSetsApi.list, retry: false });

  const stored = JSON.stringify(orderedSetIds(project.assetSetIds ?? []));
  const [draft, setDraft] = useState<string[]>(() => orderedSetIds(project.assetSetIds ?? []));
  // 别人改了项目、画布刷新后把草稿拉回已保存的样子；自己正在勾的不被轮询冲掉。
  useEffect(() => {
    setDraft(orderedSetIds(project.assetSetIds ?? []));
  }, [stored]);

  const save = useMutation({
    mutationFn: (ids: string[]) => api.saveProjectAssetSets(project.id, ids),
    onSuccess: (next) => {
      queryClient.setQueryData(['canvas', next.id], (old: unknown) =>
        old !== null && typeof old === 'object' && 'project' in old ? { ...(old as object), project: next } : old
      );
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      // 派生对话框读的是项目资产计划，组合变了要重算
      void queryClient.invalidateQueries({ queryKey: ['project-assets', project.id] });
    }
  });

  const list = sets.data ?? [];
  const known = new Set(list.map((set) => set.id));
  // 组合被删了但项目里还留着 id：照样显示，让人能把它去掉
  const missing = draft.filter((id) => !known.has(id));
  const problem = setLimitProblem(draft);
  const dirty = JSON.stringify(draft) === stored ? false : true;

  const rows = [
    ...draft.map((id, index) => ({ id, order: index + 1 })),
    ...list.filter((set) => !draft.includes(set.id)).map((set) => ({ id: set.id, order: 0 }))
  ];
  const byId = new Map(list.map((set) => [set.id, set]));

  const update = (next: string[]) => {
    if (save.isError || save.isSuccess) save.reset();
    setDraft(next);
  };

  return (
    <section className="mt-5 border-t border-hair pt-4" data-testid="project-asset-sets">
      <h3 className="mb-1 flex flex-wrap items-baseline gap-x-2 text-sub text-primary">
        默认资产组合
        {draft.length ? <span className="text-meta text-tertiary">{draft.length} 组 · 按序号叠加</span> : null}
      </h3>
      <p className="mb-2 text-meta text-tertiary">
        新会话默认带上这些组合里的资产；后勾的盖住先勾的同名资产。最多 {MAX_ASSET_SETS} 组。
      </p>
      {sets.isLoading ? (
        <p className="text-meta text-tertiary">载入中…</p>
      ) : sets.error ? (
        <p className="text-meta text-rust">{sets.error.message}</p>
      ) : list.length === 0 && missing.length === 0 ? (
        <p className="text-meta text-tertiary" data-testid="project-asset-sets-empty">
          还没有资产组合。
        </p>
      ) : (
        <ul className="rounded-sm border border-hair bg-card">
          {rows.map(({ id, order }) => {
            const set = byId.get(id);
            const checked = order > 0;
            return (
              <li key={id} className="flex items-start gap-1 border-b border-hair px-2 py-1.5 last:border-b-0">
                <label
                  data-testid="project-asset-set"
                  data-set-id={id}
                  data-order={checked ? String(order) : undefined}
                  className="flex min-w-0 flex-1 cursor-pointer items-start gap-2"
                >
                  <input
                    type="checkbox"
                    className="mt-1 shrink-0 accent-[var(--color-fg)]"
                    checked={checked}
                    disabled={!editable}
                    onChange={(event) => update(toggleSetId(draft, id, event.target.checked))}
                  />
                  <span
                    aria-hidden
                    className={`mt-0.5 w-4 shrink-0 text-center font-mono text-meta ${
                      checked ? 'text-primary' : 'text-tertiary'
                    }`}
                  >
                    {checked ? order : '·'}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-sub text-primary">{set?.name ?? '已删除的组合'}</span>
                    <span className="block break-words text-meta text-tertiary">
                      {set ? itemCountText(set.items.length) : '这组已经不在了，取消勾选即可去掉'}
                    </span>
                  </span>
                </label>
                {checked ? (
                  <span className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      aria-label={`把「${set?.name ?? id}」往上挪一位`}
                      data-testid="project-asset-set-up"
                      className="rounded-sm border border-hair px-1.5 py-0.5 text-meta text-tertiary enabled:hover:text-primary disabled:opacity-30"
                      disabled={!editable || order === 1}
                      onClick={() => update(moveSetId(draft, id, -1))}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label={`把「${set?.name ?? id}」往下挪一位`}
                      data-testid="project-asset-set-down"
                      className="rounded-sm border border-hair px-1.5 py-0.5 text-meta text-tertiary enabled:hover:text-primary disabled:opacity-30"
                      disabled={!editable || order === draft.length}
                      onClick={() => update(moveSetId(draft, id, 1))}
                    >
                      ↓
                    </button>
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {problem !== null ? (
        <p className="mt-2 text-meta text-rust" data-testid="project-asset-sets-error">
          {problem}
        </p>
      ) : save.error ? (
        <p className="mt-2 text-meta text-rust" data-testid="project-asset-sets-error">
          {save.error.message}
        </p>
      ) : null}
      {!editable ? <p className="mt-1 text-meta text-tertiary">需要项目所有者权限。</p> : null}
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        {save.isSuccess && !dirty ? (
          <span className="mr-auto text-meta text-tertiary" data-testid="project-asset-sets-saved">
            已保存
          </span>
        ) : (
          <span className="mr-auto text-meta text-tertiary" />
        )}
        <button
          type="button"
          className={SECONDARY_BUTTON}
          data-testid="project-asset-sets-save"
          disabled={!editable || !dirty || problem !== null || save.isPending}
          onClick={() => save.mutate(draft)}
        >
          {save.isPending ? '保存中…' : '保存默认组合'}
        </button>
      </div>
    </section>
  );
}
