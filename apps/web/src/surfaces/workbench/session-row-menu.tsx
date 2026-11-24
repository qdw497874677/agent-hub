import { MenuShell } from '../../atoms/menu-shell.tsx';
import type { SessionActionId, SessionActionItem } from '../../atoms/session-actions.ts';

const SESSION_ITEM_CLASS =
  'flex min-h-11 items-center px-3 text-left text-sub outline-none disabled:opacity-40 pointer-fine:min-h-8';

/**
 * 侧栏会话行的操作菜单（「⋯」和右键共用）。挂到 body 上，不被侧栏的滚动区裁掉，也压得住手机抽屉。
 * 键盘：打开即聚焦第一项，↑ / ↓ / Home / End 移动，Esc 关掉并把焦点还给触发它的按钮，Tab 直接关。
 */
export function SessionRowMenu({
  items,
  anchor,
  onPick,
  onClose
}: {
  readonly items: readonly SessionActionItem[];
  readonly anchor: { readonly x: number; readonly y: number };
  readonly onPick: (id: SessionActionId) => void;
  /** refocus：Esc 关掉时把焦点还回去；点外面关掉时不抢焦点。 */
  readonly onClose: (refocus: boolean) => void;
}) {
  return (
    <MenuShell<SessionActionId>
      label="会话操作"
      items={items}
      anchor={anchor}
      onPick={onPick}
      onClose={onClose}
      testId="sidebar-session-menu"
      itemClassName={SESSION_ITEM_CLASS}
      itemTestId={(id) => `sidebar-action-${id}`}
    />
  );
}
