/**
 * 「还在动」的 3×3 点阵：九个格子、一条余弦曲线、按反对角线错峰。
 *
 * 只用 opacity：没有任何一帧要重新布局或重绘版面，整块波形交给合成器。
 * 错峰用负 delay 实现——第一帧就已经在半路上了，不会先「攒一波再出发」。
 *
 * 帧函数、错峰延时、静止帧都在这里算好，DOM 只负责 animate()（见 wave.tsx）。
 */
export const WAVE_GRID = 3;
export const WAVE_CELLS = WAVE_GRID * WAVE_GRID;

/** 一个格子的完整周期（ms）：1.2s 既看得出在动，又不会快到来回闪。 */
export const WAVE_MS = 1200;

/** 一条曲线采多少个点。用 keyframes 采样而不是 CSS sin()，兼容性和可测性都更好。 */
export const WAVE_SAMPLES = 16;

/** 反对角线铺满一条波所需的时间跨几个周期：越大越像一道斜扫。 */
export const WAVE_SPREAD = 5.5;

/** 暗处与亮处的透明度：两头都不透明会糊成一块，全透明又像坏了。 */
export const WAVE_TROUGH = 0.2;
export const WAVE_CREST = 0.6;

export interface WaveFrame {
  /** 0..1 */
  readonly offset: number;
  readonly opacity: number;
}

/** 一帧的形状：`0.5 - 0.5*cos(t*2π)`，从暗处起、到亮处、再回暗处。 */
export function waveFrames(samples: number = WAVE_SAMPLES, trough: number = WAVE_TROUGH, crest: number = WAVE_CREST): readonly WaveFrame[] {
  return Array.from({ length: samples + 1 }, (_, i) => {
    const t = i / samples;
    const value = 0.5 - 0.5 * Math.cos(t * Math.PI * 2);

    return { offset: t, opacity: trough + (crest - trough) * value };
  });
}

/** 一个格子坐在第几条反对角线上（0..4）：左上角先亮，往右下推。 */
export function waveDiagonal(index: number): number {
  return Math.floor(index / WAVE_GRID) + (index % WAVE_GRID);
}

/**
 * 这个格子的负 delay（ms）：让它一上场就已经走到自己那条反对角线该在的位置。
 * 取模再减一个周期，`animation-delay` / `Animation.delay` 都吃负数。
 */
export function waveDelay(index: number, period: number = WAVE_MS, spread: number = WAVE_SPREAD): number {
  const lead = (waveDiagonal(index) / spread) * period;

  return (lead % period) - period;
}

/**
 * 不动画时停在哪一帧：波形在 t=0 那一刻的横截面，按反对角线取。
 * 静止也保留「斜着一道」的样子，而不是九个一样的点。
 */
export function waveRest(index: number, trough: number = WAVE_TROUGH, crest: number = WAVE_CREST): number {
  const t = (waveDiagonal(index) / WAVE_SPREAD) % 1;
  const value = 0.5 - 0.5 * Math.cos(t * Math.PI * 2);

  return Math.round((trough + (crest - trough) * value) * 1000) / 1000;
}
