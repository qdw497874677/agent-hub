/**
 * 手机上弹出的软键盘只改 `visualViewport`，不改布局视口：`100dvh` 还是整屏高，
 * 于是 shell 依然排到键盘底下，输入框落到看不见的地方，人得把整页滑到底才找得着（Android Chrome 上一直如此）。
 *
 * 做法：把「真正看得见的那一块」量出来写进 CSS 变量，shell 按它排版；
 * 页面本身不再能滚（styles.css 里 `html, body { overflow: hidden }`），
 * 于是唯一的滚动容器只剩消息列表，键盘弹出、收起、地址栏伸缩都只是这个变量的变化。
 */
export interface VisibleViewport {
  readonly height: number;
  readonly offsetTop: number;
}

/** 超过这个缩放比就当用户双指放大了：那时候 visualViewport.height 只是「放大后看到的一小块」。 */
const MAX_TRUSTED_SCALE = 1.01;

/**
 * 换算成排版用的高度与上移量。
 * - 不认识 `visualViewport`（老浏览器、测试环境）时退回布局视口高度，和以前的 `100dvh` 一致。
 * - 双指放大时不跟着缩：照着缩会把整页挤成一条，而且那时候浏览器本来就在裁。
 * - 只往小里收，不往大里放：缩小页面（scale < 1）时 visualViewport 会比布局视口还高，
 *   照着排会把 shell 排到文档外面去，还是按老行为算整屏最稳。
 * - `offsetTop` 是浏览器为了露出输入框把文档顶上去的距离，折算进去，顶部 header 才不会被裁掉半截。
 */
export function visibleViewport(
  viewport: { readonly height: number; readonly offsetTop?: number; readonly scale?: number } | null,
  layoutHeight: number,
  scaleLimit: number = MAX_TRUSTED_SCALE
): VisibleViewport {
  const layout = Number.isFinite(layoutHeight) && layoutHeight > 0 ? layoutHeight : 0;
  if (viewport === null || !Number.isFinite(viewport.height) || viewport.height <= 0) {
    return { height: layout, offsetTop: 0 };
  }
  const scale = viewport.scale ?? 1;
  if (!Number.isFinite(scale) || scale > scaleLimit) return { height: layout, offsetTop: 0 };
  // 布局视口量不到时（测试环境）就信 visualViewport，总比把整页压成 0 强。
  const height = layout > 0 ? Math.min(viewport.height, layout) : viewport.height;
  return { height, offsetTop: Math.max(0, viewport.offsetTop ?? 0) };
}

/**
 * 把可见视口写进 `--app-height` / `--app-offset`，并在键盘把文档顶上去时归位。
 * 返回解绑函数（测试与热重载用得上）。
 *
 * 触发时机：`visualViewport.resize`（键盘弹起/收起、地址栏伸缩）、`visualViewport.scroll`（浏览器滚动可视区）、
 * `window.resize`（转屏、桌面改窗口）。写的是整数像素：亚像素抖动会让整棵树反复重排。
 */
interface ViewportLike {
  readonly height: number;
  readonly offsetTop: number;
  readonly scale: number;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/**
 * 只用得到这几个成员，按结构声明而不是写 `Window`/`Document`：
 * 本文件被单测直接 import，会落进根 tsconfig（没有 DOM lib）。
 */
interface WatchTarget {
  readonly visualViewport?: ViewportLike | null;
  readonly innerHeight: number;
  readonly scrollY: number;
  scrollTo(x: number, y: number): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

interface WatchDocument {
  readonly documentElement: {
    readonly style: { setProperty(name: string, value: string): void };
    readonly scrollTop: number;
  };
}

export function watchVisibleViewport(target: WatchTarget, doc: WatchDocument): () => void {
  const viewport = target.visualViewport ?? null;
  const style = doc.documentElement.style;
  let written = '';

  const apply = (): void => {
    const metrics = visibleViewport(
      viewport === null ? null : { height: viewport.height, offsetTop: viewport.offsetTop, scale: viewport.scale },
      target.innerHeight
    );
    const next = `${Math.round(metrics.height)}:${Math.round(metrics.offsetTop)}`;
    if (next !== written) {
      written = next;
      style.setProperty('--app-height', `${Math.round(metrics.height)}px`);
      style.setProperty('--app-offset', `${Math.round(metrics.offsetTop)}px`);
    }
    // 页面本来就不该滚：被键盘顶起来过就归位，header 和输入框都还在可视区里。
    if (target.scrollY !== 0 || doc.documentElement.scrollTop !== 0) target.scrollTo(0, 0);
  };

  apply();
  viewport?.addEventListener('resize', apply);
  viewport?.addEventListener('scroll', apply);
  target.addEventListener('resize', apply);
  target.addEventListener('orientationchange', apply);
  return () => {
    viewport?.removeEventListener('resize', apply);
    viewport?.removeEventListener('scroll', apply);
    target.removeEventListener('resize', apply);
    target.removeEventListener('orientationchange', apply);
  };
}
