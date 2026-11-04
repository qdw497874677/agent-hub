import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  asAgentId, createAgentTaskToolProvider, createConnectorHub, createProjectUseCase, createTaskUseCase, deriveSessionUseCase, decideAgentTask, ok,
  type AgentDescriptor, type ConnectorBinding, type InboundContext, type InboundSource, type Principal, type SessionId, type ToolGrant
} from '@agent-hub/domain';
import { inMemoryDeps } from '@agent-hub/domain/testing';
import { createSqliteConnectors } from './connectors.ts';

const on = { state: 'available' } as const;
const fake: AgentDescriptor = { id: asAgentId('fake'), label: 'F', models: ['m'], defaultModel: 'm', options: [],
  capabilities: { prompt: on, interrupt: on, fork: on, resume: on, tool_calls: on, artifacts: on, structured_events: on, attachments: on } };
const actor = { user: { id: 'u1' } } as unknown as Principal;

async function world(opts: { countHuman?: boolean; fresh?: { lastSeq: number } } = {}) {
  const w = inMemoryDeps();
  w.agents.push(fake);
  const { connectors, agentTasks } = createSqliteConnectors(new DatabaseSync(':memory:'));
  const proj = async (name: string) => { const p = await createProjectUseCase(w.deps, { name, rootPath: `/tmp/${name}` }); assert.ok(p.ok); return p.value; };
  const home = await proj('home');
  const other = await proj('other');
  const hidden = await proj('hidden');
  const session = async (projectId: string) => {
    const t = await createTaskUseCase(w.deps, { projectId, title: 'bot', ownerId: 'u1' });
    assert.ok(t.ok);
    const s = await deriveSessionUseCase(w.deps, { taskId: t.value.id, agentId: 'fake', model: 'm' });
    assert.ok(s.ok);
    const withOwner = opts.fresh ? { ...s.value, createdBy: 'u1', status: 'running' as const, lastSeq: opts.fresh.lastSeq } : { ...s.value, createdBy: 'u1', status: 'stopped' as const };
    await w.deps.sessions.save(withOwner);
    return withOwner;
  };
  const botSession = await session(home.id);
  const delivered: { sessionId: string; text: string }[] = [];
  let busy = false;
  let ctx: InboundContext | null = null;
  const src: InboundSource = { id: 'timer', kinds: ['tick'], validate: (_k, p) => (typeof p.prompt === 'string' && p.prompt ? null : '要写 prompt'), describe: () => '每 15 分钟', start: (c) => { ctx = c; return { stop() {} }; } };
  const hub = createConnectorHub({
    now: w.deps.now, projects: w.deps.projects, sessions: w.deps.sessions, store: connectors, sources: [src],
    agentExists: async (_p, n) => n === 'router',
    spawn: async () => ok(botSession),
    busy: async () => busy,
    deliver: async (sessionId, text) => { delivered.push({ sessionId, text }); return ok(undefined); }
  });
  hub.start();
  const tools = createAgentTaskToolProvider({
    ...w.deps, requests: agentTasks,
    agentOf: async (sid) => (sid === botSession.id ? { projectId: home.id, name: 'router' } : null),
    associations: (p, n) => connectors.agentProjects(p, n),
    wakeOf: async (sid) => { const r = await connectors.deliveredRunFor(sid); return r ? { runId: r.id, timeZone: 'Asia/Shanghai' } : null; },
    countHuman: opts.countHuman
  });
  const grant = { grant: { sessionId: botSession.id, taskId: botSession.taskId, scopes: ['task:create', 'task:read'] } as unknown as ToolGrant, now: 0 };
  return { w, connectors, agentTasks, hub, tools, grant, home, other, hidden, botSession, delivered, setBusy: (b: boolean) => { busy = b; }, ctx: () => ctx! };
}

