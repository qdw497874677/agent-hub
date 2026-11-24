import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asLoginId, asProjectId, asSessionId, asTaskId, asTeamId, asUserId, authorizeProject, type AccessPolicy, type BotId, type Principal, type Project, type Session, type Subject } from '@agent-hub/domain';
import type { ObserveTrace } from '@agent-hub/observe';
import { createWorkObserveReaders, type WorkObserveRecord } from './observe-work.ts';

const subject = { user: { id: 'u' } } as Subject;
const project = { id: 'p', deletedAt: null } as Project;
const base: WorkObserveRecord = { id: 'd', accountId: 'u', projectId: 'p', taskId: 't', sessionId: 's', state: 'running', createdAt: 100, notified: true };
const query = { since: 0, source: null, projectId: null, needsLook: false, limit: 10 };

function world(row: WorkObserveRecord = base, options: { taskProject?: string; session?: Partial<Session> | null; sessionError?: boolean; deleted?: boolean; policy?: AccessPolicy } = {}) {
  const p = { ...project, teamId: 'team', createdBy: 'u', members: [], deletedAt: options.deleted ? 1 : null } as Project;
  const session = options.session === null ? null : { id: 's', taskId: 't', originProjectId: 'p', createdBy: 'u', ...options.session } as Session;
  const calls: unknown[] = [];
  const readers = createWorkObserveReaders({
    projects: { list: async () => [p], byId: async (id) => id === p.id ? p : null },
    tasks: { byId: async () => ({ id: 't', projectId: options.taskProject ?? 'p' }) as never },
    sessions: { byId: async () => { if (options.sessionError) throw new Error('private lookup error'); return session; } },
    records: { list: (_kind, input) => { calls.push(input); return [row]; }, byId: (_kind, _id, owner) => { calls.push(owner); return row; } },
    policy: options.policy
  });
  return { dispatch: readers[0]!, delegation: readers[1]!, calls };
}

test('owner and current project/task authorization apply to list and direct id', async () => {
  for (const w of [world({ ...base, accountId: 'other' }), world(base, { taskProject: 'other' }), world(base, { deleted: true })]) {
    assert.equal((await w.dispatch.list(query, subject)).items.length, 0);
    assert.equal(await w.dispatch.get('d', subject), null);
  }
  const w = world();
  assert.equal(await w.dispatch.get('wrong-id', subject), null);
  assert.equal(await w.dispatch.get('d', { system: true }), null);
  assert.equal((await w.dispatch.list({ ...query, projectId: 'other' }, subject)).items.length, 0);
  assert.equal((await w.dispatch.list(query, subject)).items.length, 1);
  assert.deepEqual(w.calls.at(-1), { accountId: 'u', projectIds: ['p'], since: 0, limit: 501 });
});

test('delegation execution link requires native owner and root-session identity, but work remains visible', async () => {
  const row: WorkObserveRecord = { ...base, state: 'prepared', notified: null };
  const policy: AccessPolicy = { context: async () => ({ hubTeamId: 'team', settings: { membersCanAddMachines: true } }), worker: async () => ({ teamId: 'team' }) };
  const human: Principal = { loginId: asLoginId('login'), user: {
    id: asUserId('u'), email: 'u@example.test', displayName: 'u', role: 'member', teamId: asTeamId('team'),
    clusterAdmin: false, disabledAt: null, deletedAt: null, emailVerifiedAt: 0, passwordHash: null, createdAt: 0
  } };
  const link = (trace: ObserveTrace | null) => trace?.nodes[0]?.attrs.some((a) => a.key === '会话') ?? false;
  const positive = await world(row, { policy }).delegation.get('d', human);
  assert.ok(positive);
  assert.equal(link(positive), true);
  for (const session of [null, { id: asSessionId('other') }, { taskId: asTaskId('other') },
    { createdBy: asUserId('other') }, { createdBy: null }, { botId: 'bot' as BotId },
    { kind: 'side' as const }, { parentSessionId: asSessionId('parent') }, { originProjectId: asProjectId('other') }]) {
    const trace = await world(row, { policy, session }).delegation.get('d', human);
    assert.ok(trace);
    assert.equal(link(trace), false);
  }
  const token: Principal = { ...human, via: { tokenId: 'token', name: 'task token', kind: 'personal', permissions: ['project.read', 'task.read', 'session.read'] } };
  const tokenTrace = await world(row, { policy }).delegation.get('d', token);
  assert.ok(tokenTrace);
  assert.equal(link(tokenTrace), false);
  const failedLookup = await world(row, { policy, sessionError: true }).delegation.get('d', human);
  assert.ok(failedLookup);
  assert.equal(link(failedLookup), false);
  let calls = 0;
  const failingSessionPolicy: AccessPolicy = { ...policy, context: async () => {
    if (++calls > 1) throw new Error('private session authorization error');
    return policy.context();
  } };
  const failedAuth = await world(row, { policy: failingSessionPolicy }).delegation.get('d', human);
  assert.ok(failedAuth);
  assert.equal(link(failedAuth), false);
});

