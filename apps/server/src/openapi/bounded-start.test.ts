import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryDeps } from '@agent-hub/domain/testing';
import { asAgentId, asLoginId, asTeamId, asUserId, asWorkspaceGroupId, createProjectUseCase, createTaskUseCase, deriveSessionUseCase, newWorkspace } from '@agent-hub/domain';
import type { AgentDescriptor, Principal, WorkerStatus } from '@agent-hub/domain';
import { boundedStart, boundedStartRequest } from './bounded-start.ts';
import { listSessionTargets } from './session-targets.ts';

const actor: Principal = {
  loginId: asLoginId('login'),
  user: { id: asUserId('user'), email: 'test@example.com', displayName: 'Test', role: 'owner', passwordHash: null,
    emailVerifiedAt: 1, disabledAt: null, createdAt: 1, teamId: null, clusterAdmin: true, deletedAt: null }
};

async function world() {
  const w = inMemoryDeps();
  w.agents.push({ id: asAgentId('fake'), label: 'Fake', capabilities: Object.fromEntries(
    ['prompt', 'interrupt', 'fork', 'resume', 'tool_calls', 'artifacts', 'structured_events', 'attachments'].map((key) => [key, { state: 'available' }])
  ) as AgentDescriptor['capabilities'], models: ['m1'], defaultModel: 'm1', options: [] });
  const worker: WorkerStatus = { workerId: 'remote-1', label: '/secret/path', origin: 'remote', state: 'online', agentIds: ['fake'],
    agentModels: [{ agentId: 'fake', models: ['m1'], defaultModel: 'm1', readiness: { state: 'ready' } }] };
  w.workers.push(worker);
  const project = await createProjectUseCase(w.deps, { name: 'project' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: 'task' });
  assert.ok(task.ok);
  const workspace = newWorkspace({ projectId: project.value.id, workerId: worker.workerId, path: '/secret/path', label: 'path', kind: 'long_lived', source: 'linked', state: 'ready', now: 1 });
  assert.ok(workspace.ok);
  await w.deps.workspaces.save(workspace.value);
  const input = { placement: 'bounded_v1', taskId: task.value.id, workerId: worker.workerId, workspaceId: workspace.value.id, agentId: 'fake', model: 'm1' };
  return { ...w, project: project.value, task: task.value, workspace: workspace.value, worker, input };
}

test('bounded request rejects unknown fields before legacy parsing', () => {
  const input = { placement: 'bounded_v1', taskId: 't', workerId: 'w', workspaceId: 's', agentId: 'a', model: 'm' };
  assert.equal(boundedStartRequest.safeParse(input).success, true);
  for (const key of ['groupId', 'workspaceMode', 'repoId', 'options', 'requires', 'handle', 'unexpected']) {
    assert.equal(boundedStartRequest.safeParse({ ...input, [key]: 'x' }).success, false, key);
  }
});

test('discovery returns only scoped remote targets without paths, and reports blocked workspaces', async () => {
  const w = await world();
  const blocked = newWorkspace({ projectId: w.project.id, workerId: w.worker.workerId, path: '/secret/blocked', kind: 'long_lived', source: 'linked', state: 'preparing', now: 2 });
  assert.ok(blocked.ok);
  await w.deps.workspaces.save(blocked.value);
  const result = await listSessionTargets(w.deps, actor, w.task.id);
  assert.ok(result.ok);
  assert.equal(result.value.workers.length, 1);
  assert.equal(result.value.workers[0]!.workspaces.find((item) => item.workspaceId === w.workspace.id)?.availability, 'ready');
  assert.equal(result.value.workers[0]!.workspaces.find((item) => item.workspaceId === blocked.value.id)?.availability, 'blocked');
  assert.equal(JSON.stringify(result.value).includes('/secret'), false);
  assert.equal(result.value.workers[0]!.label, 'Worker');
  assert.equal(result.value.workers[0]!.workspaces.find((item) => item.workspaceId === w.workspace.id)?.label, 'path');
  assert.equal((await listSessionTargets(w.deps, null, w.task.id)).ok, false);
});

test('bounded start preserves exact placement and model', async () => {
  const w = await world();
  const result = await boundedStart({ deps: w.deps }, actor, w.input);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.value.workerId, w.worker.workerId);
  assert.equal(result.value.workspaceId, w.workspace.id);
  assert.equal(result.value.model, 'm1');
  assert.equal(result.value.agentId, 'fake');
  assert.equal(w.dispatched.length, 1);
});

