import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { assetSetsApi, assetsApi } from '../api.ts';
import type { AssetSetDto, AssetSetInputDto } from '../api.ts';
import { DialogShell, INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../dialog-shell.tsx';
import { DANGER, Empty, Panel, SMALL, Section, at, errorText } from './shared.tsx';
import {
  ASSET_SET_DESCRIPTION_MAX,
  ASSET_SET_ITEMS_MAX,
  ASSET_SET_NAME_MAX,
  itemCountText,
  setDescriptionProblem,
  setNameProblem
} from '../../atoms/asset-sets.ts';

const KIND_TEXT: Record<string, string> = { skill: '技能', instruction: '指令', mcp: 'MCP' };

/**
 * 资产中心 · 资产组合（asset-hub.md「资产组合」）：把常用的技能 / 指令 / MCP 打包成一组。
 * 组合本身只是「选好的资产清单」；项目里按顺序引用（后叠前），派生会话时可以整组带或不带。
 */
export function AssetSets() {
  const sets = useQuery({ queryKey: ['asset-sets'], queryFn: assetSetsApi.list });
  const [editing, setEditing] = useState<AssetSetDto | 'new' | null>(null);
  const list = sets.data ?? [];
  return (
    <>
      <Section
        title="资产组合"
        aside={
          <button data-testid="asset-set-new" className={PRIMARY_BUTTON} onClick={() => setEditing('new')}>
            新建组合
          </button>
        }
      >
        <p className="mb-3 text-meta text-tertiary">
          把常用的技能 / 指令 / MCP 打包成一组，在项目设置里按顺序引用；新会话默认带上，派生时也可以整组取消。
        </p>
        <Panel>
          {sets.isLoading ? (
            <Empty text="载入中…" />
          ) : list.length ? (
            <ul data-testid="asset-sets">
              {list.map((set) => (
                <li
                  key={set.id}
                  data-testid="asset-set"
                  data-set-id={set.id}
                  data-name={set.name}
                  className="flex flex-wrap items-start gap-2 border-b border-hair px-3 py-2.5 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-body text-primary">{set.name}</p>
                    <p className="break-words text-meta text-tertiary">
                      {itemCountText(set.items.length)} · 更新于 {at(set.updatedAt)}
                    </p>
                    {set.description ? (
                      <p className="mt-0.5 line-clamp-2 break-words text-meta text-secondary">{set.description}</p>
                    ) : null}
                  </div>
                  <button className={SMALL} onClick={() => setEditing(set)}>
                    编辑
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <Empty text="还没有资产组合。把常用的技能/指令打包，项目里一键引用" />
          )}
        </Panel>
        {sets.error ? (
          <p role="alert" className="mt-2 text-meta text-rust">
            {errorText(sets.error)}
          </p>
        ) : null}
      </Section>
      {editing ? <AssetSetDialog set={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </>
  );
}

/** 新建 / 编辑：名称、说明、资产多选（按名称搜索，选中的显示成可移除的 chip）。 */
function AssetSetDialog({ set, onClose }: { set: AssetSetDto | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  // 资产列表和资产页共用同一份缓存：改完资产再打开组合不用重新拉
  const overview = useQuery({ queryKey: ['admin', 'assets'], queryFn: assetsApi.overview });
  const assets = overview.data?.assets ?? [];
  const assetsLoading = overview.isLoading;
  const [name, setName] = useState(set?.name ?? '');
  const [description, setDescription] = useState(set?.description ?? '');
  // 名字空着只是「还没开始填」，不该一打开就报红；改过一次才提示
  const [nameTouched, setNameTouched] = useState(false);
  const [picked, setPicked] = useState<string[]>(() => (set ? [...set.assetIds] : []));
  const [query, setQuery] = useState('');
  const byId = new Map(assets.map((asset) => [asset.id, asset]));

  const save = useMutation({
    mutationFn: (input: AssetSetInputDto) =>
      set === null ? assetSetsApi.create(input) : assetSetsApi.update(set.id, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['asset-sets'] });
      onClose();
    }
  });
  const remove = useMutation({
    mutationFn: (id: string) => assetSetsApi.remove(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['asset-sets'] });
      onClose();
    }
  });

  const nameProblem = setNameProblem(name);
  const descriptionProblem = setDescriptionProblem(description);
  const shownProblem = nameTouched ? nameProblem : null;
  const full = picked.length >= ASSET_SET_ITEMS_MAX;
  const problem = nameProblem ?? descriptionProblem;
  const shown = shownProblem ?? descriptionProblem;
  const error = save.error ?? remove.error;

  const toggle = (assetId: string, on: boolean) =>
    setPicked((current) => (on ? [...current, assetId] : current.filter((id) => id !== assetId)));

  // 按名称（以及种类）搜索；已经选上的从候选里拿掉，别在下面重复出现一遍
  const needle = query.trim().toLowerCase();
  const candidates = assets.filter(
    (asset) =>
      !picked.includes(asset.id) &&
      (needle === '' ||
        asset.name.toLowerCase().includes(needle) ||
        (KIND_TEXT[asset.kind] ?? '').toLowerCase().includes(needle))
  );

  return (
    <DialogShell title={set === null ? '新建资产组合' : `编辑「${set.name}」`} onClose={onClose} testId="asset-set-dialog">
      <h2 className="mb-3 break-words text-head text-primary">{set === null ? '新建资产组合' : `编辑「${set.name}」`}</h2>
      <label className="mb-1 block text-meta text-secondary" htmlFor="asset-set-name">
        名称
      </label>
      <input
        id="asset-set-name"
        data-testid="asset-set-name"
        autoFocus
        maxLength={ASSET_SET_NAME_MAX}
        className={`mb-3 ${INPUT}`}
        placeholder="比如：前端日常"
        value={name}
        onChange={(event) => {
          setNameTouched(true);
          setName(event.target.value);
        }}
      />
      <label className="mb-1 block text-meta text-secondary" htmlFor="asset-set-description">
        说明（可留空）
      </label>
      <textarea
        id="asset-set-description"
        data-testid="asset-set-description"
        maxLength={ASSET_SET_DESCRIPTION_MAX}
        className={`mb-3 min-h-[64px] resize-y ${INPUT}`}
        placeholder="这一组是干嘛用的，什么时候带上"
        value={description}
        onChange={(event) => setDescription(event.target.value)}
      />

      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-meta text-secondary">资产</span>
        <span className={`text-meta ${full ? 'text-rust' : 'text-tertiary'}`}>
          {picked.length} / {ASSET_SET_ITEMS_MAX} 项
        </span>
      </div>
      {picked.length ? (
        <ul className="mb-2 flex flex-wrap gap-1.5">
          {picked.map((assetId) => {
            const asset = byId.get(assetId);
            return (
              <li
                key={assetId}
                data-testid="asset-set-chip"
                data-asset-id={assetId}
                className="flex max-w-full items-center gap-1.5 rounded-full border border-accent bg-accent/10 px-2.5 py-1 text-meta text-primary"
              >
                <span className="min-w-0 break-words">{asset?.name ?? assetId}</span>
                <button
                  type="button"
                  data-testid="asset-set-remove"
                  aria-label={`从组合里移除 ${asset?.name ?? assetId}`}
                  className="shrink-0 text-tertiary hover:text-rust"
                  onClick={() => toggle(assetId, false)}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      <div data-testid="asset-set-picker" className="rounded-sm border border-hair bg-card">
        <div className="border-b border-hair px-2.5 py-1.5">
          <input
            className="w-full bg-transparent text-sub text-primary outline-none placeholder:text-tertiary"
            placeholder="按名称搜索资产"
            aria-label="按名称搜索资产"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {assetsLoading ? (
          <p className="px-2.5 py-2 text-meta text-tertiary">载入资产…</p>
        ) : assets.length === 0 ? (
          <p className="px-2.5 py-2 text-meta text-tertiary">还没有资产，先在上面「资产」里添加。</p>
        ) : candidates.length === 0 ? (
          <p className="px-2.5 py-2 text-meta text-tertiary">
            {needle === '' ? '都选上了' : `没有名字带「${query.trim()}」的资产`}
          </p>
        ) : (
          <ul className="max-h-[180px] overflow-auto" role="group" aria-label="可以加进组合的资产">
            {candidates.map((asset) => (
              <li key={asset.id} className="border-b border-hair last:border-b-0">
                <button
                  type="button"
                  data-testid="asset-set-item"
                  data-asset-id={asset.id}
                  disabled={full}
                  className="flex w-full items-start gap-2 px-2.5 py-1.5 text-left hover:bg-card-raised disabled:opacity-40"
                  onClick={() => toggle(asset.id, true)}
                >
                  <span className="mt-0.5 rounded border border-strong px-1 text-meta text-secondary">
                    {KIND_TEXT[asset.kind] ?? '资产'}
                  </span>
                  <span className="min-w-0 flex-1 break-words text-sub text-primary">{asset.name}</span>
                  <span className="shrink-0 text-meta text-accent">加入</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {shown !== null ? (
        <p className="mt-2 text-meta text-rust" data-testid="asset-set-error">
          {shown}
        </p>
      ) : error ? (
        <p role="alert" className="mt-2 text-meta text-rust" data-testid="asset-set-error">
          {errorText(error)}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {set === null ? null : (
          <button
            type="button"
            data-testid="asset-set-delete"
            className={`${DANGER} mr-auto`}
            disabled={remove.isPending || save.isPending}
            onClick={() => {
              if (window.confirm(`删除组合「${set.name}」？还有项目在用它时会被拦下，要先解绑。`)) remove.mutate(set.id);
            }}
          >
            {remove.isPending ? '删除中…' : '删除组合'}
          </button>
        )}
        <button type="button" className={SECONDARY_BUTTON} onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          data-testid="asset-set-save"
          className={PRIMARY_BUTTON}
          disabled={problem !== null || save.isPending || remove.isPending}
          onClick={() =>
            save.mutate({
              name: name.trim(),
              description: description.trim() === '' ? null : description.trim(),
              items: picked.map((assetId) => ({ assetId }))
            })
          }
        >
          {save.isPending ? '保存中…' : '保存'}
        </button>
      </div>
    </DialogShell>
  );
}
