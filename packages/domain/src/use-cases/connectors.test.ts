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

const harness = () => {
  const { store, bindings, runs } = memoryStore();
  const delivered: Array<{ sessionId: string; text: string }> = [];
  const hub = createConnectorHub({
    now: () => 1_000,
    projects: { byId: async (id: string) => (id === 'p1' ? project : null) },
    sessions: {},
    store,
    sources: [source],
    agentExists: async () => true,
    spawn: async () => {
      throw new Error('群目标不该走到派生会话这一步');
    },
    busy: async () => false,
    deliver: async (sessionId: string, text: string) => {
      delivered.push({ sessionId, text });
      return { ok: true, value: null };
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
