import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { createProject } from '../project.ts';
import { createTask } from '../task.ts';
import { deriveSession } from '../session.ts';
import { asAgentId } from '../ids.ts';
import type { Principal } from '../account.ts';
import type { AccessPolicy } from './authorization.ts';
import { deleteSessionUseCase } from './delete-session.ts';

const policy: AccessPolicy = {
  context: async () => ({ hubTeamId: 't1', settings: { membersCanAddMachines: true } }),
  worker: async (workerId) => ({ kind: 'worker', id: workerId ?? 'local', teamId: 't1', createdBy: null })
};

function principal(id: string, role: 'owner' | 'admin' | 'member' | 'viewer'): Principal {
  return {
    user: { id, email: `${id}@b.co`, role, disabledAt: null, deletedAt: null, teamId: 't1', clusterAdmin: false },
    loginId: `l-${id}`
  } as unknown as Principal;
}

const actor = principal('u1', 'member');

async function world(options: { status?: 'running' | 'stopped'; lastSeq?: number; createdBy?: string; projectCreatedBy?: string; teamId?: string } = {}) {
  const { deps } = inMemoryDeps({ access: policy });
  const project = createProject({ name: 'demo', now: 1, teamId: options.teamId ?? 't1', createdBy: options.projectCreatedBy ?? 'u1' });
  assert.ok(project.ok);
  const task = createTask({ projectId: project.value.id, title: 't', goal: '', now: 1 });
  assert.ok(task.ok);
  const session = deriveSession({ task: task.value, agentId: asAgentId('pi'), model: 'm', now: 1, createdBy: options.createdBy ?? 'u1' });
  assert.ok(session.ok);
  await deps.projects.save(project.value);
  await deps.tasks.save(task.value);
  await deps.sessions.save({ ...session.value, status: options.status ?? 'stopped', lastSeq: options.lastSeq ?? 0 });
  return { deps, project: project.value, task: task.value, session: session.value };
}

test('创建者彻底删除自己的会话：会话行没了，任务和项目还在', async () => {
  const w = await world();
  const result = await deleteSessionUseCase(w.deps, actor, w.session.id);
  assert.ok(result.ok);
  assert.equal(await w.deps.sessions.byId(w.session.id), null);
  assert.deepEqual((await w.deps.sessions.listByTask(w.task.id)).map((s) => s.id), []);
  assert.ok(await w.deps.tasks.byId(w.task.id));
  assert.ok(await w.deps.projects.byId(w.project.id));
});

test('团队成员不能删别人的会话；owner / admin 可以', async () => {
  // 项目是 u1 的（看得见），会话是 u2 建的 → 看得见但没权限：forbidden。
  const w = await world({ createdBy: 'u2' });
  const member = await deleteSessionUseCase(w.deps, actor, w.session.id);
  assert.equal(!member.ok && member.error.code, 'forbidden');
  assert.ok(await w.deps.sessions.byId(w.session.id));

  const viewer = await deleteSessionUseCase(w.deps, principal('u3', 'viewer'), w.session.id);
  assert.equal(!viewer.ok && viewer.error.code, 'forbidden');

  const admin = await deleteSessionUseCase(w.deps, principal('u4', 'admin'), w.session.id);
  assert.ok(admin.ok);
  assert.equal(await w.deps.sessions.byId(w.session.id), null);

  const w2 = await world({ createdBy: 'u2' });
  assert.ok((await deleteSessionUseCase(w2.deps, principal('u5', 'owner'), w2.session.id)).ok);
});

test('别的团队的人删不了', async () => {
  const w = await world({ teamId: 't2', createdBy: 'u2' });
  const owner = principal('u2', 'owner');
  const result = await deleteSessionUseCase(w.deps, owner, w.session.id);
  // 看不见项目团队就不泄露会话存在：not_found。
  assert.equal(!result.ok && result.error.code, 'not_found');
  assert.ok(await w.deps.sessions.byId(w.session.id));
});

test('会话还在跑就拒绝（409 语义），什么都不删', async () => {
  const w = await world({ status: 'running', lastSeq: 3 });
  const result = await deleteSessionUseCase(w.deps, actor, w.session.id);
  assert.equal(!result.ok && result.error.code, 'conflict');
  assert.match(!result.ok ? result.error.message : '', /还在跑/);
  assert.ok(await w.deps.sessions.byId(w.session.id));
});

test('只是挂着 running、从没发过话的会话不挡删除', async () => {
  const w = await world({ status: 'running', lastSeq: 0 });
  assert.ok((await deleteSessionUseCase(w.deps, actor, w.session.id)).ok);
});

test('未登录、会话不存在都拒绝', async () => {
  const w = await world();
  const anon = await deleteSessionUseCase(w.deps, null, w.session.id);
  assert.equal(!anon.ok && anon.error.code, 'forbidden');
  const missing = await deleteSessionUseCase(w.deps, actor, 'nope' as typeof w.session.id);
  assert.equal(!missing.ok && missing.error.code, 'not_found');
  assert.ok(await w.deps.sessions.byId(w.session.id));
});
