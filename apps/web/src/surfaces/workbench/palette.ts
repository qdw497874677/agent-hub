import type { IconName } from '../../atoms/icon-names.ts';

/** ⌘K 面板里的一条操作：名字、可选的分组和快捷键提示，回车或点击就执行。 */
export interface PaletteAction {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly icon?: IconName;
  /** 快捷键提示（只写确实生效的）。 */
  readonly keys?: string;
  /** 额外的搜索词（拼音缩写、英文名）。 */
  readonly keywords?: string;
  readonly run: () => void;
}

/** 动作按名字 / 关键词过滤；空查询时全给。纯函数，单测在 palette.test.ts。 */
export function filterActions(actions: readonly PaletteAction[], query: string): PaletteAction[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...actions];
  return actions.filter((action) => `${action.label} ${action.group} ${action.keywords ?? ''}`.toLowerCase().includes(q));
}
