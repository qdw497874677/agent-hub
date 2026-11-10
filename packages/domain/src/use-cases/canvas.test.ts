import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDescriptor } from '../agent.ts';
import { asAgentId } from '../ids.ts';
import { inMemoryDeps, fakeSessionLinks } from '../testing/in-memory.ts';
import { createProjectUseCase } from './projects.ts';
import { createTaskUseCase } from './tasks.ts';
import { deriveSessionUseCase, recordEvent } from './sessions.ts';
import { linkSessionsUseCase, loadCanvas, unlinkSessionsUseCase } from './canvas.ts';

const agent: AgentDescriptor = {
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

test('画布：第一句话留在 openings，最近 24 条预览装不下它也还在', async () => {
  const w = inMemoryDeps();
  w.agents.push(agent);
  const project = await createProjectUseCase(w.deps, { name: 'demo', rootPath: '/tmp/demo' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: '同名任务' });
  assert.ok(task.ok);
  const session = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  assert.ok(session.ok);
  await recordEvent(w.deps, { sessionId: session.value.id, event: { kind: 'prompt', text: '第一条会话：看看日志' } });
  for (let i = 0; i < 30; i++) await recordEvent(w.deps, { sessionId: session.value.id, event: { kind: 'tool_call', name: 'bash', input: String(i) } });
  const canvas = await loadCanvas(w.deps, project.value.id);
  assert.ok(canvas.ok);
  assert.equal(canvas.value.openings[session.value.id], '第一条会话：看看日志');
  assert.equal(canvas.value.previews[session.value.id]?.some((entry) => entry.event.kind === 'prompt'), false);
  assert.equal(canvas.value.previews[session.value.id]?.length, 24);
});

test('画布：会话连线是无向边，断开后消失', async () => {
  const w = inMemoryDeps({ links: fakeSessionLinks() });
  w.agents.push(agent);
  const project = await createProjectUseCase(w.deps, { name: 'links', rootPath: '/tmp/links' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: '连线' });
  assert.ok(task.ok);
  const one = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  const other = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  assert.ok(one.ok && other.ok);

  const linked = await linkSessionsUseCase(w.deps, project.value.id, one.value.id, other.value.id, 'alice');
  assert.ok(linked.ok);
  // 反向再连一次：同一份无向关系，不新增第二行
  const again = await linkSessionsUseCase(w.deps, project.value.id, other.value.id, one.value.id, 'bob');
  assert.ok(again.ok);

  const canvas = await loadCanvas(w.deps, project.value.id);
  assert.ok(canvas.ok);
  const links = canvas.value.edges.filter((edge) => edge.kind === 'link');
  assert.equal(links.length, 1);
  assert.equal(links[0]?.kind === 'link' && links[0].aSessionId, one.value.id);

  const removed = await unlinkSessionsUseCase(w.deps, project.value.id, other.value.id, one.value.id);
  assert.ok(removed.ok);
  const after = await loadCanvas(w.deps, project.value.id);
  assert.ok(after.ok);
  assert.equal(after.value.edges.some((edge) => edge.kind === 'link'), false);
});

test('画布：不能连接自己，也不能连接别的项目的会话', async () => {
  const w = inMemoryDeps({ links: fakeSessionLinks() });
  w.agents.push(agent);
  const project = await createProjectUseCase(w.deps, { name: 'links', rootPath: '/tmp/links' });
  const otherProject = await createProjectUseCase(w.deps, { name: 'other', rootPath: '/tmp/other' });
  assert.ok(project.ok && otherProject.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: 'a' });
  const foreign = await createTaskUseCase(w.deps, { projectId: otherProject.value.id, title: 'b' });
  assert.ok(task.ok && foreign.ok);
  const one = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  const two = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  const away = await deriveSessionUseCase(w.deps, { taskId: foreign.value.id, agentId: 'fake', model: 'm1' });
  assert.ok(one.ok && two.ok && away.ok);

  assert.equal((await linkSessionsUseCase(w.deps, project.value.id, one.value.id, one.value.id, 'alice')).ok, false);
  assert.equal((await linkSessionsUseCase(w.deps, project.value.id, one.value.id, away.value.id, 'alice')).ok, false);
  assert.equal((await linkSessionsUseCase(w.deps, project.value.id, one.value.id, two.value.id, 'alice')).ok, true);
});