test('session link requires session.read independently of readable project', async () => {
  const policy: AccessPolicy = { context: async () => ({ hubTeamId: 'team', settings: { membersCanAddMachines: true } }), worker: async () => ({ teamId: 'team' }) };
  const member = { user: { id: 'u', role: 'member', teamId: 'team', clusterAdmin: false, disabledAt: null, deletedAt: null } } as Subject;
  const trace = await world(base, { policy, session: { createdBy: 'other' } }).dispatch.get('d', member);
  assert.ok(trace);
  assert.equal(trace.nodes[0]?.attrs.some((a) => a.key === '会话'), false);
});

test('task.read is required before list scan and on direct lookup for both sources', async () => {
  const policy: AccessPolicy = { context: async () => ({ hubTeamId: 'team', settings: { membersCanAddMachines: true } }), worker: async () => ({ teamId: 'team' }) };
  const human: Principal = { loginId: asLoginId('login'), user: {
    id: asUserId('u'), email: 'u@example.test', displayName: 'u', role: 'member', teamId: asTeamId('team'),
    clusterAdmin: false, disabledAt: null, deletedAt: null, emailVerifiedAt: 0, passwordHash: null, createdAt: 0
  } };
  const projectOnly: Principal = { ...human, via: { tokenId: 'token', name: 'project only', kind: 'personal', permissions: ['project.read'] } };
  const readableProject = { ...project, teamId: 'team', createdBy: 'u', members: [] } as Project;
  assert.equal((await authorizeProject(policy, projectOnly, readableProject, 'project.read')).ok, true);
  assert.equal((await authorizeProject(policy, projectOnly, readableProject, 'task.read')).ok, false);
  for (const [kind, row] of [['dispatch', base], ['delegation', { ...base, state: 'prepared', notified: null }]] as const) {
    const w = world(row, { policy });
    const reader = w[kind];
    assert.equal((await reader.list(query, projectOnly)).items.length, 0);
    assert.equal((await reader.list({ ...query, projectId: 'p' }, projectOnly)).items.length, 0);
    assert.equal(w.calls.length, 0, 'no scan for projects without task.read');
    assert.equal(await reader.get('d', projectOnly), null);
    assert.equal((await reader.list(query, human)).items.length, 1);
    assert.ok(await reader.get('d', human));
    const foreign = world({ ...row, accountId: 'other' }, { policy });
    assert.equal((await foreign[kind].list(query, human)).items.length, 0);
    assert.equal(await foreign[kind].get('d', human), null);
  }
});

test('only exact authorized existing execution session appears; no inferred timestamps or secret metadata', async () => {
  for (const session of [null, { taskId: asTaskId('other') }, { originProjectId: asProjectId('other') }, { id: asSessionId('other') }]) {
    const trace = await world(base, { session }).dispatch.get('d', subject);
    assert.ok(trace);
    assert.equal(trace.nodes[0]?.attrs.some((a) => a.key === '会话'), false);
  }
  const trace = await world({ ...base, ...({ goal: 'secret', result: 'secret', startedAt: 123 } as object) }).dispatch.get('d', subject);
  assert.ok(trace);
  assert.equal(trace.nodes[0]?.attrs.some((a) => a.key === '会话' && a.value === 's'), true);
  assert.equal(trace.nodes[0]?.startedAt, null);
  assert.equal(trace.nodes[0]?.endedAt, null);
  assert.match(JSON.stringify(trace), /不代表收到/);
  assert.doesNotMatch(JSON.stringify(trace), /secret/);
  assert.deepEqual(trace.nodes[0]?.links, []);
  const legacy = await world(base, { session: { originProjectId: undefined } }).dispatch.get('d', subject);
  assert.equal(legacy?.nodes[0]?.attrs.some((a) => a.key === '会话' && a.value === 's'), true);
});

test('delegation prepared is not completion, uncertain is distinct and actionable; invalid state fails closed', async () => {
  const prepared = { ...base, state: 'prepared', notified: null };
  const trace = await world(prepared, { session: null }).delegation.get('d', subject);
  assert.match(JSON.stringify(trace), /不代表 Agent 已完成/);
  assert.equal(trace?.nodes[0]?.startedAt, null);
  const uncertain = world({ ...prepared, state: 'uncertain' }).delegation;
  assert.equal((await uncertain.list({ ...query, needsLook: true }, subject)).items[0]?.gap, '结果不确定');
  assert.equal(await world({ ...prepared, state: 'secret' }).delegation.get('d', subject), null);
});
