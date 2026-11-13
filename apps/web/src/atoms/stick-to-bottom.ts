/** 离底部多近算「在底部」：留一点余量，免得差一两像素就不跟了。 */
export const NEAR_BOTTOM_PX = 80;

export interface ScrollMetrics {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

export function isNearBottom(metrics: ScrollMetrics, threshold = NEAR_BOTTOM_PX): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;
}
