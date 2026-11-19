/**
 * 输入框长到哪儿为止。
 *
 * 输入框跟着内容长高，长到上限就自己滚：输入框总是贴在窗口底部，草稿长到占满一屏时，
 * 如果不封顶，看到的就是「自己写的那行跑到屏幕外面去了」。
 *
 * 规则只有一句：`wanted = max(scrollHeight, floor)`，`height = min(wanted, max)`，
 * 只有内容真的超过上限才让它可以滚。`scrollHeight` 本身含 textarea 的 padding，
 * 所以直接当高度用、不要再减一次（减了每换一行就短一截，越写越矮）。
 *
 * 纯函数放这里，node:test 能直接夹边界。
 */
export interface FieldSize {
  /** 写进 `style.height` 的像素值。 */
  readonly height: number;
  /** 内容超过上限才滚动，否则藏起来——矮的时候出一条滚动条是噪音。 */
  readonly overflowY: 'auto' | 'hidden';
}

export interface GrowInput {
  /** `scrollHeight`：内容高度（已含 padding）。 */
  readonly scrollHeight: number;
  /** 下限：一行的高度（含 padding），小于它的内容不该把盒子压扁。 */
  readonly floor: number;
  /** 上限：再长就滚。 */
  readonly max: number;
}

/**
 * 要写多少高、要不要滚。
 *
 * 注意 `overflowY` 看的是 `scrollHeight > max`（内容本身超没超），不是 `height > max`：
 * 高度被夹住之后两者不再相等，拿夹过的值判断就永远滚不起来。
 */
export function growField({ scrollHeight, floor, max }: GrowInput): FieldSize {
  const wanted = Math.max(scrollHeight, floor);

  return {
    height: Math.min(wanted, max),
    overflowY: scrollHeight > max ? 'auto' : 'hidden'
  };
}
