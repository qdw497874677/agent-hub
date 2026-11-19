import { useEffect, useRef } from 'react';
import { reducedMotion } from '../shell/device.ts';
import { WAVE_CELLS, WAVE_MS, waveDelay, waveFrames, waveRest } from './wave-core.ts';

/** 采样一次就够：曲线是常量，不该每个实例各算一遍。 */
const FRAMES = waveFrames();
const KEYFRAMES = FRAMES.map((frame) => ({ offset: frame.offset, opacity: frame.opacity }));

/**
 * 「正在输出」旁边那九个点。
 *
 * 一行文案 + 一个在动的记号：读者要的只是「它还活着」，不需要学会分辨「在思考 / 在调工具 /
 * 在写字」三种旋转动画。所以形状不变，只有一条斜着走的波，说什么由文案负责（见 turn-progress.ts）。
 *
 * 装饰性元素，`aria-hidden`——读屏只听文案，不听九个点。
 * 用户要求减少动效时停在首帧：斜着一道，不是一坨静止的灰点。
 */
export function TurnWave({ className = '' }: { className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node || reducedMotion()) return;

    const animations = [...node.children].map((cell, index) =>
      (cell as HTMLElement).animate(KEYFRAMES, {
        // 负的 delay：一挂上就已经在自己那条反对角线该在的位置，不用先攒一波。
        delay: waveDelay(index),
        duration: WAVE_MS,
        easing: 'linear',
        iterations: Number.POSITIVE_INFINITY
      })
    );

    return () => {
      for (const animation of animations) animation.cancel();
    };
  }, []);

  return (
    <span
      ref={ref}
      aria-hidden="true"
      data-testid="turn-wave"
      className={`inline-grid shrink-0 grid-cols-3 gap-[2px] text-live ${className}`}
    >
      {Array.from({ length: WAVE_CELLS }, (_, index) => (
        <span
          key={index}
          className="size-[4px] rounded-[1px] bg-current"
          style={{ opacity: waveRest(index) }}
        />
      ))}
    </span>
  );
}
