import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asProjectId, type AccessPolicy, type Project, type Session, type Subject } from '@agent-hub/domain';
import { createMessageObserveReader, MESSAGE_OBSERVE_SCAN, type MessageObserveRecord } from './observe-message.ts';

const project: Project = {
  id: asProjectId('p'), name: 'Fixture', repo: null, repos: [], description: null, createdAt: 0,
  teamId: 't', createdBy: 'u', members: [], worktree: null, checks: [], assetSetIds: [], deletedAt: null
};
const subject = (id: string): Subject => ({ user: { id, teamId: 't', role: 'member', clusterAdmin: false, disabledAt: null, deletedAt: null } } as Subject);
const policy: AccessPolicy = { context: async () => ({ hubTeamId: 't', settings: { membersCanAddMachines: true } }), worker: async () => ({ teamId: 't' }) };
const row = (over: Partial<MessageObserveRecord> = {}): MessageObserveRecord => ({ id: 'm', projectId: 'p', fromSessionId: 'a', targetSessionId: 'b', replyTo: null, state: 'delivered', createdAt: 100, deliveredAt: 200, readAt: 300, handoffOrigin: null, ...over });
const query = { since: 0, source: null, projectId: null, needsLook: false, limit: 10 };
function world(rows: readonly MessageObserveRecord[] = [row()], sessions: readonly Session[] = [
  { id: 'a', taskId: null, originProjectId: 'p', createdBy: 'u' } as Session,
  { id: 'b', taskId: null, originProjectId: 'p', createdBy: 'u' } as Session
]) {
  const calls: string[] = [];
  const scans: unknown[] = [];
  const reader = createMessageObserveReader({
    projects: { list: async () => [project], byId: async (id) => id === 'p' ? project : null },
    tasks: { byId: async () => null },
    sessions: { byId: async (id) => sessions.find((s) => s.id === id) ?? null },
    records: {
      list: (input) => { scans.push(input); return rows.filter((r) => input.projectIds.includes(r.projectId) && r.createdAt >= input.since).slice(0, input.limit); },
      byId: (id) => { calls.push(id); return rows.find((r) => r.id === id) ?? null; }
    }, policy
  });
  return { reader, calls, scans };
}

test('both session endpoints require current access and canonical same-project binding', async () => {
  const good = world();
  assert.equal((await good.reader.list(query, subject('u'))).items.length, 1);
  assert.ok(await good.reader.get('m', subject('u')));
  assert.equal(await good.reader.get('m', subject('other')), null);
  assert.equal((await good.reader.list(query, subject('other'))).items.length, 0);
  for (const endpoint of [
    { id: 'b', taskId: null, originProjectId: 'p', createdBy: 'other' },
    { id: 'b', taskId: null, originProjectId: 'other', createdBy: 'u' },
    { id: 'b', taskId: 'missing', originProjectId: 'p', createdBy: 'u' }
  ]) {
    const w = world([row()], [{ id: 'a', taskId: null, originProjectId: 'p', createdBy: 'u' } as Session, endpoint as Session]);
    assert.equal(await w.reader.get('m', subject('u')), null);
    assert.equal((await w.reader.list(query, subject('u'))).items.length, 0);
  }
  assert.equal(await world([row({ targetSessionId: 'external:secret' })]).reader.get('m', subject('u')), null);
});

test('only exact separately authorized reply_to links, never trace or guessed handoff; timestamps are stored facts', async () => {
  const first = row({ id: 'reply', replyTo: 'ask', handoffOrigin: 'handoff_bus', ...({ body: 'secret-body', parts: 'secret-parts', traceId: 'secret-trace' } as object) });
  const ask = row({ id: 'ask', deliveredAt: null, readAt: null, handoffOrigin: 'untrusted' });
  const w = world([first, ask, row({ id: 'same-trace' })]);
  const trace = await w.reader.get('reply', subject('u'));
  assert.ok(trace);
  assert.deepEqual(trace.nodes[0]?.links, [{ to: 'message:ask', label: '回复此消息' }]);
  assert.equal(trace.nodes.length, 2);
  assert.deepEqual(w.calls, ['reply', 'ask']);
  assert.equal(trace.nodes[0]?.startedAt, null);
  assert.equal(trace.nodes[0]?.endedAt, null);
  assert.equal(trace.nodes[0]?.attrs.find((a) => a.key === '消息记录的投递时间')?.value, new Date(200).toISOString());
  assert.equal(trace.nodes[0]?.attrs.find((a) => a.key === '消息记录的读取时间')?.value, new Date(300).toISOString());
  assert.ok(trace.nodes[0]?.attrs.some((a) => a.value === '项目交接'));
  assert.ok(!trace.nodes[1]?.attrs.some((a) => a.value === '项目交接'));
  assert.doesNotMatch(JSON.stringify(trace), /secret|same-trace|untrusted/);
  const denied = world([first, row({ id: 'ask', targetSessionId: 'missing' })]);
  const restricted = await denied.reader.get('reply', subject('u'));
  assert.equal(restricted?.nodes.length, 1);
  assert.deepEqual(restricted?.nodes[0]?.links, []);
  assert.doesNotMatch(JSON.stringify(restricted), /ask/);
  const noLink = await world([row(), row({ id: 'same-trace' })]).reader.get('m', subject('u'));
  assert.equal(noLink?.nodes.length, 1);
});

test('scan is bounded, scoped, truncated honestly, and filters occur after access', async () => {
  const rows = Array.from({ length: MESSAGE_OBSERVE_SCAN + 1 }, (_, i) => row({ id: `m${i}`, state: 'done' }));
  const w = world(rows);
  const result = await w.reader.list({ ...query, needsLook: true }, subject('u'));
  assert.deepEqual(result.items, []);
  assert.equal(result.truncated, true);
  assert.deepEqual(w.scans[0], { projectIds: ['p'], since: 0, limit: 501 });
  const limited = await w.reader.list({ ...query, limit: 1 }, subject('u'));
  assert.equal(limited.items.length, 1);
  assert.equal(limited.truncated, true);
});
