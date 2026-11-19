import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isProjectableEntry, lastJournalSeq, projectEvents } from './projection.ts';

test('projectEvents：nextAfter 取本窗最后一条原始 seq，投影为空也前进', () => {
  const onlyHidden = [
    { seq: 1, at: 1, event: { kind: 'prompt', text: 'hi' } },
    { seq: 4, at: 2, event: { kind: 'thinking', text: '…' } }
  ];
  const empty = projectEvents(onlyHidden, 0) as { events: unknown[]; nextAfter: number };
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
  ) as { events: { seq: number; event: { kind: string } }[]; nextAfter: number };
  assert.deepEqual(mixed.events.map((e) => e.event.kind), ['text']);
  assert.equal(mixed.nextAfter, 7);

  const none = projectEvents([], 3) as { events: unknown[]; nextAfter: number };
  assert.deepEqual(none.events, []);
  assert.equal(none.nextAfter, 3);
  assert.equal(lastJournalSeq([], 3), 3);

  const scanned = projectEvents([], 0, 12) as { nextAfter: number };
  assert.equal(scanned.nextAfter, 12);
});
