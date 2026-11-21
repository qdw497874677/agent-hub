import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { MENU_WIDTH, menuPosition } from './session-actions.ts';

/**
 * 「⋯」菜单的通用壳：首页项目行、待办行共用。
 *
 * 为什么不是 hover 菜单：手指没有 hover，键盘也够不着。触发器永远是可见的 44px 按钮，
 * 菜单挂到 body（不被滚动区裁掉），打开即聚焦第一项，↑ / ↓ / Home / End 移动，
 * Esc 关掉并把焦点还给触发器，Tab 直接关。
 */
export interface RowMenuItem {
  readonly id: string;
  readonly label: string;
  /** 悬停提示：禁用时写原因。 */
  readonly hint?: string;
  readonly danger?: boolean;
  readonly disabled?: boolean;
}

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
        aria-label={label}
        data-testid={testId}
        onKeyDown={onKey}
        className="fixed z-[61] flex flex-col rounded-lg border border-strong bg-overlay py-1 shadow-overlay"
        style={{ left: position.left, top: position.top, minWidth: MENU_WIDTH }}
      >
        {items.map((item) => (
          <button
            key={item.id}
            role="menuitem"
            data-testid={testId === undefined ? undefined : `${testId}-${item.id}`}
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