test('触发：建 → 触发投递 → 同一时刻去重 → 上一次没完跳过 → 回合结束记完成', async () => {
  const x = await world();
  const b = await x.hub.create(actor, x.home.id, 'router', { connector: 'timer', kind: 'tick', name: '巡检', params: { prompt: '看看' }, timeZone: 'Asia/Shanghai' });
  assert.ok(b.ok, JSON.stringify(b));
  const bad = await x.hub.create(actor, x.home.id, 'router', { connector: 'timer', kind: 'tick', name: 'x', projectId: x.hidden.id, params: { prompt: 'a' } });
  assert.equal(bad.ok, false);
  await x.ctx().emit(b.value.id, { kind: 'tick', externalId: '100', plannedAt: 100, title: '巡检', text: '看看' });
  assert.equal(x.delivered.length, 1);
  assert.match(x.delivered[0]!.text, /巡检/);
  await x.ctx().emit(b.value.id, { kind: 'tick', externalId: '100', plannedAt: 100, title: '巡检', text: '看看' });
  await x.ctx().emit(b.value.id, { kind: 'tick', externalId: '200', plannedAt: 200, title: '巡检', text: '看看' });
  assert.equal(x.delivered.length, 1);
  let runs = await x.connectors.runs(b.value.id, 10);
  assert.deepEqual(runs.map((r) => r.state).sort(), ['delivered', 'skipped']);
  await x.hub.turnEnded(x.botSession.id, 'done');
  runs = await x.connectors.runs(b.value.id, 10);
  assert.ok(runs.some((r) => r.state === 'done'));
  assert.equal((await x.connectors.binding(b.value.id))!.mainSessionId, x.botSession.id);
});

test('触发：忙就等，空了 tick 再投；连续失败 5 次自动暂停并进等我处理', async () => {
  const x = await world();
  const b = await x.hub.create(actor, x.home.id, 'router', { connector: 'timer', kind: 'tick', name: '巡检', params: { prompt: '看看' } });
  assert.ok(b.ok);
  x.setBusy(true);
  await x.ctx().emit(b.value.id, { kind: 'tick', externalId: '1', title: 't', text: 'x' });
  assert.equal(x.delivered.length, 0);
  assert.equal((await x.connectors.waitingRuns()).length, 1);
  x.setBusy(false);
  await x.hub.tick();
  assert.equal(x.delivered.length, 1);
  for (let i = 0; i < 5; i++) {
    await x.hub.turnEnded(x.botSession.id, 'failed');
    await x.ctx().emit(b.value.id, { kind: 'tick', externalId: `f${i}`, title: 't', text: 'x' });
  }
  const after = (await x.connectors.binding(b.value.id))!;
  assert.equal(after.enabled, false);
  assert.match(after.pausedReason ?? '', /连续失败 5 次/);
  assert.equal((await x.hub.notices('u1')).length, 1);
  const resumed = await x.hub.update(actor, b.value.id, { enabled: true });
  assert.ok(resumed.ok);
  assert.equal(resumed.value.pausedReason, null);
  assert.equal(resumed.value.consecutiveFailures, 0);
});

test('task.create：人发起的回合默认项目建任务、不计配额；同来源去重；没关联的项目看不见', async () => {
  const x = await world();
  const call = (name: string, input: unknown) => x.tools.call(name, input, x.grant);
  for (let i = 0; i < 5; i++) {
    const r = await call('task.create', { title: `任务${i}` });
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok((r.value as { taskId: string }).taskId);
  }
  const tasks = await x.w.deps.tasks.listByProject(x.home.id);
  assert.ok(tasks.some((t) => t.title === '任务4' && t.ownerId === 'u1'));
  const a = await call('task.create', { title: 'issue', source: { connector: 'github', externalId: '42' } });
  const b = await call('task.create', { title: 'issue again', source: { connector: 'github', externalId: '42' } });
  assert.ok(a.ok && b.ok);
  assert.equal((b.value as { deduplicated?: boolean }).deduplicated, true);
  assert.equal((await call('task.create', { title: 'x', project: 'other' })).ok, false);
  assert.equal((await call('project.get', { project: 'hidden' })).ok, false);
  await x.connectors.setAgentProjects(x.home.id, 'router', [x.other.id]);
  const there = await call('task.create', { title: 'x', project: 'other' });
  assert.ok(there.ok);
  const listed = await call('project.list', {});
  assert.ok(listed.ok);
  assert.deepEqual((listed.value as { projects: { name: string }[] }).projects.map((p) => p.name), ['home', 'other']);
  const all = await call('task.list', {});
  assert.ok(all.ok);
  const ids = new Set((all.value as { tasks: { projectId: string }[] }).tasks.map((t) => t.projectId));
  assert.ok(!ids.has(x.hidden.id));
  // 取消还没开始的
  const c = await call('task.cancel', { id: (there.value as { taskId: string }).taskId });
  assert.ok(c.ok, JSON.stringify(c));
});

