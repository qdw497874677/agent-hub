import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  asAgentId,
  available,
  capabilityMatrix,
  type AgentDescriptor,
  type SessionProvenance,
  type User,
  type UserId
} from '@agent-hub/domain';
import { inMemoryDeps } from '@agent-hub/domain/testing';
import { loadActor, openRoleSession } from './role-session.ts';

const fake: AgentDescriptor = {
  id: asAgentId('fake'),
  label: 'Fake',
  capabilities: capabilityMatrix({ prompt: available, interrupt: available, fork: available, resume: available, tool_calls: available, artifacts: available, structured_events: available, attachments: available }),
  models: ['m'],
  defaultModel: 'm',
  options: []
};

function user(over: Partial<User> = {}): User {
  return {
    id: 'u1' as UserId,
    email: 'a@b.co',
    displayName: '甲',
    role: 'owner',
    passwordHash: null,
    emailVerifiedAt: 1,
    disabledAt: null,
    createdAt: 1,
    teamId: null,
    clusterAdmin: true,
    deletedAt: null,
    ...over
  };
}

async function world() {
  const w = inMemoryDeps();
  w.agents.push(fake);
  const project = await (await import('@agent-hub/domain')).createProjectUseCase(w.deps, { name: 'demo', rootPath: '/tmp/demo' });
  assert.ok(project.ok);
  const rows = new Map<string, User>([[user().id, user()]]);
  const users = {
    save: async (row: User) => void rows.set(row.id, row),
    byId: async (id: string) => rows.get(id) ?? null,
    byEmail: async () => null,
    firstWithRole: async () => null,
    claimFirstOwner: async () => false,
    firstClusterAdmin: async () => null,
    list: async () => [...rows.values()]
  };
  const provenance: SessionProvenance[] = [];
  const order: string[] = [];
  return { w, project: project.value, users, rows, provenance, order };
}

test('停用或已删除的账号不能当发起人', async () => {
  const w = await world();
  assert.ok(await loadActor(w.users, undefined, 'u1', 'agent-message'));
  w.rows.set('u1', user({ disabledAt: 2 }));
  assert.equal(await loadActor(w.users, undefined, 'u1', 'agent-group'), null);
  w.rows.set('u1', user({ disabledAt: null, deletedAt: 3 }));
  assert.equal(await loadActor(w.users, undefined, 'u1', 'agent-connector'), null);
});

test('P2P 写 via=bot，群写 via=group；连接器先记派生再写 via=bot', async () => {
  const w = await world();
  const actor = await loadActor(w.users, undefined, 'u1', 'agent-message');
  assert.ok(actor);
  const provenance = {
    provenance: { record: async (row: SessionProvenance) => { w.order.push(`prov:${row.via}`); w.provenance.push(row); return true; }, get: async () => null },
    now: () => 9
  };
  const bot = await openRoleSession(w.w.deps, provenance, {
    projectId: w.project.id, title: 'p2p', ownerId: 'u1', agentId: 'fake', model: 'm', actor, via: 'bot'
  });
  assert.ok(bot.ok);
  const groupActor = await loadActor(w.users, undefined, 'u1', 'agent-group');
  assert.ok(groupActor);
  const group = await openRoleSession(w.w.deps, provenance, {
    projectId: w.project.id, title: 'group', ownerId: 'u1', agentId: 'fake', model: 'm', actor: groupActor, via: 'group'
  });
  assert.ok(group.ok);
  const spawned: string[] = [];
  const connector = await openRoleSession(w.w.deps, provenance, {
    projectId: w.project.id, title: 'connector', ownerId: 'u1', agentId: 'fake', model: 'm', actor, via: 'bot',
    afterDerive: async (session) => { spawned.push(session.id); w.order.push('spawn'); }
  });
  assert.ok(connector.ok);
  assert.deepEqual(w.provenance.map((row) => row.via), ['bot', 'group', 'bot']);
  assert.deepEqual(spawned, [connector.value.id]);
  const spawnAt = w.order.indexOf('spawn');
  const provAt = w.order.lastIndexOf('prov:bot');
  assert.ok(spawnAt >= 0 && spawnAt < provAt);
});

test('任务建不成或没有这个运行时：不写来历、不写派生记录', async () => {
  const w = await world();
  const actor = await loadActor(w.users, undefined, 'u1', 'agent-connector');
  assert.ok(actor);
  let spawned = 0;
  const provenance = {
    provenance: { record: async () => { w.order.push('prov'); return true; }, get: async () => null },
    now: () => 9
  };
  const missingProject = await openRoleSession(w.w.deps, provenance, {
    projectId: 'nope', title: 'x', ownerId: 'u1', agentId: 'fake', model: 'm', actor, via: 'bot',
    afterDerive: async () => { spawned += 1; }
  });
  assert.equal(missingProject.ok, false);
  const missingAgent = await openRoleSession(w.w.deps, provenance, {
    projectId: w.project.id, title: 'x', ownerId: 'u1', agentId: 'missing', model: 'm', actor, via: 'group',
    afterDerive: async () => { spawned += 1; }
  });
  assert.equal(missingAgent.ok, false);
  assert.equal(spawned, 0);
  assert.deepEqual(w.order, []);
});
