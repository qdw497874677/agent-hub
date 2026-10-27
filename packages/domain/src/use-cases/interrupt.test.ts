import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { createProject } from '../project.ts';
import { createTask } from '../task.ts';
import { deriveSession, isBusy } from '../session.ts';
import { asAgentId } from '../ids.ts';
import { interruptSessionUseCase, recordEvent } from './sessions.ts';

async function world() {
  const memory = inMemoryDeps();
  const project = createProject({ name: 'demo', now: 1 });
  assert.ok(project.ok);
  const task = createTask({ projectId: project.value.id, title: 't', goal: '', now: 1 });
  assert.ok(task.ok);
  const session = deriveSession({ task: task.value, agentId: asAgentId('pi'), model: '', now: 1 });
  assert.ok(session.ok);
  await memory.deps.projects.save(project.value);
  await memory.deps.tasks.save(task.value);
  await memory.deps.sessions.save(session.value);
  return { ...memory, session: session.value };
}

test('从没发过话的会话不算在干活；发过话的 running 才算', async () => {
  const w = await world();
  assert.equal(isBusy(w.session), false);
  const prompted = await recordEvent(w.deps, { sessionId: w.session.id, event: { kind: 'prompt', text: 'hi' } });
  assert.ok(prompted.ok);
  assert.equal(isBusy(prompted.value), true);
});

test('中断从没发过话的会话：平台记 ended(stopped)，离开 running', async () => {
  const w = await world();
  const result = await interruptSessionUseCase(w.deps, w.session.id);
  assert.ok(result.ok);
  const after = await w.deps.sessions.byId(w.session.id);
  assert.equal(after?.status, 'stopped');
  assert.equal(after?.lastSeq, 1);
  assert.deepEqual(w.dispatched.map((c) => c.kind), ['interrupt']);
});

test('中断正在跑的一轮：只交给 agent，状态等它发 ended', async () => {
  const w = await world();
  await recordEvent(w.deps, { sessionId: w.session.id, event: { kind: 'prompt', text: 'hi' } });
  const result = await interruptSessionUseCase(w.deps, w.session.id);
  assert.ok(result.ok);
  assert.equal((await w.deps.sessions.byId(w.session.id))?.status, 'running');
  assert.deepEqual(w.dispatched.map((c) => c.kind), ['interrupt']);
});

test('中断不存在的会话：notFound', async () => {
  const w = await world();
  const result = await interruptSessionUseCase(w.deps, 'nope');
  assert.equal(!result.ok && result.error.code, 'not_found');
});
