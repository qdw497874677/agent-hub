import type { ReactNode } from 'react';
import type { RuntimeOptionDto } from './api.ts';
import { ModelPicker, SEARCHABLE_AFTER } from './model-picker.tsx';
import type { ModelItem } from './model-list.ts';
import { filterModelsByScope, scopeNote } from './model-scope.ts';

interface Props {
  readonly options: readonly RuntimeOptionDto[];
  readonly values: Readonly<Record<string, string | boolean>>;
  readonly onChange: (optionId: string, value: string | boolean) => void;
  /** 卡片里空间只有 320px：只留模型、Agent、模式与思考强度，其余在检查器里。 */
  readonly compact?: boolean;
  readonly disabled?: boolean;
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
export function OptionControls({ options, values, onChange, compact = false, disabled = false }: Props) {
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
        const current = currentOf(options, values, option);
        if (option.kind === 'boolean') {
          return (
            <label
              key={option.id}
              className="flex items-center gap-1 text-meta text-tertiary"
              title={option.description ?? option.label}
            >
              <input
                type="checkbox"
                aria-label={option.label}
                checked={current === true}
                disabled={disabled}
                onChange={(event) => onChange(option.id, event.target.checked)}
              />
              {option.label}
            </label>
          );
        }
        const items = flatChoices(option);
        // 模型清单里 hub 提供商模型和原生模型是混着来的；先按当前值的类别收口，
        // 别让人选了另一类、再收到「换模型提供商需新开会话」的报错。
        const scoped = option.category === 'model' ? filterModelsByScope(items, String(current)) : null;
        const note = scoped !== null && scoped.hidden > 0 ? scopeNote(String(current)) : undefined;
        if (scoped !== null && scoped.items.length > SEARCHABLE_AFTER) {
          return (
            <ModelPicker
              key={option.id}
              label={option.label}
              scope={option.id}
              items={scoped.items}
              value={String(current)}
              disabled={disabled}
              note={note}
              onChange={(value) => onChange(option.id, value)}
              short={compact}
              className={`${compact ? 'min-w-[80px] flex-1' : ''} max-w-[128px] ${compact ? 'option-control' : 'py-0.5'} rounded-sm border border-hair bg-card px-1 text-meta text-secondary outline-none hover:border-strong focus:border-accent`}
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
            className={`${compact ? (option.category === 'model' ? 'min-w-[80px] flex-1' : 'shrink-0') : ''} ${option.category === 'agent' ? 'max-w-[112px]' : 'max-w-[56px] sm:max-w-[132px]'} ${compact ? 'option-control appearance-none' : 'py-0.5'} truncate rounded-sm border border-hair bg-card px-1 text-meta text-secondary outline-none hover:border-strong focus:border-accent`}
            value={String(current)}
            disabled={disabled}
            // 下拉里选东西不该顺手把卡片拖走
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onChange={(event) => onChange(option.id, event.target.value)}
          >
            {scoped !== null ? (
              modelSelectOptions(scoped.items, String(current))
            ) : (
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
            )}
          </select>
        );
      })}
    </div>
  );
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

/**
 * 短清单走原生 <select> 时用的候选项：按作用域过滤之后分组可能只剩一部分，
 * 所以由摊平后的 ModelItem 重新拼 optgroup（同组的项本来就排在一起）。
 */
function modelSelectOptions(items: readonly ModelItem[], current: string): ReactNode[] {
  if (items.length === 0) return [<option key="current" value={current}>{current}</option>];
  const nodes: ReactNode[] = [];
  let index = 0;
  while (index < items.length) {
    const item = items[index];
    if (item === undefined) break;
    if (item.group === undefined) {
      nodes.push(
        <option key={`${index}:${item.value}`} value={item.value} disabled={item.disabled === true}>
          {item.label}
        </option>
      );
      index += 1;
      continue;
    }
    const run: ModelItem[] = [];
    while (index < items.length && items[index]?.group === item.group) {
      const each = items[index];
      if (each === undefined) break;
      run.push(each);
      index += 1;
    }
    nodes.push(
      <optgroup key={`${item.group}:${index}`} label={item.group}>
        {run.map((each) => (
          <option key={each.value} value={each.value} disabled={each.disabled === true}>
            {each.label}
          </option>
        ))}
      </optgroup>
    );
  }
  return nodes;
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
