import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { MENU_WIDTH, menuPosition, type SessionActionId, type SessionActionItem } from '../../atoms/session-actions.ts';

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
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, []);
  const position = menuPosition(anchor, items.length, { width: window.innerWidth, height: window.innerHeight });

  const onKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
      return;
    }
    if (event.key === 'Tab') {
      onClose(false);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const enabled = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    if (enabled.length === 0) return;
    const at = enabled.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? enabled.length - 1
          : event.key === 'ArrowDown'
            ? (at + 1) % enabled.length
            : (at - 1 + enabled.length) % enabled.length;
    enabled[next]?.focus();
  };

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[60]"
        onPointerDown={() => onClose(false)}
        onContextMenu={(event) => {
          event.preventDefault();
          onClose(false);
        }}
      />
      <div
        ref={menu}
        role="menu"
        aria-label="会话操作"
        data-testid="sidebar-session-menu"
        onKeyDown={onKey}
        className="fixed z-[61] flex flex-col rounded-lg border border-strong bg-overlay py-1 shadow-overlay"
        style={{ left: position.left, top: position.top, minWidth: MENU_WIDTH }}
      >
        {items.map((item) => (
          <button
            key={item.id}
            role="menuitem"
            data-testid={`sidebar-action-${item.id}`}
            title={item.hint}
            disabled={item.disabled}
            className={`flex min-h-11 items-center px-3 text-left text-sub outline-none disabled:opacity-40 pointer-fine:min-h-8 ${
              item.danger
                ? 'text-rust hover:bg-rust/10 focus-visible:bg-rust/10'
                : 'text-secondary hover:bg-hover hover:text-primary focus-visible:bg-hover focus-visible:text-primary'
            }`}
            onClick={() => onPick(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
    </>,
    document.body
  );
}
