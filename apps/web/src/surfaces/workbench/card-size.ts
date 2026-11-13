/**
 * 画布卡片的尺寸规则（纯函数，可单测）。
 * 领域只保证尺寸是正数；多大才「放得下内容」是视图的事，所以上下限放在这里。
 */
export type CardKind = 'task' | 'session';

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface SizeLimits {
  /** 没拖过大小时的宽度；高度跟着内容走。 */
  readonly defaultWidth: number;
  readonly minWidth: number;
  readonly minHeight: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
}

export const CARD_LIMITS: Readonly<Record<CardKind, SizeLimits>> = {
  // 会话卡最小要放得下「agent 名 + 状态位」一行、可调项一行、两三行输出和输入框
  session: { defaultWidth: 320, minWidth: 260, minHeight: 220, maxWidth: 960, maxHeight: 1200 },
  task: { defaultWidth: 220, minWidth: 180, minHeight: 96, maxWidth: 520, maxHeight: 420 }
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** 把拖出来的尺寸收进上下限并取整：存进库的值不该带着小数点后十几位。 */
export function clampSize(kind: CardKind, size: Size): Size {
  const limits = CARD_LIMITS[kind];
  return {
    width: Math.round(clamp(size.width, limits.minWidth, limits.maxWidth)),
    height: Math.round(clamp(size.height, limits.minHeight, limits.maxHeight))
  };
}

/** 居中、排版时要用的宽度：拖过就用拖过的，否则用默认。 */
export const cardWidth = (kind: CardKind, size: Size | undefined): number =>
  size?.width ?? CARD_LIMITS[kind].defaultWidth;
