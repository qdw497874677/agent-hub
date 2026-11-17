/**
 * 模态框焦点的纯计算部分（下一个该聚焦谁、谁算最上层）：不碰 DOM，node:test 直接测。
 * DOM 部分在 focus-trap.ts 的 hook 里。
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
export const modalStack: symbol[] = [];

export function isTopmost(id: symbol, list: readonly symbol[] = modalStack): boolean {
  return list.length > 0 && list[list.length - 1] === id;
}
