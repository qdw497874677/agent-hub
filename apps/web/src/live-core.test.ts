import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFrame, catchUp, type LiveMap } from './live-core.ts';

const base: LiveMap = {
  s1: { blocks: [{ kind: 'prompt', text: '嗨', attachments: [], seq: 1 }], status: 'running', lastSeq: 1, reason: null, awaiting: true }
};

test('旧帧被丢弃，新帧追加并推进游标', () => {
  assert.equal(applyFrame(base, { sessionId: 's1', seq: 1, event: { kind: 'prompt', text: '嗨' }, status: 'running' }), base);
  const next = applyFrame(base, { sessionId: 's1', seq: 2, event: { kind: 'text', delta: '你好' }, status: 'running' });
  assert.equal(next.s1?.lastSeq, 2);
  assert.deepEqual(next.s1?.blocks.at(-1), { kind: 'text', text: '你好', seq: 2 });
});

test('状态帧不推进游标，否则同 seq 的事件会被当成旧帧丢掉', () => {
  const next = applyFrame(base, { sessionId: 's1', seq: 2, event: null, status: 'done' });
  assert.equal(next.s1?.lastSeq, 1);
  assert.equal(next.s1?.status, 'done');
});

test('断线补帧：after=lastSeq 的历史被重放，与重连后的实时帧交错也不重复', () => {
  const live = applyFrame(base, { sessionId: 's1', seq: 3, event: { kind: 'text', delta: 'B' }, status: 'running' });
  // 断线期间漏了 seq 2，重连后补回 2、3、4（3 已经由实时帧送到）
  const caught = catchUp(base, 's1', [
    { seq: 2, at: 0, event: { kind: 'text', delta: 'A' } },
    { seq: 3, at: 0, event: { kind: 'text', delta: 'B' } },
    { seq: 4, at: 0, event: { kind: 'ended', outcome: 'done' } }
  ]);
  assert.deepEqual(caught.s1?.blocks.at(-1), { kind: 'text', text: 'AB', seq: 3 });
  assert.equal(caught.s1?.status, 'done');
  assert.equal(caught.s1?.awaiting, false);
  // 实时帧先到的情况：补帧里 ≤ lastSeq 的被跳过
  const after = catchUp(live, 's1', [{ seq: 3, at: 0, event: { kind: 'text', delta: 'B' } }]);
  assert.equal(after, live);
});

test('没播种过的会话不补帧（画布刷新会带回它）', () => {
  assert.equal(catchUp(base, 'zz', [{ seq: 1, at: 0, event: { kind: 'text', delta: 'x' } }]), base);
});

test('带附件的提问：附件元数据跟着 prompt 块走', () => {
  const attachments = [{ kind: 'image' as const, name: 'a.png', path: '.agent-hub/attachments/s1/a.png' }];
  const next = applyFrame(base, {
    sessionId: 's1',
    seq: 2,
    event: { kind: 'prompt', text: '', attachments },
    status: 'running'
  });
  assert.deepEqual(next.s1?.blocks.at(-1), { kind: 'prompt', text: '', attachments, seq: 2 });
});
