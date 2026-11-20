import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asAgentId } from '../ids.ts';
import { createProject } from '../project.ts';
import { createTask } from '../task.ts';
import { deriveSession } from '../session.ts';
import type { Principal } from '../account.ts';
import type { AgentDescriptor } from '../agent.ts';
import type { AccessPolicy } from './authorization.ts';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { forkSessionUseCase } from './sessions.ts';

const policy: AccessPolicy = {
  context: async () => ({ hubTeamId: 't1', settings: { membersCanAddMachines: true } }),
  worker: async (workerId) => ({ kind: 'worker', id: workerId ?? 'local', teamId: 't1', createdBy: null })
};

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

function principal(id: string, role: 'owner' | 'admin' | 'member' | 'viewer'): Principal {
  return {
    user: { id, email: `${id}@b.co`, role, disabledAt: null, deletedAt: null, teamId: 't1', clusterAdmin: false },
    loginId: `l-${id}`
  } as unknown as Principal;
}

/** 一个项目：u1 建的，共享给 members；会话由 createdBy 建，已有 1 条内容（能分叉）。 */
async function world(options: { createdBy?: string; members?: readonly string[] } = {}) {
  const { deps } = inMemoryDeps({ access: policy });
  deps.agents.list = () => [fake];
  deps.agents.descriptor = (id) => (id === 'fake' ? fake : null);
  const project = createProject({ name: 'demo', now: 1, teamId: 't1', createdBy: 'u1' });
  assert.ok(project.ok);
  const shared = { ...project.value, members: options.members ?? [] };
  const task = createTask({ projectId: project.value.id, title: 't', goal: '', now: 1 });
  assert.ok(task.ok);
  const session = deriveSession({ task: task.value, agentId: asAgentId('fake'), model: 'm1', now: 1, createdBy: options.createdBy ?? 'u1' });
  assert.ok(session.ok);
  await deps.projects.save(shared);
  await deps.tasks.save(task.value);
  await deps.sessions.save({ ...session.value, status: 'stopped', lastSeq: 1 });
  return { deps, project: shared, task: task.value, session: session.value };
}

test('分叉：项目成员（非会话创建者）不能分叉别人的会话', async () => {
  // 项目共享给 u2，所以 u2 看得见会话与项目；但分叉会继承 agentSessionRef，等于读别人的 agent 文件。
  const w = await world({ members: ['u2'] });
  const result = await forkSessionUseCase(w.deps, { sessionId: w.session.id, agentId: 'fake', model: 'm1', actor: principal('u2', 'member') });
  assert.equal(!result.ok && result.error.code, 'forbidden');
  assert.equal((await w.deps.sessions.listByTask(w.task.id)).length, 1, '没有多出会话');
});

test('分叉：会话创建者、团队 owner / admin 可以', async () => {
  // 会话创建者本来也得看得见项目（不然连派生都做不到）。
  const w = await world({ createdBy: 'u2', members: ['u2'] });
  const creator = await forkSessionUseCase(w.deps, { sessionId: w.session.id, agentId: 'fake', model: 'm1', actor: principal('u2', 'member') });
  assert.ok(creator.ok, JSON.stringify(creator));
  assert.equal(creator.value.origin.kind, 'fork');

  const w2 = await world({ createdBy: 'u2' });
  assert.ok((await forkSessionUseCase(w2.deps, { sessionId: w2.session.id, agentId: 'fake', model: 'm1', actor: principal('u9', 'owner') })).ok);
  const w3 = await world({ createdBy: 'u2' });
  assert.ok((await forkSessionUseCase(w3.deps, { sessionId: w3.session.id, agentId: 'fake', model: 'm1', actor: principal('u9', 'admin') })).ok);
});

test('分叉：看不见项目的人拿到 not_found（不泄露会话存在）', async () => {
  const w = await world({ members: [] });
  const result = await forkSessionUseCase(w.deps, { sessionId: w.session.id, agentId: 'fake', model: 'm1', actor: principal('u2', 'member') });
  assert.equal(!result.ok && result.error.code, 'not_found');
});
