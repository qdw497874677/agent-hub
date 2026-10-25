import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDescriptor } from '../agent.ts';
import { asAgentId } from '../ids.ts';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { createProjectUseCase } from './projects.ts';
import { createTaskUseCase, setTaskStatusUseCase } from './tasks.ts';
import { deriveSessionUseCase } from './sessions.ts';
import { appendWorkLogUseCase, editWorkLogUseCase } from './work-log.ts';
import { summaryFromHandoff } from '../work-log.ts';

const fake: AgentDescriptor = {
  id: asAgentId('fake'),
  label: 'Fake',
  capabilities: {
    prompt: { state: 'available' },
    interrupt: { state: 'available' },
    fork: { state: 'available' },
    resume: { state: 'available' },
    tool_calls: { state: 'available' },
    artifacts: { state: 'available' },
    structured_events: { state: 'available' },
    attachments: { state: 'available' }
  },
  models: ['m1'],
  defaultModel: 'm1',
  options: []
};

async function world() {
  const w = inMemoryDeps();
  w.agents.push(fake);
  const project = await createProjectUseCase(w.deps, { name: 'demo', rootPath: '/tmp/demo' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: '接通能力层', ownerId: 'u1' });
  assert.ok(task.ok);
  return { ...w, task: task.value };
}

const user = { kind: 'user', userId: 'u1', name: '我' } as const;

test('追加日志：seq 单调递增，任务 logSeq 跟进', async () => {
  const w = await world();
  assert.equal(w.task.status, 'todo');
  assert.equal(w.task.ownerId, 'u1');
  const a = await appendWorkLogUseCase(w.deps, { taskId: w.task.id, author: user, kind: 'note', body: '第一条' });
  const b = await appendWorkLogUseCase(w.deps, { taskId: w.task.id, author: user, kind: 'decision', body: '用 SDK' });
  assert.ok(a.ok && b.ok);
  assert.equal(a.value.entry.seq, 1);
  assert.equal(b.value.entry.seq, 2);
  assert.equal(b.value.task.logSeq, 2);
  const listed = await w.deps.workLog.list(w.task.id, { limit: 10 });
  assert.deepEqual(listed.map((e) => e.seq), [2, 1]);
  assert.deepEqual((await w.deps.workLog.list(w.task.id, { limit: 10, beforeSeq: 2 })).map((e) => e.seq), [1]);
});

test('handoff 刷新任务 summary；系统类日志不能手写；空/超长被拒', async () => {
  const w = await world();
  const handoff = await appendWorkLogUseCase(w.deps, {
    taskId: w.task.id,
    author: user,
    kind: 'handoff',
    body: '## 已完成\n- 迁移和接口都好了\n\n## 下一步\n- UI'
  });
  assert.ok(handoff.ok);
  assert.equal(handoff.value.task.summary, '迁移和接口都好了');
  assert.equal((await w.deps.workLog.latestHandoff(w.task.id))?.id, handoff.value.entry.id);

  const forged = await appendWorkLogUseCase(w.deps, { taskId: w.task.id, author: user, kind: 'status_change', body: 'x' });
  assert.ok(!forged.ok);
  const empty = await appendWorkLogUseCase(w.deps, { taskId: w.task.id, author: user, kind: 'note', body: '  ' });
  assert.ok(!empty.ok);
  const huge = await appendWorkLogUseCase(w.deps, { taskId: w.task.id, author: user, kind: 'note', body: 'x'.repeat(33 * 1024) });
  assert.ok(!huge.ok);
});

test('修订 = 追加新版本；旧版 supersededBy 指向新版，默认列表只见新版', async () => {
  const w = await world();
  const first = await appendWorkLogUseCase(w.deps, { taskId: w.task.id, author: user, kind: 'note', body: '错字' });
  assert.ok(first.ok);
  const edited = await editWorkLogUseCase(w.deps, { entryId: first.value.entry.id, body: '正字', author: user });
  assert.ok(edited.ok);
  assert.equal(edited.value.entry.supersedes, first.value.entry.id);
  assert.equal((await w.deps.workLog.byId(first.value.entry.id))?.supersededBy, edited.value.entry.id);
  assert.deepEqual((await w.deps.workLog.list(w.task.id, { limit: 10 })).map((e) => e.body), ['正字']);
  assert.equal((await w.deps.workLog.list(w.task.id, { limit: 10, includeSuperseded: true })).length, 2);

  const agent = { kind: 'agent', sessionId: 's', agentId: 'fake', model: 'm1' } as const;
  assert.ok(!(await editWorkLogUseCase(w.deps, { entryId: edited.value.entry.id, body: 'x', author: agent })).ok);
  assert.ok(!(await editWorkLogUseCase(w.deps, { entryId: first.value.entry.id, body: 'x', author: user })).ok);
});

test('开会话：todo → in_progress，并记一条 session_event；改状态记 status_change', async () => {
  const w = await world();
  const session = await deriveSessionUseCase(w.deps, { taskId: w.task.id, agentId: 'fake', model: 'm1' });
  assert.ok(session.ok);
  const task = await w.deps.tasks.byId(w.task.id);
  assert.equal(task?.status, 'in_progress');
  const [event] = await w.deps.workLog.list(w.task.id, { limit: 10 });
  assert.equal(event?.kind, 'session_event');
  assert.equal(event?.sessionId, session.value.id);

  const blocked = await setTaskStatusUseCase(w.deps, w.task.id, 'blocked', 'agent', '等 key');
  assert.ok(blocked.ok);
  assert.equal(blocked.value.logSeq, 2);
  const [change] = await w.deps.workLog.list(w.task.id, { limit: 1 });
  assert.equal(change?.kind, 'status_change');
  assert.match(change?.body ?? '', /改为「受阻」：等 key/);
  assert.ok(!(await setTaskStatusUseCase(w.deps, w.task.id, 'done', 'agent')).ok);
});

test('summaryFromHandoff 跳过模板小标题、截断长行', () => {
  assert.equal(summaryFromHandoff('## 已完成\n- A 好了'), 'A 好了');
  assert.equal(summaryFromHandoff('x'.repeat(300)).length, 200);
});
