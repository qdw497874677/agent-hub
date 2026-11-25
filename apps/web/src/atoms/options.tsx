import { useState } from 'react';
import type { RuntimeOptionDto } from '../shell/api.ts';
import { ModelPicker } from './model-picker.tsx';
import type { ModelItem } from './model-list.ts';
import { filterModelsByScope, hasSelectableCrossScope, scopeNote } from './model-scope.ts';
import { useOptionFeedback } from './option-feedback.tsx';

interface Props {
  readonly options: readonly RuntimeOptionDto[];
  readonly values: Readonly<Record<string, string | boolean>>;
  readonly onChange: (optionId: string, value: string | boolean) => void | Promise<unknown>;
  /** 卡片里空间只有 320px：只留模型、Agent、模式与思考强度，其余在检查器里。 */
  readonly compact?: boolean;
  readonly disabled?: boolean;
  readonly sessionId: string;
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

export function OptionControls({ options, values, onChange, sessionId, compact = false, disabled = false }: Props) {
  const feedback = useOptionFeedback(sessionId);
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
  const visible = compact
    ? options
        .filter((option) => COMPACT_CATEGORIES.includes(option.category))
        .slice()
        .sort((left, right) => COMPACT_ORDER.indexOf(left.category) - COMPACT_ORDER.indexOf(right.category))
    : options;
  if (visible.length === 0) return null;

  return (
    // 窄屏放不下三项时换行，别把模型选择器挤成一条竖线；sm 以上保持一行。
    <div
      data-testid={compact ? 'option-controls-compact' : 'option-controls'}
      className={`flex min-w-0 items-center gap-0.5 ${compact ? 'flex-wrap sm:flex-nowrap' : 'flex-wrap'}`}
    >
      {visible.map((option) => {
        const status = feedback[option.id];
        const current = status?.state === 'pending' ? status.original : currentOf(options, values, option);
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
        // 模型清单里 hub 提供商模型和原生模型混着来。现在换提供商会重启这条会话的进程
        // 并接回历史（`switchSessionModel`），所以两类都放出来，只在要跨类时提醒一句。
        const scoped = option.category === 'model' ? filterModelsByScope(items, String(current)) : null;
        const crossesScope = scoped !== null && hasSelectableCrossScope(items, String(current));
        const note = crossesScope ? scopeNote(String(current)) : undefined;
        // 模型一律走同一个选择器（按提供方分组、可搜索），和派生对话框、Bot 设置一致
        if (scoped !== null) {
          return (
            <ModelPicker
              key={option.id}
              label={option.label}
              scope={option.id}
              items={scoped.items}
              value={String(current)}
              disabled={disabled || waiting}
              pending={waiting}
              note={note}
              onChange={(value) => runChange(option.id, value)}
              short={compact}
              className={`${compact ? `min-w-[80px] flex-1 option-control ${CHIP}` : 'rounded-sm border border-hair bg-card px-1 py-0.5'} max-w-[160px] text-meta text-secondary outline-none hover:border-strong focus:border-ring`}
            />
          );
        }
        // 短清单走原生 <select>，塞不进额外一行说明，就把说明放进控件的 title。
        const title = note === undefined ? (option.description ?? option.label) : `${option.description ?? option.label}（${note}）`;
        return (
          <select
            key={option.id}
            aria-label={option.label}
            title={title}
            data-category={option.category}
            className={`${compact ? 'shrink-0' : ''} ${option.category === 'agent' ? 'max-w-[112px]' : 'max-w-[72px] sm:max-w-[132px]'} ${compact ? `option-control appearance-none ${CHIP}` : 'rounded-sm border border-hair bg-card px-1 py-0.5'} min-h-[44px] min-w-[44px] md:min-h-0 truncate text-meta text-secondary outline-none hover:border-strong focus:border-ring`}
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
          </select>
        );
      })}
    </div>
  );
}

/** 与输入区相邻：不阻止发送，但不把未确认的设置说成已生效。 */
export function OptionFeedbackNotice({ sessionId, options }: { sessionId: string; options: readonly RuntimeOptionDto[] }) {
  const feedback = useOptionFeedback(sessionId);
  const label = (option: RuntimeOptionDto, value: string | boolean) =>
    typeof value === 'boolean' ? (value ? '开启' : '关闭') : (flatChoices(option).find((item) => item.value === value)?.label ?? value);
  return <div className="space-y-1">{options.map((option) => {
    const item = feedback[option.id];
    if (!item) return null;
    const target = label(option, item.target);
    const text = item.state === 'pending' ? `${option.label}：正在切换到 ${target}，当前仍显示 ${label(option, item.original)}。发送时设置可能尚未生效。`
      : item.state === 'confirmed' ? `${option.label}：已确认切换到 ${target}。`
      : item.state === 'saved' ? `${option.label}：已保存 ${target}，下次启动时生效。`
      : item.state === 'rejected' ? `${option.label}：切换未被接受，原设置保留。`
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
