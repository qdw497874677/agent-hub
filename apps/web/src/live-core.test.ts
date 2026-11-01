import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyBlocks, multipleAuthors, applyFrame, cardBlocks, waitingForReply, catchUp, forkBlockedHint, inheritedBlocks, resolveLive, withFullHistory, type LiveMap } from './live-core.ts';
import { STALL_NOTICE_MARKER } from '@agent-hub/contract/stall';

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

test('卡顿提醒挂在末尾，来了新输出就撤掉', () => {
  const stalled = applyBlocks(
    [{ kind: 'text', text: '在想', seq: 1 }],
    { kind: 'diagnostic', level: 'warn', text: `${STALL_NOTICE_MARKER}：已经 5 分钟没有新输出` },
    2
  );
  assert.equal(stalled[stalled.length - 1]?.kind, 'stall');
  const resumed = applyBlocks(stalled, { kind: 'text', delta: '……好了' }, 3);
  assert.deepEqual(resumed, [{ kind: 'text', text: '在想……好了', seq: 3 }]);
  const other = applyBlocks(resumed, { kind: 'diagnostic', level: 'info', text: '别的诊断' }, 4);
  assert.equal(other, resumed);
});

test('这一轮失败：原因作为一块进对话，完成/停止不进', () => {
  const failed = applyBlocks([], { kind: 'ended', outcome: 'failed', reason: '模型调用失败：API key 已过期' }, 2);
  assert.deepEqual(failed, [{ kind: 'error', text: '模型调用失败：API key 已过期', seq: 2 }]);
  assert.deepEqual(applyBlocks([], { kind: 'ended', outcome: 'done' }, 2), []);
  assert.deepEqual(applyBlocks([], { kind: 'ended', outcome: 'stopped' }, 2), []);
});

type SessionDto = Parameters<typeof withFullHistory>[1];
type JournalEntryDto = Parameters<typeof withFullHistory>[2][number];

test('打开对话换上整段历史：投影被思考 delta 挤满时正文也在；内存更新时不倒退', () => {
  const session = { id: 's1', status: 'done', lastSeq: 40 } as unknown as SessionDto;
  const entries: JournalEntryDto[] = [
    { seq: 1, at: '', event: { kind: 'prompt', text: '只回复两个字' } },
    ...Array.from({ length: 30 }, (_, i) => ({ seq: i + 2, at: '', event: { kind: 'thinking' as const, delta: 'x' } })),
    { seq: 32, at: '', event: { kind: 'text', delta: '好的' } },
    { seq: 33, at: '', event: { kind: 'ended', outcome: 'done' } }
  ] as unknown as JournalEntryDto[];
  const map = withFullHistory({}, session, entries);
  const kinds = map['s1']?.blocks.map((block) => block.kind);
  assert.deepEqual(kinds, ['prompt', 'thinking', 'text']);
  assert.equal(map['s1']?.lastSeq, 33);
  const newer = { s1: { blocks: [], status: 'running', lastSeq: 50, reason: null, awaiting: true } } as unknown as LiveMap;
  assert.equal(withFullHistory(newer, session, entries), newer);
});

test('运行失败只来了诊断和状态帧（没有 ended）：不再等回复，输入框回到「发送」', () => {
  let map: LiveMap = {};
  map = applyFrame(map, { sessionId: 's', seq: 1, event: { kind: 'prompt', text: '你好' }, status: 'running' } as never);
  assert.equal(map['s']?.awaiting, true);
  map = applyFrame(map, { sessionId: 's', seq: 2, event: { kind: 'diagnostic', level: 'error', text: '不在允许的目录里' }, status: 'running' } as never);
  assert.equal(map['s']?.awaiting, true);
  map = applyFrame(map, { sessionId: 's', seq: 2, event: null, status: 'failed' });
  assert.equal(map['s']?.awaiting, false);
  assert.equal(map['s']?.status, 'failed');
});

test('ended(failed) 之后又补来一条诊断（进程退出）：仍不算在等回复，刷新后也一样', () => {
  let map: LiveMap = {};
  map = applyFrame(map, { sessionId: 's', seq: 1, event: { kind: 'prompt', text: '你好' }, status: 'running' } as never);
  map = applyFrame(map, { sessionId: 's', seq: 2, event: { kind: 'ended', outcome: 'failed', reason: 'Pi 退出码 -2' }, status: 'failed' } as never);
  map = applyFrame(map, { sessionId: 's', seq: 3, event: { kind: 'diagnostic', level: 'error', text: 'Pi 进程已退出' }, status: 'failed' } as never);
  assert.equal(map['s']?.awaiting, false, '会话已失败，最后一条是诊断也不该再显示「中断」');

  const entries = [
    { seq: 1, at: 1, event: { kind: 'prompt', text: '你好' } },
    { seq: 2, at: 2, event: { kind: 'ended', outcome: 'failed', reason: 'Pi 退出码 -2' } },
    { seq: 3, at: 3, event: { kind: 'diagnostic', level: 'error', text: 'Pi 进程已退出' } }
  ] as never;
  const session = { id: 's', status: 'failed', lastSeq: 3 } as never;
  assert.equal(resolveLive(session, entries, undefined)?.awaiting, false, '刷新页面后从历史播种');
});

