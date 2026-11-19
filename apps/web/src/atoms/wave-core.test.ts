import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WAVE_CELLS,
  WAVE_CREST,
  WAVE_MS,
  WAVE_SAMPLES,
  WAVE_SPREAD,
  WAVE_TROUGH,
  waveDelay,
  waveDiagonal,
  waveFrames,
  waveRest
} from './wave-core.ts';

test('九个格子，每条反对角线都是左上往右下推', () => {
  assert.equal(WAVE_CELLS, 9);
  assert.deepEqual(
    Array.from({ length: WAVE_CELLS }, (_, i) => waveDiagonal(i)),
    [0, 1, 2, 1, 2, 3, 2, 3, 4]
  );
});

test('帧是余弦：从暗处起、中间最亮、回暗处，两端对齐', () => {
  const frames = waveFrames();

  assert.equal(frames.length, WAVE_SAMPLES + 1);
  const first = frames[0];
  const last = frames.at(-1);
  assert.ok(first !== undefined && last !== undefined);
  assert.equal(first.offset, 0);
  assert.equal(last.offset, 1);
  assert.equal(first.opacity, WAVE_TROUGH);
  assert.equal(last.opacity, WAVE_TROUGH);
  const mid = frames[WAVE_SAMPLES / 2];
  assert.ok(mid !== undefined);
  assert.ok(Math.abs(mid.opacity - WAVE_CREST) < 1e-9);
  // 中途不越界。
  for (const frame of frames) {
    assert.ok(frame.opacity >= WAVE_TROUGH - 1e-9 && frame.opacity <= WAVE_CREST + 1e-9);
  }
});

test('错峰用负 delay：一上场就在半路上，不用先攒一波', () => {
  for (let i = 0; i < WAVE_CELLS; i += 1) {
    const delay = waveDelay(i);
    assert.ok(delay < 0 && delay >= -WAVE_MS);
  }
  // 左上角从周期起点开始，最远的那条反对角线落后它 4/5.5 个周期。
  assert.equal(waveDelay(0), -WAVE_MS);
  assert.ok(Math.abs(waveDelay(8) - ((4 / WAVE_SPREAD) * WAVE_MS - WAVE_MS)) < 1e-6);
});

test('错峰按反对角线分组：一条斜线上九个格子里同一条线的 delay 相同', () => {
  assert.equal(waveDelay(1), waveDelay(3));
  assert.equal(waveDelay(2), waveDelay(4));
  assert.equal(waveDelay(5), waveDelay(7));
  assert.notEqual(waveDelay(0), waveDelay(1));
});

test('静止帧：斜着一道，不是九个一样的点', () => {
  assert.ok(Math.abs(waveRest(0) - WAVE_TROUGH) < 1e-9);
  // 对角线的尽头（右下角）最亮：0.2 + 0.4 * (0.5 - 0.5*cos(2π*4/5.5))。
  assert.ok(Math.abs(waveRest(8) - 0.428) < 0.002);
  assert.ok(waveRest(8) > waveRest(0));
  // 静止时同一条反对角线亮度一致。
  assert.equal(waveRest(1), waveRest(3));
});
