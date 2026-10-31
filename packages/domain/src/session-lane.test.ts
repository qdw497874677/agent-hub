import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionLane } from './session-lane.ts';
import type { SessionId } from './ids.ts';

test('会话投递闸：同一会话串行，不同会话不互相等；一段抛错不卡住后面', async () => {
  const lane = createSessionLane();
  const order: string[] = [];
  const s = 's1' as SessionId;
  const slow = lane.run(s, async () => { await new Promise((r) => setTimeout(r, 20)); order.push('a'); });
  const failing = lane.run(s, async () => { order.push('b'); throw new Error('x'); });
  const other = lane.run('s2' as SessionId, async () => void order.push('other'));
  const after = lane.run(s, async () => void order.push('c'));
  await Promise.allSettled([slow, failing, other, after]);
  assert.deepEqual(order, ['other', 'a', 'b', 'c']);
});
