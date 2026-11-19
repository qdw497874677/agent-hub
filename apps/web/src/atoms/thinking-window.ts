/**
 * 思考窗口的几何：遮罩怎么算、还藏着多少、跟随时从哪开始滑。
 *
 * 思考比答案长、来得比答案快，所以思考块不是一段越来越高的正文，而是一个**固定高度的窗口**：
 * 到了高度就停住，靠上下两条渐隐说「还有」，新的一行从底下接住、再滑上去。
 *
 * 这里只放能直接算的部分（遮罩字符串、隐藏量、动画起点），DOM 留在 chat-blocks.tsx 里。
 */

/** 窗口高度上限（px）：九行左右的 reasoning，够一口气读完，又不至于变成一段正文。 */
export const THINKING_MAX = 208;

/** 每一侧渐隐占的高度（px），也是渐隐张开所用的距离。 */
export const EDGE_FADE = 28;

/** 一次上滑的时长（ms）：够看清是「在动」而不是重绘，又短到下一行落地时它已经归位。 */
export const RISE_MS = 240;

/** 上滑的缓动，和仓库里其他「接住再回落」的动效同一条曲线。 */
export const RISE_EASING = 'cubic-bezier(0.23, 1, 0.32, 1)';

/** 离底部这么近仍算「在跟随」：亚像素布局让「正好到底」很少是真的 0。 */
export const FOLLOW_SLACK = 8;

/**
 * 两侧渐隐的遮罩。
 *
 * 每一侧只在自己背后真的藏了东西时才渐隐，且用掉的距离随隐藏量涨到 `fade` 为止：
 * 开头没有上面的内容、末尾没有下面的内容，那一侧就是硬的边——两态之间不会突然跳一下。
 * 传入 0 时算出的是 `black 0px` 紧贴边线，等价于没有渐变。
 */
export function edgeMask(above: number, below: number, fade: number = EDGE_FADE): string {
  const ramp = (hidden: number) => Math.round(Math.min(1, Math.max(0, hidden) / fade) * fade);

  return `linear-gradient(to bottom, rgb(0 0 0 / 0) 0, black ${ramp(above)}px, black calc(100% - ${ramp(below)}px), rgb(0 0 0 / 0) 100%)`;
}

/**
 * 窗口底下还藏着多少（px）。
 *
 * 用**布局高度**（`getBoundingClientRect().height`）算，不用 `scrollHeight`：
 * 上滑动画还在飞的时候，内容真的被 translate 到了窗口底边以下，浏览器把它算成 overflow，
 * 跟着 `scrollHeight` 走就是去追那个正在帮忙盖住位移的动画——越追越抖。
 */
export function hiddenBelow(layoutHeight: number, clientHeight: number, scrollTop: number): number {
  return Math.max(0, layoutHeight - clientHeight - scrollTop);
}

/**
 * 这一滑的起点：正在飞的那一滑还剩下多少 + 这次 pin 实际滚走的位移。
 * 接着上一滑的位置起步，快流就是一整条滑行，而不是每行顿一下。
 */
export function riseFrom(inFlight: number, moved: number): number {
  return inFlight + moved;
}

/**
 * 从 `getComputedStyle` 的 transform 里读正在进行的位移（px）。
 * 根 tsconfig 不带 DOM lib，所以不直接写 `DOMMatrixReadOnly`，从这里取。
 */
const matrixOf = globalThis as unknown as {
  DOMMatrixReadOnly?: new (transform: string) => { m42: number };
};

export function transformOffset(transform: string): number {
  const Matrix = matrixOf.DOMMatrixReadOnly;
  return transform === 'none' || Matrix === undefined ? 0 : new Matrix(transform).m42;
}
