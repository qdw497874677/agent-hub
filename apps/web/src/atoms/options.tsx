import { useContext, useEffect, useRef, useState } from 'react';
import type { RuntimeOptionDto } from '../shell/api.ts';
import { ModelPicker } from './model-picker.tsx';
import type { ModelItem } from './model-list.ts';
import { modelScope, sameModelScope } from './model-scope.ts';
import { providerOf } from './model-list.ts';
import { useOptionFeedback } from './option-feedback.tsx';
import { useHandoffCandidates } from './agent-handoff.tsx';
import type { SessionDto } from '../shell/api.ts';
import { useNewSessionWithModel } from '../shell/new-session-with-model.ts';
import { useNarrow } from '../shell/device.ts';
import { HandoffEntryInSessionMenu } from './handoff-entry-context.ts';

interface Props {
  readonly options: readonly RuntimeOptionDto[];
  readonly values: Readonly<Record<string, string | boolean>>;
  readonly onChange: (optionId: string, value: string | boolean) => void | Promise<unknown>;
  /** 卡片里空间只有 320px：只留模型、Agent、模式与思考强度，其余在检查器里。 */
  readonly compact?: boolean;
  readonly mobileLayout?: boolean;
  readonly disabled?: boolean;
  readonly sessionId: string;
  readonly agentLabel: string;
  readonly session: SessionDto;
  readonly projectId: string;
}

const COMPACT_CATEGORIES: readonly string[] = ['model', 'agent', 'mode', 'thought_level'];
/** 底栏顺序：先选模型，再选 agent/模式，最后是思考强度。 */
const COMPACT_ORDER: readonly string[] = ['model', 'thought_level', 'agent', 'mode'];

export function currentOf(
  options: readonly RuntimeOptionDto[],
  values: Readonly<Record<string, string | boolean>>,
  option: RuntimeOptionDto
): string | boolean {
  return values[option.id] ?? option.current ?? options.length === 0;
}

/**
 * 可调项不是我们发明的清单，是 agent 报上来的清单（ACP 的 config options）。
 *
 * 所以这里**没有**任何硬编码的选项名或候选值：agent 报几条就画几条，
 * 报未知 category 也照画（收在「其它」里），换模型后候选项变了也跟着变。
 * 这与 ADR 0003「模型清单来自 agent」是同一条纪律。
 */
/** 输入框底栏里的可调项画成小胶囊：透明底、细边、悬停才加深（参照 t3code 的 composer chips）。 */
const CHIP = 'rounded-full border border-hair bg-transparent px-2.5 hover:bg-hover';

