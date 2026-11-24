import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { MENU_WIDTH, menuPosition } from './session-actions.ts';

/**
 * 「⋯」菜单的共用壳：行菜单（首页项目 / 待办 / 列表）和侧栏会话菜单只共用行为，不共用外观。
 *
 * 为什么不是 hover 菜单：手指没有 hover，键盘也够不着。菜单挂到 body（不被滚动区裁掉），
 * 打开即聚焦第一项，↑ / ↓ / Home / End 移动，Esc 关掉并把焦点还给触发器，Tab 直接关。
 *
 * 这里只渲染菜单本身，不渲染触发器，也不定义触发器的尺寸（触控目标由各调用方自己的按钮保证）。
 * 各菜单的标签、testid、菜单项外观由调用方给，这里只管键盘、聚焦、定位和关闭。
 */
export interface MenuShellItem<Id extends string = string> {
  readonly id: Id;
  readonly label: string;
  /** 悬停提示：禁用时写原因。 */
  readonly hint?: string;
  readonly danger?: boolean;
  readonly disabled?: boolean;
}

export function MenuShell<Id extends string>({
  label,
  items,
  anchor,
  onPick,
  onClose,
  testId,
  itemClassName,
  itemTestId
}: {
  label: string;
  items: readonly MenuShellItem<Id>[];
  anchor: { readonly x: number; readonly y: number };
  onPick(id: Id): void;
  /** refocus：Esc 关掉时把焦点还回去；点外面关掉时不抢焦点。 */
  onClose(refocus: boolean): void;
  testId?: string;
  /** 菜单项外观（高度、内边距、字号）；颜色随 danger 在壳里统一给。 */
  itemClassName: string;
  itemTestId(id: Id): string | undefined;
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
            data-testid={itemTestId(item.id)}
            title={item.hint}
            disabled={item.disabled}
            className={`${itemClassName} ${
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
