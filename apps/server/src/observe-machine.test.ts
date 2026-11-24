import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asLoginId, asTeamId, asUserId, type Principal, type User, type WorkerCredential } from '@agent-hub/domain';
import { createMachineObserveReader, type MachineObserveRecord, type MachineObserveBinding } from './observe-machine.ts';

const user: User = { id: asUserId('u'), email: 'u@test', displayName: 'u', role: 'member', teamId: asTeamId('t'), clusterAdmin: false, disabledAt: null, deletedAt: null, emailVerifiedAt: 0, passwordHash: null, createdAt: 0 };
const member: Principal = { user, loginId: asLoginId('login') };
const admin: Principal = { ...member, user: { ...user, clusterAdmin: true } };
const query = { since: 0, source: null, projectId: null, needsLook: false, limit: 10 };

test('current enrollment and owner authorization independently protect list and detail, including role collisions', async () => {
    const rows: MachineObserveRecord[] = [
      { id: 'remote', workerId: 'same', origin: 'remote', enrollment: { enrolledBy: 'u', createdAt: 1 }, connectedAt: 2, disconnectedAt: null },
      { id: 'local', workerId: 'same', origin: 'local', enrollment: null, connectedAt: 1, disconnectedAt: null }
    ];
    const matches = (row: MachineObserveRecord, b: MachineObserveBinding) => row.origin === b.origin && (b.origin === 'local' || (row.workerId === b.workerId && row.enrollment?.enrolledBy === b.enrolledBy && row.enrollment.createdAt === b.createdAt));
    const records = { list: ({ bindings }: { bindings: readonly MachineObserveBinding[] }) => rows.filter((r) => bindings.some((b) => matches(r, b))), byId: (id: string) => rows.find((r) => r.id === id) ?? null };
    let credential = { workerId: 'same', enrolledBy: asUserId('u'), createdAt: 1, revokedAt: null } as WorkerCredential;
    let owner: User | null = user;
    const reader = createMachineObserveReader({ records, enrollment: { listCredentials: async () => credential ? [credential] : [], credentialFor: async () => credential }, users: { byId: async () => owner }, policy: { context: async () => ({ hubTeamId: 't', settings: { membersCanAddMachines: true } }), worker: async () => { throw new Error('must not infer live role'); } } });
    assert.deepEqual((await reader.list(query, member)).items.map((i) => i.id), ['machine:remote']);
    assert.equal(await reader.get('local', member), null);
    assert.ok(await reader.get('local', admin));
    assert.equal((await reader.list({ ...query, projectId: 'p' }, admin)).items.length, 0);
    const token: Principal = { ...admin, via: { tokenId: 't', name: 'x', kind: 'personal', permissions: ['worker.read'] } };
    assert.equal(await reader.get('local', token), null);
    assert.ok(await reader.get('remote', token));
    for (const next of [{ ...credential, revokedAt: 5 }, { ...credential, createdAt: 2 }, null]) {
      credential = next as WorkerCredential;
      assert.equal(await reader.get('remote', member), null);
      assert.equal((await reader.list(query, member)).items.length, 0);
    }
    credential = { workerId: 'same', enrolledBy: asUserId('u'), createdAt: 1, revokedAt: null } as WorkerCredential;
    for (owner of [null, { ...user, disabledAt: 10 }, { ...user, deletedAt: 10 }, { ...user, teamId: asTeamId('other') }]) {
      assert.equal(await reader.get('remote', member), null);
      assert.equal((await reader.list(query, member)).items.length, 0);
    }
});