test('配额：触发唤醒的回合每次 3 个，超出的进待批；批准才建任务', async () => {
  const x = await world();
  const b = await x.hub.create(actor, x.home.id, 'router', { connector: 'timer', kind: 'tick', name: '巡检', params: { prompt: '看看' } });
  assert.ok(b.ok);
  await x.ctx().emit(b.value.id, { kind: 'tick', externalId: '1', title: 't', text: 'x' });
  const results = [];
  for (let i = 0; i < 4; i++) results.push(await x.tools.call('task.create', { title: `t${i}` }, x.grant));
  assert.ok(results.every((r) => r.ok));
  const last = results[3]!.value as { approval: string; taskId: string | null };
  assert.equal(last.approval, 'pending');
  assert.equal(last.taskId, null);
  const pending = await x.agentTasks.pendingFor('u1');
  assert.equal(pending.length, 1);
  const decided = await decideAgentTask({ ...x.w.deps, requests: x.agentTasks }, 'u1', pending[0]!.id, true);
  assert.ok(decided.ok);
  assert.ok(decided.value.taskId);
});

test('配额：HUB_ROUTER_COUNT_HUMAN 打开时人发起的回合也算', async () => {
  const x = await world({ countHuman: true });
  const rs = [];
  for (let i = 0; i < 4; i++) rs.push(await x.tools.call('task.create', { title: `t${i}` }, x.grant));
  const last = rs[3]!; assert.ok(last.ok); assert.equal((last.value as { approval: string }).approval, 'pending');
});

test('agent_project：关联可改可清', async () => {
  const { connectors } = createSqliteConnectors(new DatabaseSync(':memory:'));
  await connectors.setAgentProjects('p', 'a', ['x', 'y']);
  assert.deepEqual(await connectors.agentProjects('p', 'a'), ['x', 'y']);
  await connectors.setAgentProjects('p', 'a', []);
  assert.deepEqual(await connectors.agentProjects('p', 'a'), []);
  const b = { id: 'b', nextRunAt: null } as unknown as ConnectorBinding;
  void b; void (null as unknown as SessionId);
});

test('触发：刚派生、从没发过话的会话（running + lastSeq 0）直接投；真在跑一轮才等', async () => {
  const fresh = await world({ fresh: { lastSeq: 0 } });
  const b = await fresh.hub.create(actor, fresh.home.id, 'router', { connector: 'timer', kind: 'tick', name: '巡检', params: { prompt: '看看' } });
  assert.ok(b.ok);
  await fresh.ctx().emit(b.value.id, { kind: 'tick', externalId: '1', plannedAt: 1, title: '巡检', text: '看看' });
  assert.equal(fresh.delivered.length, 1);
  const working = await world({ fresh: { lastSeq: 3 } });
  const b2 = await working.hub.create(actor, working.home.id, 'router', { connector: 'timer', kind: 'tick', name: '巡检', params: { prompt: '看看' } });
  assert.ok(b2.ok);
  await working.ctx().emit(b2.value.id, { kind: 'tick', externalId: '1', plannedAt: 1, title: '巡检', text: '看看' });
  assert.equal(working.delivered.length, 0);
  assert.equal((await working.connectors.runs(b2.value.id, 10))[0]!.state, 'waiting');
});
