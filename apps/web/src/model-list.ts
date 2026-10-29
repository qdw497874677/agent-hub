/**
 * 模型选择器的纯计算：按提供方分组、模糊筛、最近用过的置顶。
 * 模型清单来自 agent（ADR 0003），这里只整理它报上来的东西，不增不减。
 */
import { fuzzyScore } from './directory-path.ts';

export interface ModelItem {
  readonly value: string;
  readonly label: string;
  /** agent 自己给了分组就用它；没给就按 `提供方/模型` 的前缀分。 */
  readonly group?: string;
}

export interface ModelGroup {
  readonly heading: string;
  readonly items: readonly ModelItem[];
}

export const RECENT_HEADING = '最近用过';
const UNGROUPED = '其它';

/** `cliproxy/kimi-k2` → `cliproxy`；没有斜杠就归「其它」。 */
export function providerOf(item: ModelItem): string {
  if (item.group) return item.group;
  const slash = item.value.indexOf('/');
  return slash > 0 ? item.value.slice(0, slash) : UNGROUPED;
}

/**
 * 分组 + 筛选。不筛时：最近用过（还在清单里的）置顶，其余按提供方分组、组内保持 agent 给的顺序。
 * 筛选时：按匹配分排序，仍按提供方分组（组的先后取组内最高分），最近用过不再单列。
 * 搜索词同时匹配模型名和提供方，打 `openai` 能把整组筛出来。
 */
export function groupModels(items: readonly ModelItem[], query: string, recent: readonly string[] = []): ModelGroup[] {
  const q = query.trim();
  if (q === '') {
    const byValue = new Map(items.map((item) => [item.value, item]));
    const recentItems = recent.map((value) => byValue.get(value)).filter((item): item is ModelItem => item !== undefined);
    const groups = bucket(items.map((item) => ({ item, score: 0 })));
    return recentItems.length > 0 ? [{ heading: RECENT_HEADING, items: recentItems }, ...groups] : groups;
  }
  const scored = items
    .map((item) => {
      const scores = [fuzzyScore(item.label, q), fuzzyScore(item.value, q), fuzzyScore(providerOf(item), q)].filter(
        (score): score is number => score !== null
      );
      return { item, score: scores.length > 0 ? Math.max(...scores) : null };
    })
    .filter((entry): entry is { item: ModelItem; score: number } => entry.score !== null)
    .sort((left, right) => right.score - left.score);
  return bucket(scored);
}

function bucket(entries: readonly { item: ModelItem; score: number }[]): ModelGroup[] {
  const groups = new Map<string, ModelItem[]>();
  for (const { item } of entries) {
    const key = providerOf(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups].map(([heading, items]) => ({ heading, items }));
}

/** 记一次「用过」：放到最前、去重、最多留 `limit` 个。 */
export function pushRecent(recent: readonly string[], value: string, limit = 5): string[] {
  return [value, ...recent.filter((entry) => entry !== value)].slice(0, limit);
}
