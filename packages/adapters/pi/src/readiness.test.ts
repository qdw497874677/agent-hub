import { test } from 'node:test';
import assert from 'node:assert/strict';
import { piReadiness } from './readiness.ts';

test('piReadiness：没装 = 未安装', async () => {
  assert.deepEqual((await piReadiness('/nonexistent/pi-xyz').probe()).readiness, { state: 'unavailable', reason: '未安装' });
});