export function OptionControls({ options, values, onChange, sessionId, agentLabel, session, projectId, compact = false, mobileLayout = false, disabled = false }: Props) {
  const handoffInMenu = useContext(HandoffEntryInSessionMenu);
  const feedback = useOptionFeedback(sessionId);
  const handoff = useHandoffCandidates(session, projectId);
  const openNewSession = useNewSessionWithModel();
  const narrow = useNarrow();
  const mobile = compact && mobileLayout && narrow;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!settingsOpen) return;
    const dismiss = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setSettingsOpen(false); };
    window.addEventListener('pointerdown', dismiss);
    return () => window.removeEventListener('pointerdown', dismiss);
  }, [settingsOpen]);
  // 一次请求没回来之前，这个可调项显示“切换中…”，但绝不显示还没被确认的目标值。
  const [pending, setPending] = useState<Readonly<Record<string, true>>>({});
  const runChange = (optionId: string, value: string | boolean) => {
    const result = onChange(optionId, value);
    if (!(result instanceof Promise)) return;
    setPending((current) => ({ ...current, [optionId]: true }));
    const clear = () =>
      setPending((current) => {
        if (current[optionId] !== true) return current;
        const next = { ...current };
        delete next[optionId];
        return next;
      });
    // 失败由调用方呈现；这里只负责把“切换中”收掉，别留下未处理的 rejection。
    void result.then(clear, clear);
  };
  const hasModel = options.some((option) => option.category === 'model');
  const availableOptions: readonly RuntimeOptionDto[] = hasModel ? options : [
    { id: 'model', label: '模型', category: 'model', kind: 'select', current: '', choices: [] },
    ...options
  ];
  const visible = compact
    ? availableOptions
        .filter((option) => COMPACT_CATEGORIES.includes(option.category))
        .slice()
        .sort((left, right) => COMPACT_ORDER.indexOf(left.category) - COMPACT_ORDER.indexOf(right.category))
    : availableOptions;
  if (visible.length === 0) return null;

  const controls = visible.map((option) => {
        const status = feedback[option.id];
        // 模型的 options 是保存的启动设置，只有 optionSpec.current 是运行时报告的值。
        const current = !hasModel && option.category === 'model' ? ''
          : status?.state === 'pending' ? status.original
          : option.category === 'model' ? option.current : currentOf(options, values, option);
        const waiting = pending[option.id] === true || status?.state === 'pending';
        if (option.kind === 'boolean') {
          return (
            <label
              key={option.id}
              className="flex min-h-[44px] min-w-[44px] items-center gap-1 text-meta text-tertiary md:min-h-0"
              title={option.description ?? option.label}
            >
              <input
                type="checkbox"
                aria-label={option.label}
                checked={current === true}
                disabled={disabled || waiting}
                aria-busy={waiting || undefined}
                onChange={(event) => runChange(option.id, event.target.checked)}
              />
              {option.label}
            </label>
          );
        }
        const items = flatChoices(option);
        // 本轮只支持原地切换；来源不同时不能走旧的隐式重启路径。
        const newSessionModels = new Set<string>();
        const scoped = option.category === 'model' ? items.map((item) => {
          const restart = String(current) !== '' && !sameModelScope(item.value, String(current));
          const unknown = String(current) === '' && item.value !== '';
          const uncertain = status?.state === 'unconfirmed' && status.observed === undefined;
          const source = modelScope(item.value).kind === 'hub' ? 'Hub' : '本机';
          const canStartNew = restart && !item.disabled && !disabled && !waiting && openNewSession !== null && session.taskId !== null && session.kind !== 'side' && !session.parentSessionId && !!session.workerId && (!!session.workspaceId || !!session.groupId);
          if (canStartNew) newSessionModels.add(item.value);
          return { ...item, group: `${source} · ${providerOf(item)}`, keywords: [...(item.keywords ?? []), agentLabel],
            ...(item.disabled ? {} : canStartNew ? { description: '不同来源，不能在当前会话切换' } : restart || unknown || uncertain ? { disabled: true, description: uncertain ? '当前切换结果未确认，暂不能切换' : restart ? '不同来源，当前会话不能切换；此处暂不能新建会话' : '当前模型未确认，暂不能切换' } : {}) };
        }) : null;
        // 模型一律走同一个选择器（按提供方分组、可搜索），和派生对话框、Bot 设置一致
        if (scoped !== null) {
          return (
            <ModelPicker
              key={option.id}
              label="模型"
              agentLabel={agentLabel}
              sessionPicker
              scope={option.id}
              items={scoped}
              newSessionModels={newSessionModels}
              onNewSession={(value) => openNewSession?.(session, value)}
              value={String(current)}
              disabled={disabled || waiting || !hasModel}
              pending={waiting}
              onChange={(value) => runChange(option.id, value)}
              short
              className={`${compact ? `min-w-[44px] ${mobile ? 'min-h-[44px] flex-1 basis-0' : 'shrink basis-auto option-control'} ${CHIP}` : 'rounded-sm border border-hair bg-card px-1 py-0.5'} max-w-[180px] text-meta text-secondary outline-none hover:border-strong focus:border-ring`}
            />
          );
        }
        // 短清单走原生 <select>，塞不进额外一行说明，就把说明放进控件的 title。
        const title = option.description ?? option.label;
        return (
          <label key={option.id} className={mobile ? 'flex items-center justify-between gap-2' : 'contents'}>
            {mobile ? <span className="shrink-0 text-meta text-secondary">{option.category === 'thought_level' ? '思考强度' : option.category === 'mode' ? '模式' : option.label}</span> : null}
          <select
            aria-label={option.label}
            title={title}
            data-category={option.category}
            className={`${mobile ? 'max-w-[180px]' : option.category === 'agent' ? 'max-w-[112px]' : 'max-w-[72px] sm:max-w-[132px]'} ${compact ? `${mobile ? '' : 'option-control'} appearance-none ${CHIP}` : 'rounded-sm border border-hair bg-card px-1 py-0.5'} min-h-[44px] min-w-[44px] md:min-h-0 truncate text-meta text-secondary outline-none hover:border-strong focus:border-ring`}
            value={String(current)}
            disabled={disabled || waiting}
            aria-busy={waiting || undefined}
            // 下拉里选东西不该顺手把卡片拖走
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onChange={(event) => runChange(option.id, event.target.value)}
          >
            <>
                {option.choices.length === 0 ? <option value={String(current)}>{String(current)}</option> : null}
                {option.choices.map((choice, index) =>
                  choice.kind === 'group' ? (
                    <optgroup key={`${option.id}-${index}`} label={choice.label}>
                      {choice.values.map((value) => (
                        <option key={value.value} value={value.value} disabled={value.metadata?.selectable === false}>
                          {value.label}
                        </option>
                      ))}
                    </optgroup>
                  ) : (
                    <option key={choice.value.value} value={choice.value.value} disabled={choice.value.metadata?.selectable === false}>
                      {choice.value.label}
                    </option>
                  )
                )}
            </>
          </select></label>
        );
      });
  return <>
    <div ref={root} data-testid={compact ? 'option-controls-compact' : 'option-controls'} className={`relative flex min-w-0 items-center gap-0.5 ${compact ? 'flex-1 flex-nowrap' : 'flex-wrap'}`}
      onKeyDown={(event) => { if (event.key === 'Escape' && settingsOpen) { event.stopPropagation(); setSettingsOpen(false); root.current?.querySelector<HTMLButtonElement>('[data-testid="session-options-trigger"]')?.focus(); } }}>
      {mobile ? controls.filter((_, index) => visible[index]?.category === 'model') : controls}
      {mobile && settingsOpen ? <div data-testid="session-options-panel" className="absolute bottom-full right-0 z-20 mb-2 flex w-64 max-w-[80vw] flex-col gap-1 rounded-lg border border-strong bg-overlay p-3 shadow-overlay">{controls.filter((_, index) => visible[index]?.category !== 'model')}{visible.every((option) => option.category === 'model') ? <p className="text-meta text-tertiary">当前会话没有其他可调选项</p> : null}</div> : null}
      {!mobile && !handoffInMenu ? <ModelPicker
        label="换 Agent"
        dialogTitle="选择要换的 Agent"
        deferPick
        triggerText="交给其他 Agent 继续"
        sessionPicker
        scope={`handoff:${sessionId}`}
        items={handoff.items}
        value=""
        note={handoff.note}
        disabled={disabled}
        onChange={handoff.choose}
        className={`${compact ? `shrink-0 option-control ${CHIP}` : 'rounded-sm border border-hair bg-card px-1 py-0.5'} min-h-[44px] text-meta text-secondary outline-none hover:border-strong focus:border-ring md:min-h-0`}
      /> : null}
      {mobile ? <button type="button" data-testid="session-options-trigger" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((open) => !open)} className="min-h-[44px] shrink-0 px-2 text-meta text-tertiary hover:text-primary">设置</button> : null}
    </div>{handoff.dialog}</>;
}

