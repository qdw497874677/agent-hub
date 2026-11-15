import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Principal } from '../account.ts';
import type { ConnectorBinding, TriggerRun, TriggerRunState } from '../connector.ts';
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
    countSince: async (bindingId, since) => (runs.get(bindingId) ?? []).filter((r) => r.createdAt >= since).length,
    openRuns: async (bindingId) => (runs.get(bindingId) ?? []).filter((r) => r.state === 'waiting' || r.state === 'delivered'),
    waitingRuns: async () => [],
    deliveredRuns: async () => [],
    postingBefore: async (before) => [...runs.values()].flat().filter((r) => r.state === 'posting' && r.updatedAt < before),
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

const harness = (opts: { delivery?: 'poll' | 'push'; busy?: boolean; deliverError?: string; group?: { id: string; projectId: string } | null; echo?: string[]; postError?: { code: 'unavailable' | 'forbidden'; message: string } } = {}) => {
  const { store, bindings, runs } = memoryStore();
  const clock = { now: 1_000 };
  const delivered: Array<{ sessionId: string; text: string }> = [];
  const posts = new Map<string, { postId: string; externalId: string; text: string; author: string }>();
  const postCalls: Array<{ externalId: string; text: string }> = [];
  const group = opts.group === undefined ? { id: 'g1', projectId: 'p1' } : opts.group;
  const hub = createConnectorHub({
    now: () => clock.now,
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
    },
    groupOf: async (id: string) => (group && group.id === id ? group : null),
    principalOf: async () => principal,
    outbox: {
      echoCandidates: async (target: { kind: string; id: string }) => (target.kind === 'group' && target.id === 'g1' ? opts.echo ?? [] : []).map((externalMessageId) => ({ externalMessageId }) as never)
    },
    postExternal: async ({ author, text, externalId }: { author: string; text: string; externalId: string }) => {
      if (opts.postError) return { ok: false as const, error: opts.postError };
      postCalls.push({ externalId, text });
      const seen = posts.get(externalId);
      if (seen) return { ok: true as const, value: { postId: seen.postId } };
      const postId = `post_${posts.size + 1}`;
      posts.set(externalId, { postId, externalId, text, author });
      return { ok: true as const, value: { postId } };
    }
  } as never);
  return { hub, bindings, runs, delivered, posts, postCalls, at: (ms: number) => void (clock.now = ms) };
};

const groupBinding = (patch: Partial<ConnectorBinding> = {}): ConnectorBinding => ({
  id: 'b1', connector: 'slack', kind: 'message', agentProjectId: 'p1', agentName: 'echo', projectId: null, name: 'slack',
  target: 'main', targetKind: 'group', groupId: 'g1', params: {}, enabled: true, pausedReason: null,
  consecutiveFailures: 0, nextRunAt: null, mainSessionId: null, createdBy: 'u1', timeZone: 'UTC',
  createdAt: 1, updatedAt: 1, ...patch
});

test('C3：群目标可以创建，群必须在 bot 能用的项目里（#219）', async () => {
  const { hub, bindings } = harness();
  const created = await hub.create(principal, 'p1', 'echo', { connector: 'slack', kind: 'message', name: 'slack', targetKind: 'group', groupId: 'g1', params: {} });
  assert.ok(created.ok);
  assert.equal(created.ok && created.value.targetKind, 'group');
  assert.equal(created.ok && created.value.groupId, 'g1');
  assert.equal(bindings.get(created.ok ? created.value.id : '')?.groupId, 'g1');
});

test('C3：群不属于这个 bot 的项目时拒绝创建', async () => {
  const { hub, bindings } = harness({ group: { id: 'g1', projectId: 'other' } });
  const created = await hub.create(principal, 'p1', 'echo', { connector: 'slack', kind: 'message', name: 'slack', targetKind: 'group', groupId: 'g1', params: {} });
  assert.equal(created.ok, false);
  assert.match(created.ok ? '' : created.error.message, /能用的项目/);
  assert.equal(bindings.size, 0);
});

test('C3：同一个 externalId 只落一帖，run 记 posted + postId', async () => {
  const { hub, bindings, runs, posts, postCalls } = harness();
  await bindings.set('b1', groupBinding());
  await hub.emit('b1', { kind: 'message', externalId: 'x1', title: 'a', text: 'hello' });
  await hub.emit('b1', { kind: 'message', externalId: 'x1', title: 'a', text: 'hello again' });
  assert.equal(posts.size, 1);
  assert.equal(postCalls.length, 1);
  assert.equal(runs.get('b1')?.length, 1, '重复 externalId 不再新建 run');
  const [run] = runs.get('b1') ?? [];
  assert.equal(run?.state, 'posted');
  assert.equal(run?.postId, 'post_1');
});

test('C3：自己发出去的消息回流算回声，直接 skipped', async () => {
  const { hub, bindings, runs, posts } = harness({ echo: ['x1'] });
  await bindings.set('b1', groupBinding());
  await hub.emit('b1', { kind: 'message', externalId: 'x1', title: 'a', text: 'hi' });
  assert.equal(posts.size, 0);
  const [run] = runs.get('b1') ?? [];
  assert.equal(run?.state, 'skipped');
  assert.match(run?.reason ?? '', /回声/);
});

test('C3：同一 binding 每分钟最多 30 条外部入站，超出记 skipped', async () => {
  const { hub, bindings, runs, posts } = harness();
  await bindings.set('b1', groupBinding());
  for (let i = 0; i < 31; i++) await hub.emit('b1', { kind: 'message', externalId: `x${i}`, title: 't', text: 'hi' });
  assert.equal(posts.size, 30);
  const skipped = (runs.get('b1') ?? []).filter((r) => r.state === 'skipped');
  assert.equal(skipped.length, 1);
  assert.match(skipped[0]?.reason ?? '', /30 条/);
});

test('C3：posting 超时重放一次，同一 externalId 不会重复落帖', async () => {
  const { hub, bindings, runs, posts, at } = harness();
  await bindings.set('b1', groupBinding());
  await runs.set('b1', [{ id: 'r1', bindingId: 'b1', externalId: 'x1', plannedAt: null, catchup: false, state: 'posting', reason: null, sessionId: null, text: 'hi', createdAt: 1_000, updatedAt: 1_000 }]);
  at(1_000 + 61_000);
  assert.equal(await hub.sweepStale(), 1);
  assert.equal(posts.size, 1);
  assert.equal((runs.get('b1') ?? [])[0]?.state, 'posted');
  assert.equal(await hub.sweepStale(), 0, '已经 posted，不再重放');
  assert.equal(posts.size, 1);
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
