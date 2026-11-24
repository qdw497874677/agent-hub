import { MenuShell, type MenuShellItem } from './menu-shell.tsx';

/**
 * 「⋯」菜单的通用壳：首页项目行、待办行共用。
 *
 * 为什么不是 hover 菜单：手指没有 hover，键盘也够不着。触发器永远是可见的 44px 按钮，
 * 菜单挂到 body（不被滚动区裁掉），打开即聚焦第一项，↑ / ↓ / Home / End 移动，
 * Esc 关掉并把焦点还给触发器，Tab 直接关。
 */
export type RowMenuItem = MenuShellItem;

const ROW_ITEM_CLASS =
  'flex min-h-[44px] items-center px-3 text-left text-sub outline-none disabled:opacity-40';

export function RowMenu({
  label,
  items,
  anchor,
  onPick,
  onClose,
  testId
}: {
  label: string;
  items: readonly RowMenuItem[];
  anchor: { readonly x: number; readonly y: number };
  onPick(id: string): void;
  /** refocus：Esc 关掉时把焦点还回去；点外面关掉时不抢焦点。 */
  onClose(refocus: boolean): void;
  testId?: string;
}) {
  return (
    <MenuShell
      label={label}
      items={items}
      anchor={anchor}
      onPick={onPick}
      onClose={onClose}
      testId={testId}
      itemClassName={ROW_ITEM_CLASS}
      itemTestId={(id) => (testId === undefined ? undefined : `${testId}-${id}`)}
    />
  );
}