test('bounded guard rejects mismatches and missing readiness without writes or dispatch', async () => {
  const w = await world();
  for (const input of [
    { ...w.input, workerId: 'other' }, { ...w.input, workspaceId: 'missing' },
    { ...w.input, agentId: 'missing' }, { ...w.input, model: 'missing' },
    { ...w.input, groupId: 'group' }, { ...w.input, model: '' }
  ]) {
    assert.equal((await boundedStart({ deps: w.deps }, actor, input)).ok, false);
  }
  w.workers[1] = { ...w.worker, agentModels: [{ agentId: 'fake', models: ['m1'], defaultModel: 'm1' }] };
  assert.equal((await boundedStart({ deps: w.deps }, actor, w.input)).ok, false);
  assert.equal((await w.deps.sessions.listByTask(w.task.id)).length, 0);
  assert.equal(w.dispatched.length, 0);
});

test('discovery enforces worker scope and reports use denial without leaking other workers', async () => {
  const w = await world();
  const team = asTeamId('team');
  const member: Principal = { ...actor, user: { ...actor.user, teamId: team, role: 'viewer', clusterAdmin: false } };
  w.workers.push({ ...w.worker, workerId: 'hidden' });
  const deps = { ...w.deps, access: {
    context: async () => ({ hubTeamId: team, settings: { membersCanAddMachines: true } }),
    worker: async (id: string | null) => ({ kind: 'worker' as const, id: id ?? 'local', teamId: id === 'hidden' ? 'another-team' : team })
  } };
  const result = await listSessionTargets(deps, member, w.task.id);
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(result.value.workers.map((worker) => worker.workerId), ['remote-1']);
  assert.equal(result.value.workers[0]!.availability, 'blocked');
  assert.ok(result.value.workers[0]!.blockers.includes('worker_not_permitted'));
});

test('bounded start resolves default model but rejects wrong-task temporary and offline targets', async () => {
  const w = await world();
  await w.deps.projects.save({ ...w.project, defaultAgent: { runtime: 'fake', model: 'm1', options: {} } });
  const other = await createTaskUseCase(w.deps, { projectId: w.project.id, title: 'other' });
  assert.ok(other.ok);
  const temporary = newWorkspace({ projectId: w.project.id, workerId: w.worker.workerId, path: '/secret/temp', kind: 'temporary', source: 'linked', ownerTaskId: other.value.id, state: 'ready', now: 2 });
  assert.ok(temporary.ok);
  await w.deps.workspaces.save(temporary.value);
  assert.equal((await boundedStart({ deps: w.deps }, actor, { ...w.input, workspaceId: temporary.value.id })).ok, false);
  w.workers[1] = { ...w.worker, state: 'offline' };
  assert.equal((await boundedStart({ deps: w.deps }, actor, w.input)).ok, false);
  w.workers[1] = w.worker;
  const { model: _model, ...withoutModel } = w.input;
  const result = await boundedStart({ deps: w.deps }, actor, withoutModel);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.value.model, 'm1');
});

test('grouped, legacy-local and unrelated project workspaces never become targets or start', async () => {
  const w = await world();
  const other = await createProjectUseCase(w.deps, { name: 'other' });
  assert.ok(other.ok);
  const inputs = [
    { projectId: w.project.id, workerId: w.worker.workerId, groupId: asWorkspaceGroupId('group') },
    { projectId: w.project.id, workerId: null },
    { projectId: other.value.id, workerId: w.worker.workerId }
  ];
  for (const [index, input] of inputs.entries()) {
    const workspace = newWorkspace({ ...input, path: `/secret/${index}`, kind: 'long_lived', source: 'linked', state: 'ready', now: index + 10 });
    assert.ok(workspace.ok);
    await w.deps.workspaces.save(workspace.value);
    assert.equal((await boundedStart({ deps: w.deps }, actor, { ...w.input, workspaceId: workspace.value.id })).ok, false);
    const targets = await listSessionTargets(w.deps, actor, w.task.id);
    assert.ok(targets.ok);
    assert.equal(targets.value.workers.flatMap((worker) => worker.workspaces).some((item) => item.workspaceId === workspace.value.id), false);
  }
  assert.equal((await w.deps.sessions.listAll()).length, 0);
  assert.equal(w.dispatched.length, 0);
});

test('domain guard rejects substitution even when called without HTTP parser', async () => {
  const w = await world();
  const result = await deriveSessionUseCase(w.deps, { taskId: w.task.id, workerId: w.worker.workerId,
    workspaceId: w.workspace.id, agentId: 'fake', model: 'm1', boundedPlacement: true, kind: 'side' });
  assert.equal(result.ok, false);
  assert.equal((await w.deps.sessions.listAll()).length, 0);
  assert.equal(w.dispatched.length, 0);
});
