import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Principal } from '../account.ts';
import type { ConnectorBinding, InboundEvent, TriggerRun, TriggerRunState } from '../connector.ts';
import type { Project } from '../project.ts';
import type { ConnectorStore } from '../ports/connector-store.ts';
import type { InboundSource } from '../ports/inbound-source.ts';
import { createConnectorHub } from './connectors.ts';

/** 只实现被测路径用到的部分；其余调用直接炸，避免「看起来跑通了」。 */
const memoryStore = () => {
  const bindings = new Map<string, ConnectorBinding>();
  const runs = new Map<string, TriggerRun[]>();
  const store: ConnectorStore = {
    saveBinding: async (b) => void bindings.set(b.id, b),
    binding: async (id) => bindings.get(id) ?? null,
    bindingsOf: async (projectId, name) => [...bindings.values()].filter((b) => b.agentProjectId === projectId && b.agentName === name),
    bindingsFor: async (connector) => [...bindings.values()].filter((b) => b.connector === connector),
    allBindings: async () => [...bindings.values()],
    deleteBinding: async (id) => void bindings.delete(id),
    advance: async () => true,
    insertRun: async (r) => {
      const list = runs.get(r.bindingId) ?? [];
      if (list.some((x) => x.externalId === r.externalId)) return false;
      runs.set(r.bindingId, [...list, r]);
      return true;
    },
    hasRun: async (bindingId, externalId) => (runs.get(bindingId) ?? []).some((r) => r.externalId === externalId),
    saveRun: async (r) => {
      const list = runs.get(r.bindingId) ?? [];
      runs.set(r.bindingId, list.map((x) => (x.id === r.id ? r : x)));
    },
    runs: async (bindingId, limit) => (runs.get(bindingId) ?? []).slice(-limit).reverse(),
    run: async (id) => [...runs.values()].flat().find((r) => r.id === id) ?? null,
    runsSince: async () => [],
    countRunsByState: async () => ({}) as Record<TriggerRunState, number>,
    openRuns: async (bindingId) => (runs.get(bindingId) ?? []).filter((r) => r.state === 'waiting' || r.state === 'delivered'),
    waitingRuns: async () => [],
    deliveredRuns: async () => [],
    deliveredRunFor: async () => null,
    agentProjects: async () => [],
    setAgentProjects: async () => undefined
  };
  return { store, bindings, runs };
};

const principal = { kind: 'user', user: { id: 'u1', email: 'u1@example.com', displayName: 'U1' }, teamIds: [] } as unknown as Principal;

const project = { id: 'p1', name: 'P1', deletedAt: null, teamId: 't1' } as unknown as Project;

const source: InboundSource = {
  id: 'slack',
  kinds: ['message'],
  validate: () => null,
  describe: () => 'slack',
  start: () => ({ stop: () => undefined })
};

const harness = (opts: { delivery?: 'poll' | 'push'; busy?: boolean; deliverError?: string } = {}) => {
  const { store, bindings, runs } = memoryStore();
  const delivered: Array<{ sessionId: string; text: string }> = [];
  const hub = createConnectorHub({
    now: () => 1_000,
    projects: { byId: async (id: string) => (id === 'p1' ? project : null) },
    sessions: {},
    store,
    sources: [{ ...source, ...(opts.delivery ? { delivery: opts.delivery } : {}) }],
    agentExists: async () => true,
    spawn: async () => ({
      ok: true as const,
      value: { id: 's1', status: 'running', lastSeq: 0, taskId: null, projectId: 'p1', createdBy: 'u1' } as never
    }),
    busy: async () => opts.busy ?? false,
    deliver: async (sessionId: string, text: string) => {
      if (opts.deliverError) return { ok: false as const, error: { code: 'unavailable', message: opts.deliverError } };
      delivered.push({ sessionId, text });
      return { ok: true as const, value: null };
    }
  } as never);
  return { hub, bindings, runs, delivered };
};

const groupBinding = (patch: Partial<ConnectorBinding> = {}): ConnectorBinding => ({
  id: 'b1', connector: 'slack', kind: 'message', agentProjectId: 'p1', agentName: 'echo', projectId: null, name: 'slack',
  target: 'main', targetKind: 'group', groupId: 'g1', params: {}, enabled: true, pausedReason: null,
  consecutiveFailures: 0, nextRunAt: null, mainSessionId: null, createdBy: 'u1', timeZone: 'UTC',
  createdAt: 1, updatedAt: 1, ...patch
});

test('C1.1：群目标先拒绝创建（#221 步骤 0）', async () => {
  const { hub, bindings } = harness();
  const created = await hub.create(principal, 'p1', 'echo', { connector: 'slack', kind: 'message', name: 'slack', targetKind: 'group', groupId: 'g1', params: {} });
  assert.equal(created.ok, false);
  assert.match(created.ok ? '' : created.error.message, /群目标还没实现/);
  assert.equal(bindings.size, 0);
});

test('C1.1 兜底：旧数据里的群目标 binding 也不会投进私聊会话', async () => {
  const { hub, bindings, runs, delivered } = harness();
  await bindings.set('b1', groupBinding());
  const event: InboundEvent = { kind: 'message', externalId: 'x1', title: 'hello', text: 'hi' };
  await hub.emit('b1', event);
  assert.equal(delivered.length, 0);
  const [run] = runs.get('b1') ?? [];
  assert.equal(run?.state, 'skipped');
  assert.match(run?.reason ?? '', /群目标还没接线/);
});


test('推送型来源遇到忙不丢消息：排成 waiting，而不是像轮询那样跳过（#221 步骤 6）', async () => {
  const { hub, bindings, runs, delivered } = harness({ delivery: 'push', busy: true });
  await bindings.set('b1', groupBinding({ targetKind: 'session', groupId: null, target: 'new' }));
  await hub.emit('b1', { kind: 'message', externalId: 'x1', title: 'a', text: 'first' });
  await hub.emit('b1', { kind: 'message', externalId: 'x2', title: 'b', text: 'second' });
  assert.equal(delivered.length, 0);
  const queued = (runs.get('b1') ?? []).filter((r) => r.state === 'waiting');
  assert.equal(queued.length, 2, '两条推送都要留在队列里，不能丢');
  assert.deepEqual(queued.map((r) => r.externalId), ['x1', 'x2']);
});

test('轮询型来源按计划来的，忙时仍记 skipped（下次本来就还会再来）', async () => {
  const { hub, bindings, runs } = harness({ delivery: 'poll', busy: true });
  await bindings.set('b1', groupBinding({ targetKind: 'session', groupId: null, target: 'new' }));
  await hub.emit('b1', { kind: 'message', externalId: 'x1', title: 'a', text: 'first', plannedAt: 1_000 });
  await hub.emit('b1', { kind: 'message', externalId: 'x2', title: 'b', text: 'second', plannedAt: 1_000 });
  const states = (runs.get('b1') ?? []).map((r) => r.state);
  assert.deepEqual(states, ['waiting', 'skipped']);
});

test('基础设施中断记失败原因，但不计入连续失败（不会把触发暂停）', async () => {
  const { hub, bindings, runs } = harness({ deliverError: 'fetch failed: ECONNRESET' });
  await bindings.set('b1', groupBinding({ targetKind: 'session', groupId: null, target: 'new' }));
  await hub.emit('b1', { kind: 'message', externalId: 'x1', title: 'a', text: 'first' });
  const [run] = runs.get('b1') ?? [];
  assert.equal(run?.state, 'failed');
  assert.match(run?.reason ?? '', /ECONNRESET/);
  assert.equal((await bindings.get('b1'))?.consecutiveFailures, 0);
});
