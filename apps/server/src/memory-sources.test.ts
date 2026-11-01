import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JournalEntry } from '@agent-hub/domain';
import { renderTranscript } from './memory-sources.ts';

test('TranscriptSource 只取人说的话和回复文字，不含思考和工具输出', () => {
  const events = [
    { kind: 'prompt', text: '修一下登录' },
    { kind: 'thinking', delta: '想想' },
    { kind: 'tool_call', id: '1', name: 'bash', input: 'ls' },
    { kind: 'tool_result', id: '1', output: 'SECRET_OUTPUT' },
    { kind: 'text', delta: '好，' },
    { kind: 'text', delta: '改完了' },
    { kind: 'ended', outcome: 'done' }
  ].map((event, i) => ({ seq: i, at: i, event }) as unknown as JournalEntry);
  assert.equal(renderTranscript(events), '人：修一下登录\nagent：好，改完了');
});

// —— 契约（memory.md §16）：transcript / group 来源 ——
import { createMemorySources } from './memory-sources.ts';
import { memorySourceContract } from '@agent-hub/domain/testing/memory-contracts';
{
  const scope = { kind: 'project', projectId: 'p1' } as const;
  const session = { id: 's1', taskId: 't1', updatedAt: 5 };
  const sessions = {
    listByProject: async () => [session],
    byId: async (id: string) => (id === 's1' ? session : null),
    tail: async () => [{ seq: 0, at: 0, event: { kind: 'prompt', text: '修一下登录' } }]
  };
  const tasks = { byId: async (id: string) => (id === 't1' ? { id, title: '登录', projectId: 'p1' } : null) };
  const group = { id: 'g1', name: '前端', projectId: 'p1', updatedAt: 3 };
  const groups = {
    group: async (id: string) => (id === 'g1' ? group : null),
    groupsOf: async () => [group],
    posts: async () => [{ author: { kind: 'user', name: 'David' }, body: '周五上线' }]
  };
  const all = createMemorySources({ sessions, tasks } as never, groups as never);
  for (const id of ['transcript', 'group']) {
    for (const c of memorySourceContract(id, async () => ({ source: all.find((s) => s.id === id)!, scope }))) test(c.name, () => c.run());
  }
}
