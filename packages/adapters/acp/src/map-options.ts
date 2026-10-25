import type { OptionCategory, OptionValueOrGroup, RuntimeOption } from '@agent-hub/domain';

/**
 * ACP 的 ConfigOption → 平台的 RuntimeOption。
 *
 * 这是一条纯搬运：ACP 定义了 agent 怎么报可配置项（含 `category`
 * `model` / `mode` / `model_config` / `thought_level`），我们照抄形状，
 * 只把未认识的 category 收进 `custom`——不认识的选项要原样留着，
 * 因为 agent 那边可能正在用它（ACP 规范明确要求客户端这么做）。
 */

interface AcpValue {
  readonly value: string;
  readonly name: string;
  readonly description?: string;
}

interface AcpGroup {
  readonly groupId: string;
  readonly name: string;
  readonly options: readonly AcpValue[];
}

interface AcpConfigOption {
  /** ACP 现行 schema（官方 SDK 2.x）用 `id`；早期草案用 `configId`，两种都认。 */
  readonly id?: string;
  readonly configId?: string;
  readonly name: string;
  readonly description?: string;
  readonly category?: string;
  readonly type?: string;
  readonly currentValue: string | boolean;
  readonly options?: readonly (AcpValue | AcpGroup)[];
}

const CATEGORIES: readonly OptionCategory[] = ['model', 'mode', 'model_config', 'thought_level'];

function categoryOf(raw: string | undefined): OptionCategory {
  return CATEGORIES.find((category) => category === raw) ?? 'custom';
}

function isGroup(entry: AcpValue | AcpGroup): entry is AcpGroup {
  return (entry as AcpGroup).groupId !== undefined;
}

export function mapAcpOptions(raw: unknown): readonly RuntimeOption[] {
  if (!Array.isArray(raw)) return [];
  const options: RuntimeOption[] = [];
  for (const entry of raw as AcpConfigOption[]) {
    const configId = entry?.id ?? entry?.configId;
    if (typeof configId !== 'string') continue;
    const choices: OptionValueOrGroup[] = [];
    for (const item of entry.options ?? []) {
      if (isGroup(item)) {
        choices.push({
          kind: 'group',
          label: item.name,
          values: item.options.map((value) => ({
            value: value.value,
            label: value.name,
            ...(value.description === undefined ? {} : { description: value.description })
          }))
        });
      } else {
        choices.push({
          kind: 'value',
          value: {
            value: item.value,
            label: item.name,
            ...(item.description === undefined ? {} : { description: item.description })
          }
        });
      }
    }
    options.push({
      id: configId,
      label: entry.name,
      ...(entry.description === undefined ? {} : { description: entry.description }),
      category: categoryOf(entry.category),
      kind: entry.type === 'boolean' ? 'boolean' : 'select',
      current: entry.currentValue,
      choices
    });
  }
  return options;
}

/** 当前值集合，用来落库（`session.options`）。 */
export function currentValues(options: readonly RuntimeOption[]): Record<string, string | boolean> {
  const values: Record<string, string | boolean> = {};
  for (const option of options) values[option.id] = option.current;
  return values;
}
