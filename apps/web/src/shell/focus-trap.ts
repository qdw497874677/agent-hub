import { useCallback, useEffect, useRef, type RefObject } from 'react';

/**
 * 模态框的焦点规矩（WAI-ARIA dialog 模式）：
 * 打开时焦点进框，Tab / Shift+Tab 在框里循环，关掉后还给打开它的那个元素。
 *
 * 纯计算（下一个该聚焦谁、谁算最上层）放在这里，node:test 能测；DOM 只在 hook 里碰。
 */

/** 能被 Tab 走到的元素（disabled、tabindex=-1、隐藏的不算，由调用方再按可见性过滤）。 */
export const FOCUSABLE =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

/**
 * 在框里按 Tab：返回该去的下标；返回 null 表示交给浏览器默认行为（框里中间位置，正常前进即可）。
 * - 框里一个能聚焦的都没有：留在面板本身（-1）。
 * - 焦点不在框里的可聚焦元素上（比如在面板本身）：Tab 去第一个，Shift+Tab 去最后一个。
 * - 在最后一个按 Tab 回到第一个；在第一个按 Shift+Tab 去最后一个。
 */
export function trapTarget(count: number, current: number, backwards: boolean): number | null {
  if (count === 0) return -1;
  if (current < 0) return backwards ? count - 1 : 0;
  if (!backwards && current === count - 1) return 0;
  if (backwards && current === 0) return count - 1;
  return null;
}

/** 打开着的模态框，后开的在最后：只有最上面那一个管 Tab 和 Esc，别一个按键关两层。 */
const stack: symbol[] = [];

export function isTopmost(id: symbol, list: readonly symbol[] = stack): boolean {
  return list.length > 0 && list[list.length - 1] === id;
}

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
