import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { INPUT, SMALL_BUTTON } from './dialog-shell.tsx';
import { providersApi, type ProviderProtocolDto } from './api.ts';
import { useWorkers } from './workers.tsx';
import {
  addManualModel,
  mergePulledModels,
  removeDraft,
  setSelectedFor,
  updateDraft,
  type ModelDraft,
  type ModelDraftErrors
} from './provider-models.ts';

/** 行的 DOM id：用模型 id 本身（转义过），筛选时也不会指错行。 */
const rowDomId = (id: string): string => `model-row-${encodeURIComponent(id)}`;

function scrollRowIntoView(id: string | undefined): void {
  if (id === undefined || typeof document === 'undefined') return;
  setTimeout(() => document.getElementById(rowDomId(id))?.scrollIntoView({ block: 'nearest' }), 0);
}

/**
 * 模型列表编辑器：拉取 / 搜索 / 勾选 / 逐行编辑（名称、上下文长度、最大输出、额外参数）。
 *
 * 关键语义（与后端一致）：勾选 = 保存，未勾选 = 保存时删除；拉取只补空字段，不覆盖用户填过的东西；
 * 上游这次没给但已经存过的模型不删，只标「上游已不提供」。
 */
export function ModelEditor({
  drafts,
  onChange,
  protocol,
  baseUrl,
  apiKey,
  providerId,
  hasStoredKey,
  errors,
  showErrors
}: {
  drafts: readonly ModelDraft[];
  onChange: (next: ModelDraft[]) => void;
  protocol: ProviderProtocolDto;
  baseUrl: string;
  apiKey: string;
  /** 编辑已有提供商时传 id：拉取可以用服务器上已存的密钥。 */
  providerId: string | null;
  hasStoredKey: boolean;
  /** 勾选且填错的行的错误；未勾选的行不校验（反正不保存）。 */
  errors: ReadonlyMap<string, ModelDraftErrors>;
  /** 点过保存之后为 true：所有行的错误都摊开，相关行自动展开。 */
  showErrors: boolean;
}) {
  const workers = useWorkers();
  const online = workers.online;
  const [workerId, setWorkerId] = useState('');
  const [query, setQuery] = useState('');
  const [manualId, setManualId] = useState('');
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set());
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const [note, setNote] = useState<{ tone: 'ok' | 'error' | 'info'; text: string } | null>(null);
  // 拉取是异步的：回调里要合并「此刻」的列表，而不是发起请求那一帧的。
  const latest = useRef(drafts);
  latest.current = drafts;

  const viaText = workerId === '' ? 'hub 直连' : (workers.byId(workerId)?.label ?? '所选机器');

  const probe = useMutation({
    mutationFn: (target: string) =>
      providersApi.probe({
        protocol,
        baseUrl: baseUrl.trim(),
        ...(apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() }),
        ...(providerId === null ? {} : { providerId }),
        ...(target === '' ? {} : { workerId: target })
      }),
    onSuccess: (result) => {
      if (!result.ok) {
        setNote({ tone: 'error', text: `拉取失败${result.status > 0 ? `（HTTP ${result.status}）` : ''}：${result.message}` });
        return;
      }
      const usable = result.models.filter((model) => model.id.trim() !== '');
      onChange(mergePulledModels(latest.current, usable));
      setNote(
        usable.length === 0
          ? { tone: 'error', text: `连上了（via ${viaText}），但上游没返回模型：${result.message}` }
          : { tone: 'ok', text: `拉到 ${usable.length} 个（via ${viaText}）` }
      );
    },
    onError: (error) => setNote({ tone: 'error', text: `拉取失败：${error instanceof Error ? error.message : String(error)}` })
  });

  const runPull = () => {
    if (baseUrl.trim() === '') {
      setNote({ tone: 'error', text: '先填上面的 Base URL，再来拉模型' });
      return;
    }
    if (apiKey.trim() === '' && !hasStoredKey) {
      setNote({ tone: 'error', text: '先填 API Key（编辑已有提供商时可留空，沿用已存的密钥）' });
      return;
    }
    setNote({ tone: 'info', text: '拉取中…' });
    probe.mutate(workerId);
  };

  // 点过保存、但有行填错：把出错的行展开并滚到第一行，否则用户看不到标红在哪。
  useEffect(() => {
    if (!showErrors) return;
    const closed = [...errors.keys()].filter((id) => !openIds.has(id));
    if (closed.length === 0) return;
    setOpenIds((current) => {
      const next = new Set(current);
      for (const id of closed) next.add(id);
      return next;
    });
    scrollRowIntoView(closed[0]);
  }, [showErrors, errors, openIds]);

  const toggleOpen = (id: string) => {
    const opening = !openIds.has(id);
    setOpenIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    // 展开后把这一行拉回列表可视区，别让标题滚出那条限高的框。
    if (opening) scrollRowIntoView(id);
  };
  const touch = (id: string) => setTouched((current) => (current.has(id) ? current : new Set(current).add(id)));

  const q = query.trim().toLowerCase();
  const visible = drafts.filter((draft) => q === '' || draft.id.toLowerCase().includes(q) || draft.name.toLowerCase().includes(q));
  const selectedCount = drafts.filter((draft) => draft.selected).length;
  const visibleIds = visible.map((draft) => draft.id);

  const addManual = () => {
    if (manualId.trim() === '') return;
    onChange(addManualModel(drafts, manualId));
    setManualId('');
  };

  return (
    <div className="rounded-sm border border-hair" data-testid="provider-model-editor">
      <div className="flex flex-wrap items-center gap-2 border-b border-hair px-2.5 py-2">
        <button type="button" className={SMALL_BUTTON} disabled={probe.isPending} onClick={runPull}>
          {probe.isPending ? '拉取中…' : '拉取模型'}
        </button>
        <select
          className={`${INPUT} max-w-[16rem] py-1 text-meta`}
          aria-label="用哪台机器的网络拉取"
          value={workerId}
          onChange={(event) => setWorkerId(event.target.value)}
        >
          <option value="">自动（hub 直连）</option>
          {online.map((worker) => (
            <option key={worker.workerId} value={worker.workerId}>
              {worker.label}
            </option>
          ))}
        </select>
        {note ? (
          <p
            className={`min-w-0 break-words text-meta ${note.tone === 'error' ? 'text-rust' : note.tone === 'ok' ? 'text-secondary' : 'text-tertiary'}`}
            aria-live="polite"
            data-testid="provider-probe-note"
          >
            {note.text}
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-hair px-2.5 py-1.5">
        <input
          className={`${INPUT} min-w-[8rem] flex-1`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜模型 id / 名称"
          aria-label="搜索模型"
        />
        <button type="button" className={SMALL_BUTTON} onClick={() => onChange(setSelectedFor(drafts, visibleIds, true))}>
          全选
        </button>
        <button type="button" className={SMALL_BUTTON} onClick={() => onChange(setSelectedFor(drafts, visibleIds, false))}>
          全不选
        </button>
        <span className="shrink-0 text-meta text-tertiary">已选 {selectedCount}/{drafts.length}</span>
      </div>

      <ul className="max-h-[min(26rem,60dvh)] divide-y divide-hair overflow-y-auto overscroll-contain" data-testid="provider-model-list">
        {visible.length === 0 ? (
          <li className="px-2.5 py-3 text-meta text-tertiary">
            {drafts.length === 0 ? '还没有模型：点「拉取模型」，或在下面手动加一个 id。' : '没有匹配的模型。'}
          </li>
        ) : null}
        {visible.map((draft) => {
          const open = openIds.has(draft.id);
          const rowErrors = errors.get(draft.id);
          const showing = showErrors || touched.has(draft.id);
          const fieldId = `model-${encodeURIComponent(draft.id)}`;
          return (
            <li
              key={draft.id}
              id={rowDomId(draft.id)}
              className={`scroll-mt-2 px-2.5 py-2 ${draft.missing ? 'bg-card/40' : draft.selected ? '' : 'bg-card/60'}`}
            >
              <div className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1.5 size-4 shrink-0"
                  checked={draft.selected}
                  onChange={(event) => onChange(updateDraft(drafts, draft.id, { selected: event.target.checked }))}
                  aria-label={`保存模型 ${draft.id}`}
                />
                <div className="min-w-0 flex-1">
                  <p
                    className={`truncate font-mono text-meta ${draft.selected && !draft.missing ? 'text-primary' : 'text-tertiary'} ${
                      draft.selected ? '' : 'line-through'
                    }`}
                  >
                    {draft.id}
                  </p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-tertiary">
                    {draft.name.trim() === '' ? null : <span className="max-w-full truncate">{draft.name}</span>}
                    {draft.contextWindow.trim() === '' ? null : <span>{draft.contextWindow.trim()} 上下文</span>}
                    {draft.maxTokens.trim() === '' ? null : <span>{draft.maxTokens.trim()} 输出</span>}
                    {draft.extraText.trim() === '' ? null : <span className="text-secondary">有额外参数</span>}
                    {draft.missing ? <span className="rounded-sm border border-hair px-1">上游已不提供</span> : null}
                    {draft.selected ? null : (
                      <span className="text-rust">未勾选 · {draft.persisted ? '保存即删除' : '不会保存'}</span>
                    )}
                  </p>
                </div>
                <button type="button" className={SMALL_BUTTON} onClick={() => toggleOpen(draft.id)} aria-expanded={open}>
                  {open ? '收起' : '编辑'}
                </button>
                <button
                  type="button"
                  className={SMALL_BUTTON}
                  aria-label={`从列表删掉 ${draft.id}`}
                  title={draft.persisted ? '从列表删掉：保存时一并删除' : '从列表删掉'}
                  onClick={() => onChange(removeDraft(drafts, draft.id))}
                >
                  ×
                </button>
              </div>

              {open ? (
                <div className="mt-2 grid grid-cols-1 gap-x-3 gap-y-2 pl-6 sm:grid-cols-2">
                  <label className="block text-xs text-secondary" htmlFor={`${fieldId}-name`}>
                    名称（可选）
                    <input
                      id={`${fieldId}-name`}
                      className={`${INPUT} mt-1`}
                      value={draft.name}
                      placeholder={draft.id}
                      onChange={(event) => onChange(updateDraft(drafts, draft.id, { name: event.target.value }))}
                      onBlur={() => touch(draft.id)}
                    />
                  </label>
                  <label className="block text-xs text-secondary" htmlFor={`${fieldId}-context`}>
                    上下文长度（token，可留空）
                    <input
                      id={`${fieldId}-context`}
                      className={`${INPUT} mt-1`}
                      inputMode="numeric"
                      value={draft.contextWindow}
                      placeholder="如 128000"
                      onChange={(event) => onChange(updateDraft(drafts, draft.id, { contextWindow: event.target.value }))}
                      onBlur={() => touch(draft.id)}
                    />
                    {showing && rowErrors?.contextWindow ? (
                      <span className="mt-1 block text-xs text-rust">{rowErrors.contextWindow}</span>
                    ) : null}
                  </label>
                  <label className="block text-xs text-secondary" htmlFor={`${fieldId}-max`}>
                    最大输出（token，可留空）
                    <input
                      id={`${fieldId}-max`}
                      className={`${INPUT} mt-1`}
                      inputMode="numeric"
                      value={draft.maxTokens}
                      placeholder="如 8192"
                      onChange={(event) => onChange(updateDraft(drafts, draft.id, { maxTokens: event.target.value }))}
                      onBlur={() => touch(draft.id)}
                    />
                    {showing && rowErrors?.maxTokens ? <span className="mt-1 block text-xs text-rust">{rowErrors.maxTokens}</span> : null}
                  </label>
                  <div className="sm:col-span-2">
                    <label className="block text-xs text-secondary" htmlFor={`${fieldId}-extra`}>
                      额外参数 JSON（可选）
                    </label>
                    <textarea
                      id={`${fieldId}-extra`}
                      className={`${INPUT} mt-1 h-16 resize-y font-mono`}
                      spellCheck={false}
                      value={draft.extraText}
                      placeholder='{"reasoning_effort":"high"}'
                      onChange={(event) => onChange(updateDraft(drafts, draft.id, { extraText: event.target.value }))}
                      onBlur={() => touch(draft.id)}
                    />
                    <p className="mt-1 text-xs text-tertiary">
                      这段参数会合并进这个模型的请求体，用来开思考模式、调采样参数之类；留空就什么都不加，会自动校验 JSON。
                    </p>
                    {showing && rowErrors?.extra ? <p className="mt-1 text-xs text-rust">{rowErrors.extra}</p> : null}
                    <details className="mt-1 text-xs text-tertiary">
                      <summary className="cursor-pointer hover:text-secondary">看示例</summary>
                      <ul className="mt-1 flex flex-col gap-1">
                        <li className="break-all">
                          <code className="font-mono text-meta text-secondary">{'{"reasoning_effort":"high"}'}</code>
                          <span className="ml-1">— 高强度思考（OpenAI 兼容）</span>
                        </li>
                        <li className="break-all">
                          <code className="font-mono text-meta text-secondary">{'{"thinking":{"type":"enabled","budget_tokens":8000}}'}</code>
                          <span className="ml-1">— 开思考并给预算（Anthropic 兼容）</span>
                        </li>
                      </ul>
                      <p className="mt-1">model、messages、input、stream、tools 由 hub 自己填，不能在这里覆盖。</p>
                    </details>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      <div className="flex items-end gap-2 border-t border-hair px-2.5 py-2">
        <input
          className={INPUT}
          value={manualId}
          onChange={(event) => setManualId(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            addManual();
          }}
          placeholder="手动填一个模型 id，回车添加"
          aria-label="手动添加模型 id"
        />
        <button type="button" className={SMALL_BUTTON} disabled={manualId.trim() === ''} onClick={addManual}>
          添加
        </button>
      </div>
    </div>
  );
}
