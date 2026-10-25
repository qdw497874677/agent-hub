import type { RuntimeOptionDto } from './api.ts';

interface Props {
  readonly options: readonly RuntimeOptionDto[];
  readonly values: Readonly<Record<string, string | boolean>>;
  readonly onChange: (optionId: string, value: string | boolean) => void;
  /** 卡片里空间只有 320px：只留模型与思考强度，其余在检查器里。 */
  readonly compact?: boolean;
  readonly disabled?: boolean;
}

const COMPACT_CATEGORIES = ['model', 'thought_level'];

export function currentOf(
  options: readonly RuntimeOptionDto[],
  values: Readonly<Record<string, string | boolean>>,
  option: RuntimeOptionDto
): string | boolean {
  return values[option.id] ?? option.current ?? options.length === 0;
}

/** 分组与单值在 ACP 里是两种形状，这里只做判别，不改写内容。 */
function isGroup(choice: RuntimeOptionDto['choices'][number]): boolean {
  return choice.kind === 'group';
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
    ? options.filter((option) => COMPACT_CATEGORIES.includes(option.category))
    : options;
  if (visible.length === 0) return null;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
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
        return (
          <select
            key={option.id}
            aria-label={option.label}
            title={option.description ?? option.label}
            className="max-w-[132px] truncate rounded-sm border border-hair bg-card px-1 py-0.5 text-meta text-secondary outline-none hover:border-strong focus:border-accent"
            value={String(current)}
            disabled={disabled}
            // 下拉里选东西不该顺手把卡片拖走
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onChange={(event) => onChange(option.id, event.target.value)}
          >
            {option.choices.length === 0 ? <option value={String(current)}>{String(current)}</option> : null}
            {option.choices.map((choice, index) =>
              choice.kind === 'group' ? (
                <optgroup key={`${option.id}-${index}`} label={choice.label}>
                  {choice.values.map((value) => (
                    <option key={value.value} value={value.value}>
                      {value.label}
                    </option>
                  ))}
                </optgroup>
              ) : (
                <option key={choice.value.value} value={choice.value.value}>
                  {choice.value.label}
                </option>
              )
            )}
          </select>
        );
      })}
    </div>
  );
}
