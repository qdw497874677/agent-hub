import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asAgentId, asWorkspaceGroupId, createProjectUseCase, createTaskUseCase, deriveSessionUseCase, newWorkspace, type AgentDescriptor } from '@agent-hub/domain';
import { inMemoryDeps } from '@agent-hub/domain/testing';
import { createApp } from './http.ts';
import { createStreamHub } from './stream-hub.ts';

const fake: AgentDescriptor = {
  id: asAgentId('fake'), label: 'Fake', models: ['m1'], defaultModel: 'm1', options: [],
  capabilities: { prompt: { state: 'available' }, interrupt: { state: 'available' }, fork: { state: 'available' }, resume: { state: 'available' }, tool_calls: { state: 'available' }, artifacts: { state: 'available' }, structured_events: { state: 'available' }, attachments: { state: 'available' } }
};

async function world() {
  const w = inMemoryDeps();
  w.agents.push(fake);
  w.workers.push({ workerId: 'remote', label: 'remote', origin: 'remote', state: 'online', roots: ['/srv'] });
  const project = await createProjectUseCase(w.deps, { name: 'tabs' }); assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: 'task' }); assert.ok(task.ok);
  const ws = newWorkspace({ projectId: project.value.id, workerId: 'remote', path: '/srv/existing', kind: 'long_lived', source: 'linked', now: 1 }); assert.ok(ws.ok);
  await w.deps.workspaces.save(ws.value);
  await w.deps.workspaces.claim({ projectId: project.value.id, workspaceId: ws.value.id, linkedBy: null, linkedAt: 1 });
  const app = createApp({ deps: w.deps, hub: createStreamHub(), token: null });
  const post = (payload: object, projectId = project.value.id) => app.request(`/api/projects/${projectId}/session-tabs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const base = { taskId: task.value.id, agentId: 'fake', model: 'm1', workerId: 'remote' };
  return { ...w, project: project.value, task: task.value, ws: ws.value, post, base };
}

test('explicit workspace and chat-only create distinct ordinary sessions without Git', async () => {
  const w = await world();
  const a = await w.post({ ...w.base, placement: { kind: 'workspace', workspaceId: w.ws.id } });
  assert.equal(a.status, 201, await a.clone().text());
  const first = await a.json() as { id: string; workspaceId: string; workerId: string; kind: string; parentSessionId: string | null };
  assert.equal(first.workspaceId, w.ws.id); assert.equal(first.workerId, 'remote'); assert.equal(first.kind, 'chat'); assert.equal(first.parentSessionId ?? null, null);
  assert.equal((w.dispatched[0] as { workspaceRoot?: string }).workspaceRoot, '/srv/existing');
  const stored = await w.deps.sessions.byId(first.id as never);
  assert.equal(stored?.workspaceId, w.ws.id); assert.equal(stored?.workerId, 'remote');
  const b = await w.post({ ...w.base, placement: { kind: 'chat-only' } });
  assert.equal(b.status, 201, await b.clone().text());
  const second = await b.json() as typeof first;
  assert.notEqual(first.id, second.id); assert.notEqual(first.workspaceId, second.workspaceId);
  assert.equal((await w.deps.workspaces.byId(second.workspaceId as never))?.ownerTaskId, w.task.id);
  assert.deepEqual(w.git.calls, []);
});

test('exact group keeps group identity and rejects stale members and worker fallback', async () => {
  const w = await world();
  const id = asWorkspaceGroupId('group-1');
  const member = newWorkspace({ projectId: w.project.id, workerId: 'remote', path: '/srv/group/a', kind: 'temporary', source: 'worktree', ownerTaskId: w.task.id, now: 1 }); assert.ok(member.ok);
  await w.deps.workspaces.save({ ...member.value, groupId: id });
  await w.deps.workspaces.claim({ projectId: w.project.id, workspaceId: member.value.id, linkedBy: null, linkedAt: 1 });
  const group = { id, projectId: w.project.id, workerId: 'remote', root: '/srv/group', members: [{ workspaceId: member.value.id, repoId: null, name: 'a', state: 'ready' as const, error: null }], state: 'ready' as const, ownerTaskId: w.task.id, sessionId: 'reserved', createdAt: 1, error: null };
  await w.deps.workspaceGroups!.save(group);
  const response = await w.post({ ...w.base, placement: { kind: 'group', groupId: id } });
  assert.equal(response.status, 201, await response.clone().text());
  const session = await response.json() as { id: string; groupId: string; workspaceId: string };
  assert.equal(session.groupId, id); assert.equal(session.workspaceId, member.value.id); assert.notEqual(session.id, 'reserved');
  assert.equal((await w.deps.sessions.byId(session.id as never))?.groupId, id);
  assert.equal((w.dispatched[0] as { workspaceRoot?: string }).workspaceRoot, '/srv/group');
  await w.deps.workspaces.save({ ...member.value, groupId: null });
  assert.notEqual((await w.post({ ...w.base, placement: { kind: 'group', groupId: id } })).status, 201);
  const before = w.dispatched.length;
  w.workers.splice(0, w.workers.length, { workerId: 'remote', label: 'remote', origin: 'remote', state: 'online' });
  await w.deps.workspaces.save({ ...w.ws, workerId: null });
  assert.notEqual((await w.post({ ...w.base, placement: { kind: 'workspace', workspaceId: w.ws.id } })).status, 201);
  assert.equal(w.dispatched.length, before); assert.deepEqual(w.git.calls, []);
});

test('temporary workspace owner, planned guard and archived task fail closed', async () => {
  const w = await world();
  const other = await createTaskUseCase(w.deps, { projectId: w.project.id, title: 'other' }); assert.ok(other.ok);
  const temp = newWorkspace({ projectId: w.project.id, workerId: 'remote', path: '/srv/temp', kind: 'temporary', source: 'worktree', ownerTaskId: w.task.id, now: 1 }); assert.ok(temp.ok);
  await w.deps.workspaces.save(temp.value);
  await w.deps.workspaces.claim({ projectId: w.project.id, workspaceId: temp.value.id, linkedBy: null, linkedAt: 1 });
  const payload = { ...w.base, placement: { kind: 'workspace', workspaceId: temp.value.id } };
  assert.notEqual((await w.post({ ...payload, taskId: other.value.id })).status, 201);
  const guard = { isWorkspaceProtected: () => true, isGroupProtected: () => false, forOutput: () => ({ source: 'local' as const, state: 'pending' as const, groupId: null }), noteStarted: () => {} };
  const plannedApp = createApp({ deps: { ...w.deps, plannedWorktreeGuard: guard }, hub: createStreamHub(), token: null });
  const planned = await plannedApp.request(`/api/projects/${w.project.id}/session-tabs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  assert.notEqual(planned.status, 201);
  assert.equal((await w.post(payload)).status, 201);
  await w.deps.tasks.setArchived(w.task.id, Date.now(), null);
  const before = w.dispatched.length;
  assert.notEqual((await w.post(payload)).status, 201);
  assert.equal(w.dispatched.length, before); assert.deepEqual(w.git.calls, []);
});

