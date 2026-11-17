import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { FOCUSABLE, isTopmost, modalStack as stack, trapTarget } from './focus-order.ts';

/**
 * 模态框的焦点规矩（WAI-ARIA dialog 模式）：
 * 打开时焦点进框，Tab / Shift+Tab 在框里循环，关掉后还给打开它的那个元素。
 *
 * 纯计算在 focus-order.ts（node:test 能测）；这里只放碰 DOM 的 hook。
 */

function focusables(panel: HTMLElement): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => !element.closest('[inert]') && (element.offsetParent !== null || element.getClientRects().length > 0)
  );
}

/**
 * 打开时先给谁：显式标了 data-autofocus 的 → 面板本身（读屏从标题念起，下一下 Tab 就是框里第一个控件）。
 * 不自动聚焦第一个输入框：有的输入框一聚焦就弹建议列表，进门就弹出东西反而吵。
 */
function initialTarget(panel: HTMLElement): HTMLElement {
  return panel.querySelector<HTMLElement>('[data-autofocus]') ?? panel;
}

export interface ModalFocusOptions {
  /** 打开时要不要把焦点挪进来（抽屉已经自己做了就传 false）。 */
  readonly initial?: boolean;
  /** 关掉时要不要还焦点（抽屉已经自己做了就传 false）。 */
  readonly restore?: boolean;
}

/**
 * 把一个面板变成真正的模态：焦点进框、Tab 不出框、关掉还焦点。
 * 返回 `isTop()`：Esc 之类的全局按键先问一句「我是不是最上面那层」。
 *
 * 框外弹出的浮层（模型选择器这类 portal 到 body 的 role=dialog）不拦：焦点在别的对话框里时，Tab 归它管。
 */
export function useModalFocus(panelRef: RefObject<HTMLElement | null>, options: ModalFocusOptions = {}): () => boolean {
  const idRef = useRef<symbol>(Symbol('modal'));
  const initial = options.initial ?? true;
  const restore = options.restore ?? true;

  useEffect(() => {
    const id = idRef.current;
    stack.push(id);
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!initial || !panel || panel.contains(document.activeElement)) return;
      initialTarget(panel).focus({ preventScroll: true });
    });
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !isTopmost(id)) return;
      const panel = panelRef.current;
      if (!panel) return;
      const active = document.activeElement;
      const inside = active instanceof Node && panel.contains(active);
      // 焦点在另一个（框外 portal 出来的）对话框里：那是它的地盘
      if (!inside && active instanceof HTMLElement && active.closest('[role="dialog"]') !== null) return;
      const list = focusables(panel);
      const current = inside ? list.indexOf(active as HTMLElement) : -1;
      const target = trapTarget(list.length, current, event.shiftKey);
      if (target === null) return;
      event.preventDefault();
      (target === -1 ? panel : list[target]!).focus({ preventScroll: true });
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKey, true);
      const at = stack.lastIndexOf(id);
      if (at >= 0) stack.splice(at, 1);
      if (restore && previous?.isConnected === true) previous.focus({ preventScroll: true });
    };
    // 只在挂载 / 卸载时跑：面板 ref 是稳定的
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return useCallback(() => isTopmost(idRef.current), []);
}
