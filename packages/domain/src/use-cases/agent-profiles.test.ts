import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDescriptor } from '../agent.ts';
import { asAgentId } from '../ids.ts';
import { fakeAgentProfiles, inMemoryDeps } from '../testing/in-memory.ts';
import { createProjectUseCase } from './projects.ts';
import { createTaskUseCase } from './tasks.ts';
import { createAgentProfile, deleteAgentProfile, listAgentProfiles, updateAgentProfile } from './agent-profiles.ts';
import { deriveSessionUseCase } from './sessions.ts';

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

async function world() {
  const w = inMemoryDeps({ agentProfiles: fakeAgentProfiles() });
  w.agents.push(agent);
  const project = await createProjectUseCase(w.deps, { name: 'profiles', rootPath: '/tmp/profiles' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: '配置' });
  assert.ok(task.ok);
  return { w, project: project.value, task: task.value };
}

test('Agent 配置：按 owner 隔离，增删改查', async () => {
  const { w } = await world();
  const made = await createAgentProfile(w.deps, 'u1', {
    name: '探索',
    agentId: 'fake',
    model: 'm1',
    options: { mode: 'build' },
    notes: '看代码'
  });
  assert.ok(made.ok);
  const mine = await listAgentProfiles(w.deps, 'u1');
  assert.ok(mine.ok);
  assert.equal(mine.value.length, 1);
  const other = await listAgentProfiles(w.deps, 'u2');
  assert.ok(other.ok);
  assert.equal(other.value.length, 0);

  const denied = await updateAgentProfile(w.deps, 'u2', made.value.id, {
    name: '偷改',
    agentId: 'fake',
    model: 'm1'
  });
  assert.equal(denied.ok, false);

  const updated = await updateAgentProfile(w.deps, 'u1', made.value.id, {
    name: '探索 2',
    agentId: 'fake',
    model: 'm1',
    options: { mode: 'plan' }
  });
  assert.ok(updated.ok);
  assert.equal(updated.value.name, '探索 2');
  assert.equal(updated.value.options.mode, 'plan');

  const removed = await deleteAgentProfile(w.deps, 'u1', made.value.id);
  assert.ok(removed.ok);
  const after = await listAgentProfiles(w.deps, 'u1');
  assert.ok(after.ok);
  assert.equal(after.value.length, 0);
});

test('派生时套用 Agent 配置：agent/model/options 进入 start_session', async () => {
  const { w, task } = await world();
  const made = await createAgentProfile(w.deps, null, {
    name: '构建',
    agentId: 'fake',
    model: 'm1',
    options: { mode: 'build', effort: 'high' }
  });
  assert.ok(made.ok);

  const session = await deriveSessionUseCase(w.deps, {
    taskId: task.id,
    agentId: 'fake',
    model: 'm1',
    profileId: made.value.id
  });
  assert.ok(session.ok);
  assert.equal(session.value.agentId, 'fake');
  assert.equal(session.value.model, 'm1');
  assert.equal(session.value.options.mode, 'build');
  assert.equal(session.value.options.effort, 'high');

  const start = w.dispatched.find((command) => command.kind === 'start_session');
  assert.ok(start && start.kind === 'start_session');
  assert.equal(start.options?.mode, 'build');
  assert.equal(start.options?.effort, 'high');
});
