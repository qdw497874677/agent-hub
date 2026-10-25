import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CARD_LIMITS, cardWidth, clampSize } from './card-size.ts';

test('尺寸被收进上下限并取整', () => {
  assert.deepEqual(clampSize('session', { width: 10, height: 99999 }), {
    width: CARD_LIMITS.session.minWidth,
    height: CARD_LIMITS.session.maxHeight
  });
  assert.deepEqual(clampSize('task', { width: 300.6, height: 150.2 }), { width: 301, height: 150 });
});

test('没拖过大小时用默认宽度', () => {
  assert.equal(cardWidth('session', undefined), 320);
  assert.equal(cardWidth('task', { width: 400, height: 200 }), 400);
});
