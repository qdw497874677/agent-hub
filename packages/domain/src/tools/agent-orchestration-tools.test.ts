import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDescriptor } from '../agent.ts';
import { asAgentId } from '../ids.ts';
import { fakeAgentProfiles, inMemoryDeps } from '../testing/in-memory.ts';
import type { ToolGrant } from '../tool.ts';
import { createProjectUseCase } from '../use-cases/projects.ts';
import { createTaskUseCase } from '../use-cases/tasks.ts';
import { createAgentProfile } from '../use-cases/agent-profiles.ts';
import { deriveSessionUseCase } from '../use-cases/sessions.ts';
import { createAgentOrchestrationToolProvider, type SpawnAgentAction } from './agent-orchestration-tools.ts';

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
  models: ['m1', 'm2'],
  defaultModel: 'm1',
  options: [{ id: 'mode', label: 'Agent', category: 'agent', kind: 'select', current: 'build', choices: [{ kind: 'value', value: { value: 'build', label: 'build' } }, { kind: 'value', value: { value: 'plan', label: 'plan' } }] }]
};

async function world() {
  const w = inMemoryDeps({ agentProfiles: fakeAgentProfiles() });
  w.agents.push(agent);
  const project = await createProjectUseCase(w.deps, { name: 'orch', rootPath: '/tmp/orch' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: '编排' });
  assert.ok(task.ok);
  const session = await deriveSessionUseCase(w.deps, {
    taskId: task.value.id,
    agentId: 'fake',
    model: 'm1',
    createdBy: 'u1'
  });
  assert.ok(session.ok);
  const grant = (sessionId: string, taskId: string) => ({
    grant: { sessionId, taskId, scopes: ['agent:message'] } as unknown as ToolGrant,
    now: 0
  });
  return { w, project: project.value, task: task.value, session: session.value, grant };
}

test('编排工具：列 profile、运行时和同项目活动', async () => {
  const { w, session, grant } = await world();
  const made = await createAgentProfile(w.deps, 'u1', {
    name: '探索',
    agentId: 'fake',
    model: 'm2',
    options: { mode: 'plan' },
    notes: '只读'
  });
  assert.ok(made.ok);

  let spawned: SpawnAgentAction | null = null;
  const tools = createAgentOrchestrationToolProvider({
    agentProfiles: w.deps.agentProfiles,
    sessions: w.deps.sessions,
    tasks: w.deps.tasks,
    projects: w.deps.projects,
    agents: w.deps.agents,
    now: w.deps.now,
    spawn: async (input) => {
      spawned = input;
      return { ok: true as const, value: { sessionId: 'child', taskId: input.taskId, agentId: input.agentId, model: input.model, status: 'running' } };
    }
  });

  const profiles = await tools.call('agent.list_profiles', {}, grant(session.id, session.taskId));
  assert.ok(profiles.ok, JSON.stringify(profiles));
  assert.equal((profiles.value as { profiles: unknown[] }).profiles.length, 1);

  const runtimes = await tools.call('agent.inspect_runtime', { agent_id: 'fake' }, grant(session.id, session.taskId));
  assert.ok(runtimes.ok);
  assert.deepEqual((runtimes.value as { runtime: { model_ids: string[] } }).runtime.model_ids, ['m1', 'm2']);

  const activity = await tools.call('agent.activity', {}, grant(session.id, session.taskId));
  assert.ok(activity.ok);
  assert.equal((activity.value as { sessions: unknown[] }).sessions.length, 1);

  const start = await tools.call('agent.spawn', { profile_id: made.value.id, prompt: '看看 /tmp' }, grant(session.id, session.taskId));
  assert.ok(start.ok, JSON.stringify(start));
  const got = spawned as SpawnAgentAction | null;
  assert.ok(got);
  assert.equal(got.agentId, 'fake');
  assert.equal(got.model, 'm2');
  assert.equal(got.options.mode, 'plan');
  assert.equal(got.createdBy, 'u1');
  assert.equal(got.prompt, '看看 /tmp');
});

test('编排工具：set_option 只能改同项目同 owner 的会话', async () => {
  const { w, session, grant } = await world();
  let called: { sessionId: string; optionId: string; value: string | boolean } | null = null;
  const tools = createAgentOrchestrationToolProvider({
    agentProfiles: w.deps.agentProfiles,
    sessions: w.deps.sessions,
    tasks: w.deps.tasks,
    projects: w.deps.projects,
    agents: w.deps.agents,
    now: w.deps.now,
    setOption: async (sessionId, optionId, value) => {
      called = { sessionId, optionId, value };
      return { ok: true as const, value: { ...session, options: { ...session.options, [optionId]: value } } };
    }
  });
  const changed = await tools.call('agent.set_option', { session_id: session.id, option_id: 'mode', value: 'plan' }, grant(session.id, session.taskId));
  assert.ok(changed.ok, JSON.stringify(changed));
  assert.deepEqual(called, { sessionId: session.id, optionId: 'mode', value: 'plan' });

  const other = await deriveSessionUseCase(w.deps, {
    taskId: session.taskId,
    agentId: 'fake',
    model: 'm1',
    createdBy: 'u2'
  });
  assert.ok(other.ok);
  const denied = await tools.call('agent.set_option', { session_id: other.value.id, option_id: 'mode', value: 'plan' }, grant(session.id, session.taskId));
  assert.equal(denied.ok, false);
});