/** 与输入区相邻：不阻止发送，但不把未确认的设置说成已生效。 */
export function OptionFeedbackNotice({ sessionId, options, savedModel }: { sessionId: string; options: readonly RuntimeOptionDto[]; savedModel: string }) {
  const feedback = useOptionFeedback(sessionId);
  const label = (option: RuntimeOptionDto, value: string | boolean) =>
    typeof value === 'boolean' ? (value ? '开启' : '关闭') : (flatChoices(option).find((item) => item.value === value)?.label ?? value);
  const model = options.find((option) => option.category === 'model');
  return <div className="space-y-1">{savedModel && (!model || model.current !== savedModel) ? <div role="status" data-testid="model-observation" className="text-meta text-secondary">
    当前运行时报告：{model && model.current !== '' ? label(model, model.current) : '未确认'}；保存的启动模型：{model ? label(model, savedModel) : savedModel}。
  </div> : null}{options.map((option) => {
    const item = feedback[option.id];
    if (!item) return null;
    const target = label(option, item.target);
    const text = item.state === 'pending' ? `${option.label}：正在切换到 ${target}，当前仍显示 ${label(option, item.original)}。发送时设置可能尚未生效。`
      : item.state === 'confirmed' ? `${option.label}：之前已确认切换到 ${target}，当前值以选择器为准。`
      : item.state === 'saved' ? `${option.label}：已保存 ${target}，供下次启动使用；当前值以选择器为准。`
      : item.state === 'rejected' ? `${option.label}：上次切换未被接受，当前值以选择器为准。`
      : `${option.label}：未能确认是否切换到 ${target}，发送时使用的设置可能不同。`;
    return <div key={option.id} role="status" data-testid="option-feedback" data-state={item.state} className="flex flex-wrap items-center gap-x-2 text-meta text-secondary">
      <span>{text}{item.observed !== undefined ? ` 最近读取到：${label(option, item.observed)}。这不能确认之前发送的消息使用了什么设置。` : ''}</span>
      {item.recheck ? <button type="button" className="min-h-[44px] rounded-sm text-link underline focus-visible:outline-2 focus-visible:outline-ring md:min-h-0" onClick={item.recheck}>重新查看设置</button> : null}
    </div>;
  })}</div>;
}

