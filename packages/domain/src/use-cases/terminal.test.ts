import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDescriptor } from '../agent.ts';
import type { Principal, User } from '../account.ts';
import type { TeamId, UserId } from '../account.ts';
import { asLoginId, asTeamId, asUserId } from '../account.ts';
import { asAgentId } from '../ids.ts';
import { available, capabilityMatrix } from '../capability.ts';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { createAccessPolicy as createAccessPolicyForTests } from './authorization.ts';
import { createProjectUseCase } from './projects.ts';
import { createTaskUseCase } from './tasks.ts';
import { deriveSessionUseCase } from './sessions.ts';
import { terminalTarget } from './terminal.ts';

const fake: AgentDescriptor = {
  id: asAgentId('fake'),
  label: 'Fake',
  capabilities: capabilityMatrix({
    prompt: available,
    interrupt: available,
    fork: available,
    resume: available,
    tool_calls: available,
    artifacts: available,
    structured_events: available,
    attachments: available
  }),
  models: ['m1'],
  defaultModel: 'm1',
  options: []
};

function userOf(id: string, teamId: string, options: { role?: User['role']; clusterAdmin?: boolean } = {}): User {
  return {
    id: asUserId(id) as UserId,
    email: `${id}@example.com`,
    displayName: id,
    role: options.role ?? 'owner',
    passwordHash: null,
    emailVerifiedAt: 1,
    disabledAt: null,
    createdAt: 1,
    teamId: asTeamId(teamId) as TeamId,
    clusterAdmin: options.clusterAdmin ?? false,
    deletedAt: null
  };
}

function principalOf(user: User): Principal {
  return { user, loginId: asLoginId(`login-${user.id}`) };
}

async function world() {
  const w = inMemoryDeps();
  w.agents.push(fake);
  const owner = principalOf(userOf('owner', 'team-1', { clusterAdmin: true }));
  const project = await createProjectUseCase(w.deps, { name: 'demo', rootPath: '/tmp/demo', actor: owner });
  assert.ok(project.ok, JSON.stringify(project));
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: 't' });
  assert.ok(task.ok);
  const session = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  assert.ok(session.ok, JSON.stringify(session));
  const policy = createAccessPolicyForTests({
    users: {
      firstClusterAdmin: async () => owner.user,
      byId: async (id) => (id === owner.user.id ? owner.user : null)
    },
    settings: { get: async () => ({ openRegistration: false, membersCanAddMachines: true, refuseWhenFull: [] }) },
    enrollment: { credentialFor: async () => null },
    gateway: { status: async () => w.workers }
  });
  return { ...w, owner, project: project.value, session: session.value, policy };
}

test('终端的机器与目录：看得见的会话给出 locationOf 的 workerId + root', async () => {
  const w = await world();
  const target = await terminalTarget({ ...w.deps, access: w.policy }, w.owner, w.session.id);
  assert.ok(target.ok, JSON.stringify(target));
  assert.equal(target.value.root, '/tmp/demo');
  assert.equal(target.value.workerId, 'local');
});

test('终端授权：别的团队看不见这个项目，也不泄露会话存在', async () => {
  const w = await world();
  const outsider = principalOf(userOf('outsider', 'team-2', { role: 'member' }));
  const target = await terminalTarget({ ...w.deps, access: w.policy }, outsider, w.session.id);
  assert.equal(target.ok, false);
  assert.equal(target.error.code, 'not_found');
});

test('终端授权：没登录一律拒绝', async () => {
  const w = await world();
  const target = await terminalTarget({ ...w.deps, access: w.policy }, null, w.session.id);
  assert.equal(target.ok, false);
  assert.equal(target.error.code, 'not_found');
});

test('终端目标：没有可用工作空间时报「这条会话还没有工作空间」', async () => {
  const w = await world();
  const workspace = w.session.workspaceId ? await w.deps.workspaces.byId(w.session.workspaceId) : null;
  assert.ok(workspace);
  await w.deps.workspaces.save({ ...workspace, state: 'removed' });
  const target = await terminalTarget({ ...w.deps, access: w.policy }, w.owner, w.session.id);
  assert.equal(target.ok, false);
  assert.equal(target.error.message, '这条会话还没有工作空间');
});
