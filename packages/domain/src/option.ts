/**
 * 运行时可调项：模型、思考强度、模式……
 *
 * 形状照 ACP（Agent Client Protocol）v2 的 Session Config Options 抄的，
 * 因为那是目前唯一一个「不同 agent 都认」的同类机制：
 * agent 在开会话时把清单报上来，客户端照着渲染，改值走一条通用调用。
 *
 * 我们只做两件事：把 ACP 的名字换成本地名字，以及**不许平台自己发明选项**。
 * 一个 runtime 报什么，界面就显示什么；它不报，界面就不显示——
 * 这和 ADR 0003「模型清单来自 agent」是同一条规矩。
 */

/** 语义分类。只用来决定摆放位置与图标，**不能**当作正确性依赖。 */
export type OptionCategory = 'model' | 'mode' | 'model_config' | 'thought_level' | 'custom';

export interface OptionValue {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export type OptionValueOrGroup =
  | { readonly kind: 'value'; readonly value: OptionValue }
  | { readonly kind: 'group'; readonly label: string; readonly values: readonly OptionValue[] };

export interface RuntimeOption {
  /** 改值时用它，必须在该 runtime 内唯一。 */
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly category: OptionCategory;
  readonly kind: 'select' | 'boolean';
  readonly current: string | boolean;
  /** select 的候选；boolean 恒为空。分组是为了像 ACP 那样按来源归堆。 */
  readonly choices: readonly OptionValueOrGroup[];
}

export function optionValues(option: RuntimeOption): readonly OptionValue[] {
  return option.choices.flatMap((choice) => (choice.kind === 'value' ? [choice.value] : choice.values));
}

export function findOption(
  options: readonly RuntimeOption[],
  id: string
): RuntimeOption | null {
  return options.find((option) => option.id === id) ?? null;
}

/** 模型选项的值列表——派生对话框的模型下拉就用它，不另开一份清单。 */
export function modelsOf(options: readonly RuntimeOption[]): readonly string[] {
  const model = options.find((option) => option.category === 'model');
  return model === undefined ? [] : optionValues(model).map((value) => value.value);
}

export function optionLabel(option: RuntimeOption): string {
  const current = option.current;
  if (typeof current === 'boolean') return current ? '开' : '关';
  const match = optionValues(option).find((value) => value.value === current);
  return match?.label ?? current;
}
