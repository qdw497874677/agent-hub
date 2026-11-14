import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDescriptor } from '../agent.ts';
import { asAgentId } from '../ids.ts';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { createProjectUseCase } from './projects.ts';
import { createTaskUseCase } from './tasks.ts';
import { deriveSessionUseCase } from './sessions.ts';
import { loadCanvas } from './canvas.ts';
import { loadHome } from './home.ts';

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
  const project = await createProjectUseCase(w.deps, { name: 'side', rootPath: '/tmp/side' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: '顺口问一句' });
  assert.ok(task.ok);
  return { ...w, project: project.value, task: task.value };
}

test('侧聊继承父会话的 workspace / worker / agent / model / options / groupId', async () => {
  const w = await world();
  const parent = await deriveSessionUseCase(w.deps, {
    taskId: w.task.id,
    agentId: 'fake',
    model: 'm1',
    options: { reasoning_effort: 'low' }
  });
  assert.ok(parent.ok);
  assert.ok(parent.value.workspaceId);
  assert.ok(parent.value.workerId);

  const side = await deriveSessionUseCase(w.deps, {
    taskId: w.task.id,
    kind: 'side',
    parentSessionId: parent.value.id,
    // 调用方乱给的一律忽略
    agentId: 'not-an-agent',
    model: 'not-a-model',
    workspaceId: null,
    workerId: 'bogus-worker',
    options: { reasoning_effort: 'high' }
  });
  assert.ok(side.ok);
  assert.equal(side.value.kind, 'side');
  assert.equal(side.value.parentSessionId, parent.value.id);
  assert.equal(side.value.workspaceId, parent.value.workspaceId);
  assert.equal(side.value.workerId, parent.value.workerId);
  assert.equal(side.value.agentId, parent.value.agentId);
  assert.equal(side.value.model, parent.value.model);
  assert.deepEqual(side.value.options, parent.value.options);
  assert.equal(side.value.groupId, parent.value.groupId);
});

test('侧聊必须挂在同项目的已有会话上', async () => {
  const w = await world();
  const noParent = await deriveSessionUseCase(w.deps, { taskId: w.task.id, agentId: 'fake', model: 'm1', kind: 'side' });
  assert.equal(noParent.ok, false);
  if (!noParent.ok) assert.match(noParent.error.message, /侧聊要挂在一条已有会话上/);

  const missing = await deriveSessionUseCase(w.deps, {
    taskId: w.task.id,
    agentId: 'fake',
    model: 'm1',
    kind: 'side',
    parentSessionId: 'ses_nope'
  });
  assert.equal(missing.ok, false);

  const otherProject = await createProjectUseCase(w.deps, { name: 'other', rootPath: '/tmp/other' });
  assert.ok(otherProject.ok);
  const otherTask = await createTaskUseCase(w.deps, { projectId: otherProject.value.id, title: '别处' });
  assert.ok(otherTask.ok);
  const foreign = await deriveSessionUseCase(w.deps, { taskId: otherTask.value.id, agentId: 'fake', model: 'm1' });
  assert.ok(foreign.ok);
  const crossProject = await deriveSessionUseCase(w.deps, {
    taskId: w.task.id,
    agentId: 'fake',
    model: 'm1',
    kind: 'side',
    parentSessionId: foreign.value.id
  });
  assert.equal(crossProject.ok, false);
  if (!crossProject.ok) assert.match(crossProject.error.message, /侧聊要挂在一条已有会话上/);
});

test('父会话没有 workspace / worker 时拒绝开侧聊', async () => {
  const w = await world();
  const parent = await deriveSessionUseCase(w.deps, { taskId: w.task.id, agentId: 'fake', model: 'm1' });
  assert.ok(parent.ok);
  await w.deps.sessions.save({ ...parent.value, workerId: null });
  const side = await deriveSessionUseCase(w.deps, {
    taskId: w.task.id,
    agentId: 'fake',
    model: 'm1',
    kind: 'side',
    parentSessionId: parent.value.id
  });
  assert.equal(side.ok, false);
});

test('画布默认不返回侧聊，includeSide 才带出来；首页最近会话也过滤侧聊', async () => {
  const w = await world();
  const parent = await deriveSessionUseCase(w.deps, { taskId: w.task.id, agentId: 'fake', model: 'm1' });
  assert.ok(parent.ok);
  const side = await deriveSessionUseCase(w.deps, {
    taskId: w.task.id,
    agentId: 'fake',
    model: 'm1',
    kind: 'side',
    parentSessionId: parent.value.id
  });
  assert.ok(side.ok);

  const plain = await loadCanvas(w.deps, w.project.id);
  assert.ok(plain.ok);
  assert.deepEqual(plain.value.sessions.map((session) => session.id), [parent.value.id]);
  assert.equal(plain.value.previews[side.value.id], undefined);

  const withSide = await loadCanvas(w.deps, w.project.id, { includeSide: true });
  assert.ok(withSide.ok);
  assert.deepEqual(
    withSide.value.sessions.map((session) => session.id).sort(),
    [parent.value.id, side.value.id].sort()
  );

  const home = await loadHome(w.deps);
  assert.deepEqual(home.recentSessions.map((row) => row.sessionId), [parent.value.id]);
});