test('失败过的会话再问一句：库里状态仍是 failed，但 agent 在回，输入框要显示「中断」', () => {
  let map: LiveMap = {};
  map = applyFrame(map, { sessionId: 's', seq: 5, event: { kind: 'ended', outcome: 'failed', reason: '上一轮失败' }, status: 'failed' } as never);
  map = applyFrame(map, { sessionId: 's', seq: 6, event: { kind: 'prompt', text: '再试一次' }, status: 'failed' } as never);
  assert.equal(map['s']?.awaiting, true);
  map = applyFrame(map, { sessionId: 's', seq: 6, event: null, status: 'running' });
  map = applyFrame(map, { sessionId: 's', seq: 7, event: { kind: 'diagnostic', level: 'info', text: '重新拉起 agent' }, status: 'running' } as never);
  assert.equal(map['s']?.awaiting, true, '诊断不结束这一轮');
  map = applyFrame(map, { sessionId: 's', seq: 8, event: { kind: 'ended', outcome: 'done' }, status: 'done' } as never);
  assert.equal(map['s']?.awaiting, false);
});

test('分叉页：来源历史截到分叉点，之后来源说的不混进来', () => {
  const entries = [
    { seq: 1, event: { kind: 'prompt', text: '问' } },
    { seq: 2, event: { kind: 'text', delta: '答' } },
    { seq: 3, event: { kind: 'prompt', text: '分叉之后来源又问' } }
  ] as unknown as Parameters<typeof inheritedBlocks>[0];
  const blocks = inheritedBlocks(entries, 2);
  assert.deepEqual(blocks.map((block) => block.kind), ['prompt', 'text']);
});

test('「分叉」：没内容、这一轮在跑、agent 不支持时点不了，并说明原因', () => {
  assert.equal(forkBlockedHint({ lastSeq: 3, turnRunning: false, denied: false }), null);
  assert.match(forkBlockedHint({ lastSeq: 0, turnRunning: false, denied: false }) ?? '', /还没有内容/);
  assert.match(forkBlockedHint({ lastSeq: 3, turnRunning: true, denied: false }) ?? '', /还在进行/);
  assert.match(forkBlockedHint({ lastSeq: 3, turnRunning: false, denied: true }) ?? '', /不支持/);
});

test('画布卡片：用户的话和 agent 的回复都显示，只省掉思考', () => {
  const blocks = [
    { kind: 'prompt', text: '你好', attachments: [], seq: 1 },
    { kind: 'thinking', text: '想', seq: 2 },
    { kind: 'text', text: '在', seq: 3 }
  ] as unknown as Parameters<typeof cardBlocks>[0];
  assert.deepEqual(cardBlocks(blocks).map((block) => block.kind), ['prompt', 'text']);
});

test('等回复：会话已经完成 / 停止 / 中断时不再挂「■ 停下」，失败后再问仍算在等', () => {
  assert.equal(waitingForReply({ awaiting: true }, 'running'), true);
  assert.equal(waitingForReply({ awaiting: true }, 'done'), false);
  assert.equal(waitingForReply({ awaiting: true }, 'stopped'), false);
  assert.equal(waitingForReply({ awaiting: true }, 'interrupted'), false);
  assert.equal(waitingForReply({ awaiting: true }, 'failed'), true);
  assert.equal(waitingForReply({ awaiting: false }, 'running'), false);
  assert.equal(waitingForReply(null, 'running'), false);
});

test('prompt 带上作者；只有一个人说过话时不显示作者，老消息（不知道是谁）不算人头', () => {
  const a = { id: 'u1', name: 'David' };
  const b = { id: 'u2', name: 'Lin' };
  let blocks = applyBlocks([], { kind: 'prompt', text: '老消息' }, 1);
  blocks = applyBlocks(blocks, { kind: 'prompt', text: 'hi', author: a }, 2);
  assert.deepEqual(blocks[1], { kind: 'prompt', text: 'hi', attachments: [], author: a, seq: 2 });
  assert.equal(multipleAuthors(blocks), false);
  blocks = applyBlocks(blocks, { kind: 'prompt', text: 'again', author: a }, 3);
  assert.equal(multipleAuthors(blocks), false);
  blocks = applyBlocks(blocks, { kind: 'prompt', text: 'me too', author: b }, 4);
  assert.equal(multipleAuthors(blocks), true);
});

test('结果未知：interrupted + outcome_unknown → 交给人的 unknown 块，带上一条用户输入', () => {
  let blocks = applyBlocks([], { kind: 'prompt', text: '改一下 README' }, 1);
  blocks = applyBlocks(blocks, { kind: 'text', delta: '好的' }, 2);
  blocks = applyBlocks(blocks, { kind: 'ended', outcome: 'interrupted', reason: 'Hermes 这一轮的结果未知（outcome_unknown）' }, 3);
  assert.deepEqual(blocks[blocks.length - 1], { kind: 'unknown', text: 'Hermes 这一轮的结果未知（outcome_unknown）', prompt: '改一下 README', seq: 3 });
  // 普通中断不出卡片
  assert.deepEqual(applyBlocks([], { kind: 'ended', outcome: 'interrupted', reason: '用户中断' }, 2), []);
});
