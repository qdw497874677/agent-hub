import type { OptionCategory, OptionValueMeta, OptionValueOrGroup, RuntimeOption } from '@agent-hub/domain';

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
  /** ACP 允许厂商在候选项上带 `_meta`；Hub 只读认识的那几个字段。 */
  readonly _meta?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
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

const CATEGORIES: readonly OptionCategory[] = ['model', 'agent', 'mode', 'model_config', 'thought_level'];

function categoryOf(raw: string | undefined): OptionCategory {
  return CATEGORIES.find((category) => category === raw) ?? 'custom';
}

function isGroup(entry: AcpValue | AcpGroup): entry is AcpGroup {
  return (entry as AcpGroup).groupId !== undefined;
}

function positiveNumber(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
}

function stringList(raw: unknown): readonly string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const values = raw.filter((value): value is string => typeof value === 'string' && value.length > 0);
  return values.length > 0 ? values : undefined;
}

/**
 * ACP 候选项的 `_meta` 没有统一 schema；各 runtime 会把模型元数据挂在不同的键上。
 * 这里只认 Hub 会展示的几项，认不出就原样忽略，不猜。
 */
function optionValueMeta(value: AcpValue): OptionValueMeta | undefined {
  const meta = value._meta ?? value.metadata;
  if (meta === undefined) return undefined;
  const contextWindow = positiveNumber(meta['contextWindow'] ?? meta['contextWindowMaxTokens']);
  const maxTokens = positiveNumber(meta['maxTokens']);
  const defaultThinking =
    typeof meta['defaultThinking'] === 'string'
      ? meta['defaultThinking']
      : typeof meta['defaultThinkingOptionId'] === 'string'
        ? meta['defaultThinkingOptionId']
        : undefined;
  const aliases = stringList(meta['aliases']);
  const selectable = typeof meta['selectable'] === 'boolean' ? meta['selectable'] : typeof meta['isSelectable'] === 'boolean' ? meta['isSelectable'] : undefined;
  const tags = stringList(meta['tags']);
  if (contextWindow === undefined && maxTokens === undefined && defaultThinking === undefined && aliases === undefined && selectable === undefined && tags === undefined) {
    return undefined;
  }
  return {
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(defaultThinking === undefined ? {} : { defaultThinking }),
    ...(aliases === undefined ? {} : { aliases }),
    ...(selectable === undefined ? {} : { selectable }),
    ...(tags === undefined ? {} : { tags })
  };
}

/**
 * 运行时自己的名字 → 平台语义。
 *
 * ACP 的 `category` 是通用词汇，同一个 `mode` 在不同 agent 里可能指完全不同的东西：
 * OpenCode 的 `mode` 是当前 agent（orchestrator/build/plan），Hermes 的 `mode` 是权限模式。
 * 所以语义修正放在 agent 配置里，适配器只负责搬运，不按 agent 名字写分支。
 */
export interface AcpOptionOverride {
  readonly category?: OptionCategory;
  readonly label?: string;
}

export function mapAcpOptions(
  raw: unknown,
  overrides: Readonly<Record<string, AcpOptionOverride>> = {}
): readonly RuntimeOption[] {
  if (!Array.isArray(raw)) return [];
  const options: RuntimeOption[] = [];
  for (const entry of raw as AcpConfigOption[]) {
    const configId = entry?.id ?? entry?.configId;
    if (typeof configId !== 'string') continue;
    const override = Object.prototype.hasOwnProperty.call(overrides, configId) ? overrides[configId] : undefined;
    const choices: OptionValueOrGroup[] = [];
    for (const item of entry.options ?? []) {
      if (isGroup(item)) {
        choices.push({
          kind: 'group',
          label: item.name,
          values: item.options.map((value) => ({
            value: value.value,
            label: value.name,
            ...(value.description === undefined ? {} : { description: value.description }),
            ...(optionValueMeta(value) === undefined ? {} : { metadata: optionValueMeta(value) })
          }))
        });
      } else {
        choices.push({
          kind: 'value',
          value: {
            value: item.value,
            label: item.name,
            ...(item.description === undefined ? {} : { description: item.description }),
            ...(optionValueMeta(item) === undefined ? {} : { metadata: optionValueMeta(item) })
          }
        });
      }
    }
    options.push({
      id: configId,
      label: override?.label ?? entry.name,
      ...(entry.description === undefined ? {} : { description: entry.description }),
      category: override?.category ?? categoryOf(entry.category),
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

/**
 * 老式（ACP unstable）的会话级 `models` / `modes`：没有 configOptions 的 agent（Hermes 0.22.5）只报这两块，
 * 改值走 `session/set_model` / `session/set_mode`。翻成同形状的 RuntimeOption，id 固定为 `model` / `mode`。
 */
export const LEGACY_OPTION_IDS = ['model', 'mode'] as const;

export function legacyAcpOptions(session: Readonly<Record<string, unknown>>): readonly RuntimeOption[] {
  const out: RuntimeOption[] = [];
  const models = session['models'] as { availableModels?: { modelId?: unknown; name?: unknown; description?: unknown }[]; currentModelId?: unknown } | undefined;
  if (models && typeof models.currentModelId === 'string') {
    out.push({
      id: 'model',
      label: '模型',
      category: 'model',
      kind: 'select',
      current: models.currentModelId,
      choices: (models.availableModels ?? []).flatMap((m) =>
        typeof m.modelId === 'string' ? [{ kind: 'value' as const, value: { value: m.modelId, label: typeof m.name === 'string' ? m.name : m.modelId, ...(typeof m.description === 'string' ? { description: m.description } : {}) } }] : []
      )
    });
  }
  const modes = session['modes'] as { availableModes?: { id?: unknown; name?: unknown; description?: unknown }[]; currentModeId?: unknown } | undefined;
  if (modes && typeof modes.currentModeId === 'string') {
    out.push({
      id: 'mode',
      label: '模式',
      category: 'mode',
      kind: 'select',
      current: modes.currentModeId,
      choices: (modes.availableModes ?? []).flatMap((m) =>
        typeof m.id === 'string' ? [{ kind: 'value' as const, value: { value: m.id, label: typeof m.name === 'string' ? m.name : m.id, ...(typeof m.description === 'string' ? { description: m.description } : {}) } }] : []
      )
    });
  }
  return out;
}
