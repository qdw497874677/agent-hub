/**
 * 会话内模型清单的合并：agent 自己上报的原生模型 + hub 提供商给的模型（`hub-<slug>/<model>`）。
 *
 * 派生对话框（`shell/dialogs.tsx` 的 `withHubModels`）早就这么做了，但会话里的
 * `session.optionSpec` 只有 agent 的原生模型，用户看不到 hub 提供的模型。这里做同一件事，
 * 只是输出的是 ACP 选项形状（`{kind:'value', value:{value,label}}`），能直接喂给 `OptionControls`。
 *
 * 这个模块不带 DOM / JSX：根 tsconfig 只把 web 的单测文件拉进来编译，那边没有 DOM lib，
 * 所以**不要**从这里 import `shell/api.ts`（形状按结构声明）。同理不 import contract。
 */
import { modelScope, scopeNote } from './model-scope.ts';

/** 一个 hub 模型：id 已经是 `hub-<slug>/<model>`，label 是给人看的名字。 */
export interface HubModelChoiceSpec {
  readonly id: string;
  readonly label: string;
}

/** hub 侧按提供商分组的模型清单（`GET /api/providers/models` 的一项）。 */
export interface HubModelProviderSpec {
  readonly slug: string;
  readonly name: string;
  readonly protocol: string;
  readonly models: readonly HubModelChoiceSpec[];
}

interface OptionValueSpec {
  readonly value: string;
  readonly label: string;
}

type OptionChoiceSpec =
  | { readonly kind: 'value'; readonly value: OptionValueSpec }
  | { readonly kind: 'group'; readonly label: string; readonly values: readonly OptionValueSpec[] };

/** ACP 选项的最小形状（`RuntimeOptionDto` 结构兼容）。 */
interface OptionSpec {
  readonly id: string;
  readonly label?: string;
  readonly kind?: 'select' | 'boolean';
  readonly current?: string | boolean;
  readonly choices: readonly OptionChoiceSpec[];
}

/** 换提供商 = 重启这条会话的进程（hub 侧 `switchSessionModel` 会接回历史）。 */
export const HUB_SWITCH_NOTE = scopeNote('');

const valueOf = (choice: OptionChoiceSpec): readonly OptionValueSpec[] =>
  choice.kind === 'group' ? choice.values : [choice.value];

/**
 * 把协议匹配的 hub 模型追加到 `id === 'model'` 的选项末尾。
 *
 * - 去重：原生清单里已有的 id 不再追加，hub 自己的重复也跳过；
 * - 当前值不在清单里（老会话 / agent 没报全）时补在最前面，`<select>` 才不会显示空白；
 * - `protocols` 为 `null` / `undefined` = 拿不到协议信息，不过滤（宁可多列）；
 *   空数组 = 这台机器上的 agent 明说不支持 hub 提供商，一个都不加（和派生对话框一致）；
 * - 没有 model 选项（或它是开关）时原样返回。
 */
export function mergeHubModelChoices<T extends OptionSpec>(
  optionSpec: readonly T[],
  hub: readonly HubModelProviderSpec[],
  protocols: readonly string[] | null | undefined
): T[] {
  const index = optionSpec.findIndex((option) => option.id === 'model');
  const option = index < 0 ? undefined : optionSpec[index];
  if (option === undefined || option.kind === 'boolean') return [...optionSpec];

  const seen = new Set<string>();
  for (const choice of option.choices) for (const value of valueOf(choice)) seen.add(value.value);

  const usable = protocols === null || protocols === undefined
    ? hub
    : hub.filter((provider) => protocols.includes(provider.protocol));

  const added: OptionChoiceSpec[] = [];
  for (const provider of usable) {
    for (const model of provider.models) {
      if (model.id === '' || seen.has(model.id)) continue;
      seen.add(model.id);
      added.push({ kind: 'value', value: { value: model.id, label: model.label } });
    }
  }

  const current = typeof option.current === 'string' ? option.current : '';
  const missingCurrent = current !== '' && !seen.has(current);
  if (added.length === 0 && !missingCurrent) return [...optionSpec];

  const choices: OptionChoiceSpec[] = [
    ...(missingCurrent ? [{ kind: 'value', value: { value: current, label: current } } as const] : []),
    ...option.choices,
    ...added
  ];
  const next = { ...option, choices } as unknown as T;
  return optionSpec.map((each, at) => (at === index ? next : each));
}

/**
 * 清单里 hub 模型与原生模型并存时，提醒一句「换提供商会重启进程」。
 * 只有一类时返回 `undefined`（同一条提供商里换模型、或全原生之间换，都不重启）。
 */
export function hubSwitchNote(optionSpec: readonly OptionSpec[]): string | undefined {
  const option = optionSpec.find((each) => each.id === 'model');
  if (option === undefined) return undefined;
  const values = option.choices.flatMap(valueOf).map((value) => value.value);
  if (typeof option.current === 'string' && option.current !== '') values.push(option.current);
  const hasHub = values.some((value) => modelScope(value).kind === 'hub');
  const hasNative = values.some((value) => modelScope(value).kind === 'native');
  return hasHub && hasNative ? HUB_SWITCH_NOTE : undefined;
}