test('reader excludes oversized or malformed record and credential identifiers while retaining valid records', async () => {
  const bad = '界'.repeat(171);
  const rows: MachineObserveRecord[] = [
    { id: 'valid', workerId: 'w', origin: 'remote', enrollment: { enrolledBy: 'u', createdAt: 1 }, connectedAt: 1, disconnectedAt: null },
    { id: 'bad-worker', workerId: bad, origin: 'remote', enrollment: { enrolledBy: 'u', createdAt: 1 }, connectedAt: 2, disconnectedAt: null },
    { id: 'bad-owner', workerId: 'w', origin: 'remote', enrollment: { enrolledBy: bad, createdAt: 1 }, connectedAt: 3, disconnectedAt: null },
    { id: bad, workerId: 'w', origin: 'remote', enrollment: { enrolledBy: 'u', createdAt: 1 }, connectedAt: 4, disconnectedAt: null },
    { id: 'bad-control', workerId: 'w\0x', origin: 'local', enrollment: null, connectedAt: 5, disconnectedAt: null }
  ];
  const good = { workerId: 'w', enrolledBy: asUserId('u'), createdAt: 1, revokedAt: null } as WorkerCredential;
  const credentials = [good, { ...good, workerId: bad }, { ...good, enrolledBy: asUserId(bad) }, { ...good, workerId: '\ud800' }];
  let bindings: readonly MachineObserveBinding[] = [];
  const reader = createMachineObserveReader({
    records: { list: (input) => { bindings = input.bindings; return rows; }, byId: (id) => rows.find((r) => r.id === id) ?? null },
    enrollment: { listCredentials: async () => credentials, credentialFor: async () => good },
    users: { byId: async () => user },
    policy: { context: async () => ({ hubTeamId: 't', settings: { membersCanAddMachines: true } }), worker: async () => { throw new Error('unexpected lookup'); } }
  });
  assert.deepEqual((await reader.list(query, admin)).items.map((item) => item.id), ['machine:valid']);
  assert.deepEqual(bindings, [{ origin: 'local' }, { origin: 'remote', workerId: 'w', enrolledBy: 'u', createdAt: 1 }]);
  for (const id of ['bad-worker', 'bad-owner', bad, 'bad-control']) assert.equal(await reader.get(id, admin), null);
  assert.ok(await reader.get('valid', admin));
});

test('authorized detail links only exact install reports and indicates truncation', async () => {
  const rows: MachineObserveRecord[] = [
    { id: 'one', workerId: 'w', origin: 'remote', enrollment: { enrolledBy: 'u', createdAt: 1 }, connectedAt: 10, disconnectedAt: 20 },
    { id: 'two', workerId: 'w', origin: 'remote', enrollment: { enrolledBy: 'u', createdAt: 1 }, connectedAt: 30, disconnectedAt: null }
  ];
  const credential = { workerId: 'w', enrolledBy: asUserId('u'), createdAt: 1, revokedAt: null } as WorkerCredential;
  let calls = 0;
  let revoked = false;
  const reader = createMachineObserveReader({
    records: {
      list: () => rows,
      byId: (id) => rows.find((r) => r.id === id) ?? null,
      installs: (id) => { calls++; return { items: id === 'one' ? [{ id: '1', state: 'succeeded' as const, at: 11 }, { id: '2', state: 'failed' as const, at: 11 }, { id: '3', state: 'refused' as const, at: 12 }] : [], truncated: id === 'one' }; }
    },
    enrollment: { listCredentials: async () => [credential], credentialFor: async () => revoked ? { ...credential, revokedAt: 99 } : credential },
    users: { byId: async () => user },
    policy: { context: async () => ({ hubTeamId: 't', settings: { membersCanAddMachines: true } }), worker: async () => { throw new Error('unexpected'); } }
  });
  const trace = await reader.get('one', member);
  assert.ok(trace);
  assert.deepEqual(trace.nodes[0]?.links.map((l) => l.to), ['machine-install:1', 'machine-install:2', 'machine-install:3']);
  assert.deepEqual(trace.nodes.slice(1).map((n) => n.stateLabel), ['报告安装成功', '报告安装失败', '报告拒绝安装']);
  assert.match(JSON.stringify(trace.nodes[0]?.attrs), /部分报告未保留或未展示/);
  assert.equal((await reader.get('two', member))?.nodes.length, 1);
  const before = calls;
  revoked = true;
  assert.equal(await reader.get('one', member), null);
  assert.equal(calls, before);
  revoked = false;
  assert.deepEqual((await reader.list(query, member)).items.map((i) => i.nativeState), ['disconnected', 'connected']);
  assert.equal(calls, before);
  assert.deepEqual((await reader.list({ ...query, needsLook: true }, member)).items, []);
});
