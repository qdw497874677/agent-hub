import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isProjectableEntry, lastJournalSeq, projectEvents } from './projection.ts';

test('projectEvents：nextAfter 取本窗最后一条原始 seq，投影为空也前进', () => {
  const onlyHidden = [
    { seq: 1, at: 1, event: { kind: 'prompt', text: 'hi' } },
    { seq: 4, at: 2, event: { kind: 'thinking', text: '…' } }
  ];
  const empty = projectEvents(onlyHidden, 0);
  assert.deepEqual(empty.events, []);
  assert.equal(empty.nextAfter, 4);
  assert.equal(isProjectableEntry(onlyHidden[0]), false);
  assert.equal(isProjectableEntry({ seq: 5, event: { kind: 'text', delta: 'ok' } }), true);

  const mixed = projectEvents(
    [
      { seq: 1, at: 1, event: { kind: 'thinking', text: '…' } },
      { seq: 2, at: 2, event: { kind: 'text', delta: '你好' } },
      { seq: 7, at: 3, event: { kind: 'prompt', text: 'x' } }
    ],
    0
  );
  assert.deepEqual(mixed.events.map((e) => e.event), [{ kind: 'text', text: '你好' }]);
  assert.equal(mixed.nextAfter, 7);

  const none = projectEvents([], 3);
  assert.deepEqual(none.events, []);
  assert.equal(none.nextAfter, 3);
  assert.equal(lastJournalSeq([], 3), 3);

  const scanned = projectEvents([], 0, 12);
  assert.equal(scanned.nextAfter, 12);
});

test('projection allow-list suppresses private fields and preserves uncertainty without inventing outcomes', () => {
  const secret = 'SYNTHETIC_PRIVATE';
  const projected = projectEvents([
    null,
    { seq: 1, at: 1, event: { kind: 'prompt', text: secret } },
    { seq: 2, at: 2, event: { kind: 'thinking', text: secret } },
    { seq: 3, at: 3, event: { kind: 'approval', details: secret } },
    { seq: 4, at: 4, turn: 2, extra: secret, event: { kind: 'text', delta: 'visible', extra: secret } },
    { seq: 5, at: 5, event: { kind: 'diagnostic', level: secret, text: secret } },
    { seq: 6, at: 6, event: { kind: 'ended', outcome: 'interrupted', reason: `legacy outcome_unknown ${secret}` } },
    { seq: 7, at: 7, event: { kind: 'ended', outcome: 'done', outcomeUnknown: true, reason: secret } },
    { seq: 8, at: 8, event: { kind: 'ended', outcome: secret, outcomeUnknown: false } },
    { seq: 9, at: 9, event: { kind: 'ended' } },
    { seq: 10, at: 10, event: { kind: 'tool_result', name: {}, ok: secret, output: secret } }
  ]);
  assert.doesNotMatch(JSON.stringify(projected), /SYNTHETIC_PRIVATE/);
  assert.deepEqual(projected.events.map((e) => e.event), [
    { kind: 'text', text: 'visible' },
    { kind: 'diagnostic', level: 'info', text: '诊断细节已省略' },
    { kind: 'ended', outcome: 'interrupted', outcomeUnknown: true, reason: '结束详情已省略' },
    { kind: 'ended', outcome: 'done', outcomeUnknown: true, reason: '结束详情已省略' },
    { kind: 'ended', outcomeUnknown: true },
    { kind: 'ended' },
    { kind: 'tool_result', name: 'tool' }
  ]);
  assert.equal(projected.nextAfter, 10);
});

test('projectEvents：tool_result 带上工具名，输入输出不外泄', () => {
  const projected = projectEvents(
    [
      { seq: 1, at: 1, event: { kind: 'tool_call', name: 'workspace_read', input: { path: '/srv/notes.md' } } },
      { seq: 2, at: 2, event: { kind: 'tool_result', name: 'workspace_read', ok: true, output: '机密内容' } }
    ],
    0
  );
  assert.deepEqual(projected.events[0]!.event, { kind: 'tool', name: 'workspace_read' });
  // name 与 tool_call 对齐（调用方好配对）；ok 保留；output 不投影。
  assert.deepEqual(projected.events[1]!.event, { kind: 'tool_result', name: 'workspace_read', ok: true });
  assert.ok(!JSON.stringify(projected).includes('机密内容'));
  // 老事件没有 name 时退回 'tool'，不抛错。
  const legacy = projectEvents([{ seq: 3, at: 3, event: { kind: 'tool_result', ok: false } }], 0);
  assert.deepEqual(legacy.events[0]!.event, { kind: 'tool_result', name: 'tool', ok: false });
});