test('domain rechecks exact worker immediately before session save', async () => {
  const w = await world();
  let calls = 0;
  const deps = { ...w.deps, gateway: { ...w.deps.gateway, status: async () => ++calls < 2 ? w.workers : w.workers.filter((x) => x.workerId !== 'remote') } };
  const result = await deriveSessionUseCase(deps, { taskId: w.task.id, agentId: 'fake', model: 'm1', workerId: 'remote', tabPlacement: { projectId: w.project.id, workerId: 'remote', placement: { kind: 'workspace', workspaceId: w.ws.id } } });
  assert.equal(result.ok, false);
  assert.equal((await w.deps.sessions.listAll()).length, 0); assert.equal(w.dispatched.length, 0);
});

test('domain worker authorization denial occurs before session save', async () => {
  const w = await world();
  const deps = { ...w.deps, access: { context: async () => ({ hubTeamId: 'team', settings: { membersCanAddMachines: false } }), worker: async () => ({ teamId: 'team', local: true }) } };
  const result = await deriveSessionUseCase(deps, { taskId: w.task.id, agentId: 'fake', model: 'm1', workerId: 'remote', tabPlacement: { projectId: w.project.id, workerId: 'remote', placement: { kind: 'workspace', workspaceId: w.ws.id } } });
  assert.equal(result.ok, false);
  assert.equal((await w.deps.sessions.listAll()).length, 0); assert.equal(w.dispatched.length, 0);
});

test('strict body, wrong project and offline worker fail without effects', async () => {
  const w = await world();
  const payload = { ...w.base, placement: { kind: 'workspace', workspaceId: w.ws.id } };
  assert.equal((await w.post({ ...payload, parentSessionId: 'parent' })).status, 400);
  assert.equal((await w.post({ ...payload, placement: { kind: 'workspace', workspaceId: w.ws.id, mode: 'isolated' } })).status, 400);
  const other = await createProjectUseCase(w.deps, { name: 'other' }); assert.ok(other.ok);
  assert.notEqual((await w.post(payload, other.value.id)).status, 201);
  w.workers.splice(1, 1, { workerId: 'remote', label: 'remote', origin: 'remote', state: 'offline' });
  assert.notEqual((await w.post({ ...w.base, placement: { kind: 'chat-only' } })).status, 201);
  assert.equal(w.dispatched.length, 0); assert.deepEqual(w.git.calls, []);
});