/** agent 报的候选项可能分了组也可能没分：摊平成一列，分组名带上，模型选择器按它分组。 */
type OptionValueDto = Extract<RuntimeOptionDto['choices'][number], { kind: 'value' }>['value'];

export function flatChoices(option: RuntimeOptionDto): ModelItem[] {
  const item = (value: OptionValueDto, group?: string): ModelItem => {
    const meta = modelMeta(value.metadata);
    return {
      value: value.value,
      label: value.label,
      ...(group === undefined ? {} : { group }),
      ...(value.description === undefined ? {} : { description: value.description }),
      ...(value.metadata?.aliases === undefined ? {} : { keywords: value.metadata.aliases }),
      ...(meta === undefined ? {} : { meta }),
      ...(value.metadata?.selectable === false ? { disabled: true } : {})
    };
  };
  return option.choices.flatMap((choice) =>
    choice.kind === 'group'
      ? choice.values.map((value) => item(value, choice.label))
      : [item(choice.value)]
  );
}

function compactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

function modelMeta(metadata: OptionValueDto['metadata']): string | undefined {
  if (metadata === undefined) return undefined;
  const parts: string[] = [];
  if (metadata.contextWindow !== undefined) parts.push(`${compactTokens(metadata.contextWindow)} 上下文`);
  if (metadata.maxTokens !== undefined) parts.push(`${compactTokens(metadata.maxTokens)} 输出`);
  if (metadata.tags !== undefined && metadata.tags.length > 0) parts.push(metadata.tags.join(' · '));
  return parts.length === 0 ? undefined : parts.join(' · ');
}
