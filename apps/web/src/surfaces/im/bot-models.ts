/**
 * bot 表单里「模型」一栏的选择清单。纯函数，不碰 DOM，单测在 bot-models.test.ts。
 *
 * 清单本身来自运行时（agent）自己上报的模型；这里只做三件小事：
 * 补一条显式的「默认模型（留空）」、按当前值收口范围（hub 提供商 / 原生不能在同一会话互换）、
 * 以及认出手填过、清单里没有的值——别让它在下拉里静默变成「默认」。
 */
import { filterModelsByScope, scopeNote } from '../../atoms/model-scope.ts';
import type { ModelItem } from '../../atoms/model-list.ts';

/** 空串仍然是合法值（= 用运行时默认），界面上写成一条能点中的选项，别让人猜空白是什么意思。 */
export const BOT_MODEL_DEFAULT_LABEL = '默认模型（留空）';

/** 「留空」不是模型，但它得排在最前面，和模型清单分开一组。 */
export const BOT_MODEL_DEFAULT_ITEM: ModelItem = { value: '', label: BOT_MODEL_DEFAULT_LABEL, group: '默认' };

export interface BotModelChoices {
  readonly items: ModelItem[];
  /** 被范围收起来的个数；> 0 时给一句说明（见 scopeNote）。 */
  readonly hidden: number;
  readonly note?: string;
}

/**
 * 运行时上报的模型 → 选择器的候选项。
 * 当前值为空（还没定）时不收口：这时候两类模型都还没被选中，全都该看得见。
 */
export function botModelChoices(models: readonly string[], current: string): BotModelChoices {
  const all: ModelItem[] = models.map((value) => ({ value, label: value }));
  if (current === '') return { items: all, hidden: 0 };
  const { items, hidden } = filterModelsByScope(all, current);
  return hidden > 0 ? { items, hidden, note: scopeNote(current) } : { items, hidden };
}

/**
 * 当前值不在清单里（编辑老 bot、手填过清单外的模型）时返回它：原生下拉得补一条，
 * 否则受控 select 找不到匹配项，屏幕上会变成「默认模型」而状态里还留着旧值。
 */
export function offListModel(models: readonly string[], current: string): string | null {
  return current !== '' && !models.includes(current) ? current : null;
}
