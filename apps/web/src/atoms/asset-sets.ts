/**
 * 资产组合（AssetSet）的纯逻辑：仓库里只放「顺序怎么叠」「哪几个是真的选中」「什么时候才传」。
 *
 * 组合 = 一组资产打包，项目默认引用（`project.assetSetIds`，顺序有意义，最多 8 个），
 * 派生会话时可以整组带、取消，或者换成别的组合（`derive.assetSetIds`）。
 * 界面只负责渲染和发请求；判定都在这里，能单独测。
 */

/** 项目默认引用 / 派生时显式选择的上限，和后端请求 schema 一致。 */
export const MAX_ASSET_SETS = 8;
/** 组合名字 / 说明的长度上限，和后端 assetSetInput 一致。 */
export const ASSET_SET_NAME_MAX = 60;
export const ASSET_SET_DESCRIPTION_MAX = 300;
/** 一个组合里最多几项。 */
export const ASSET_SET_ITEMS_MAX = 50;

/**
 * 顺序叠加去重：同一个 id 只留第一次出现的位置（顺序有意义，后面的不往前挪）。
 * 空串和重复项直接丢掉——服务端不认空 id，重复只会让同一组资产叠两遍。
 * 上限不在这里砍：超了要让保存/提交显式报错（`setLimitProblem`），截断会让人以为第 9 个「保存成功」了。
 */
export function orderedSetIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** 勾上就追加到末尾（后面的组合盖前面的同名资产），取消就原地拿掉；到上限就不再加。 */
export function toggleSetId(ids: readonly string[], id: string, selected: boolean): string[] {
  const current = orderedSetIds(ids);
  if (!selected) return current.filter((existing) => existing !== id);
  if (current.includes(id)) return current;
  if (current.length >= MAX_ASSET_SETS) return current;
  return [...current, id];
}

/** 调整叠加顺序：`delta = -1` 往前挪一位，`1` 往后挪一位；越界就原样返回。 */
export function moveSetId(ids: readonly string[], id: string, delta: -1 | 1): string[] {
  const current = orderedSetIds(ids);
  const from = current.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= current.length) return current;
  const next = [...current];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return current;
  next.splice(to, 0, moved);
  return next;
}

const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, index) => id === b[index]);

/**
 * 派生对话框里「这次用哪几个组合」的选择。
 * `defaults` 是项目默认组合（用来判断用户到底动没动过），`touched` 为 false 时提交不传。
 */
export interface AssetSetChoice {
  readonly key: string;
  readonly defaults: readonly string[];
  readonly ids: readonly string[];
  readonly touched: boolean;
}

/** 项目默认组合变化（别人改了项目设置）就重来；同一个 key 原样返回同一份引用。 */
export const assetSetChoiceKey = (defaults: readonly string[]): string => orderedSetIds(defaults).join('\n');

export function setChoiceFor(previous: AssetSetChoice | null, defaults: readonly string[]): AssetSetChoice {
  const key = assetSetChoiceKey(defaults);
  if (previous !== null && previous.key === key) return previous;
  const initial = orderedSetIds(defaults);
  return { key, defaults: initial, ids: initial, touched: false };
}

/** 点一个组合 chip：勾选 / 取消都算「动过」；又勾回和默认完全一样时算没动。 */
export function toggleSetChoice(choice: AssetSetChoice, id: string, selected: boolean): AssetSetChoice {
  const ids = toggleSetId(choice.ids, id, selected);
  return { key: choice.key, defaults: choice.defaults, ids, touched: !sameIds(ids, choice.defaults) };
}

/**
 * 发给 `POST /api/sessions/derive` 的 `assetSetIds`：
 * 没动过返回 undefined（用项目默认组合），动过返回选中的 id（可能为空数组 = 这次不带组合）。
 */
export function submitAssetSetIds(choice: AssetSetChoice): string[] | undefined {
  return choice.touched ? [...choice.ids] : undefined;
}

/** 「3 项」：组合列表和 chip 上都用这一句，别各写各的。 */
export const itemCountText = (count: number): string => `${count} 项`;

/** 被几个项目引用：后端没给（null）就不显示这一行。 */
export function referenceText(count: number | null): string | null {
  if (count === null) return null;
  return count === 0 ? '没有被项目引用' : `被 ${count} 个项目引用`;
}

/** 保存前的问题：名字必填、≤60；说明 ≤300。没问题返回 null。 */
export function setNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return '给组合起个名字';
  if (trimmed.length > ASSET_SET_NAME_MAX) return `名字最多 ${ASSET_SET_NAME_MAX} 个字`;
  return null;
}

export function setDescriptionProblem(text: string): string | null {
  return text.length > ASSET_SET_DESCRIPTION_MAX ? `说明最多 ${ASSET_SET_DESCRIPTION_MAX} 个字` : null;
}

/** 项目默认组合上限：超过 8 个就不让保存（后端也会拒）。数的是去重后的个数，不受裁剪影响。 */
export function setLimitProblem(ids: readonly string[]): string | null {
  const count = new Set(ids.filter((id) => id !== '')).size;
  return count > MAX_ASSET_SETS ? `最多 ${MAX_ASSET_SETS} 个组合` : null;
}
