import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccessPolicy, createProjectUseCase, type AgentTaskRequest, type ConnectorBinding, type Delivery, type TaskDispatch, type TriggerRun } from '@agent-hub/domain';
import { inMemoryAccounts, inMemoryDeps, mailedToken } from '@agent-hub/domain/testing';
import { createStreamHub } from './stream-hub.ts';
import { createApp } from './http.ts';
import { connectorGap, createConnectorObserveReader } from './observe-connector.ts';
import { installObserveRoutes } from './observe-routes.ts';
import { Hono } from 'hono';
import { systemSubject } from '@agent-hub/domain';

const now = 1_700_000_000_000;
const binding = (over: Partial<ConnectorBinding> = {}): ConnectorBinding => ({
  id: 'b1', connector: 'github', kind: 'issue', agentProjectId: 'p1', agentName: 'router', projectId: null, name: 'acme/demo', target: 'main',
  params: {}, enabled: true, pausedReason: null, consecutiveFailures: 0, nextRunAt: null, mainSessionId: 's-bot', createdBy: 'u1', timeZone: 'Asia/Shanghai',
  createdAt: now, updatedAt: now, ...over
});
const run = (over: Partial<TriggerRun> = {}): TriggerRun => ({
  id: 'run-18', bindingId: 'b1', externalId: 'acme/demo#18@evt_91', plannedAt: null, catchup: false, state: 'done', reason: null, sessionId: 's-bot',
  text: '外部正文不该出现', createdAt: now, updatedAt: now + 250_000, ...over
});

function stores(seed: { bindings?: ConnectorBinding[]; runs?: TriggerRun[]; requests?: AgentTaskRequest[]; dispatches?: TaskDispatch[]; deliveries?: Delivery[] } = {}) {
  const bindings = seed.bindings ?? [binding()];
  const runs = seed.runs ?? [run()];
  const requests = seed.requests ?? [];
  const dispatches = seed.dispatches ?? [];
  const deliveries = seed.deliveries ?? [];
  return {
    bindings, runs, requests, dispatches, deliveries,
    store: {
      allBindings: async () => bindings,
      binding: async (id: string) => bindings.find((item) => item.id === id) ?? null,
      run: async (id: string) => runs.find((item) => item.id === id) ?? null,
      runsSince: async (ids: readonly string[], since: number, limit: number) => runs.filter((item) => ids.includes(item.bindingId) && item.createdAt >= since).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit),
      countRunsByState: async () => ({ waiting: 0, delivered: 0, done: 0, failed: 0, timeout: 0, skipped: 0 })
    },
    requestsStore: {
      byWakeKeys: async (keys: readonly string[]) => requests.filter((item) => item.wakeKey !== null && keys.includes(item.wakeKey)),
      countSince: async () => 6
    },
    dispatchStore: {
      byTaskIds: async (ids: readonly string[]) => dispatches.filter((item) => ids.includes(item.taskId))
    },
    deliveryQueue: {
      recent: async (sessionId: string) => deliveries.filter((item) => item.sessionId === sessionId)
    }
  };
}

function reader(seed?: Parameters<typeof stores>[0], opts: { failDeliveries?: boolean; projectIds?: string[] } = {}) {
  const world = inMemoryDeps({ now: () => now + 1_000 });
  const bag = stores(seed);
  const allowed = new Set(opts.projectIds ?? ['p1']);
  return createConnectorObserveReader({
    now: () => now + 1_000,
    projects: {
      ...world.deps.projects,
      byId: async (id) => (allowed.has(id) ? { id, name: id, teamId: 't', createdBy: 'u1', deletedAt: null } as never : null)
    },
    sessions: { ...world.deps.sessions, byId: async (id) => ({ id, status: id === 's-task' ? 'failed' : 'done', lastSeq: 3, taskId: 't1', projectId: 'p1' } as never) },
    tasks: { ...world.deps.tasks, byId: async (id) => ({ id, projectId: 'p1', title: '修一下', status: 'in_progress' } as never) },
    deliveries: { recent: async (sessionId: string) => { if (opts.failDeliveries) throw new Error('送达库坏了'); return bag.deliveryQueue.recent(sessionId); } } as never,
    store: bag.store as never,
    requests: bag.requestsStore as never,
    dispatches: bag.dispatchStore as never
  });
}

const me = { user: { id: 'u1' } };

test('wakeKey 接上任务；GitHub 来源键不相等时不接；调度不是子调用；回写未记录', async () => {
  const request: AgentTaskRequest = {
    id: 'req-1', taskId: 't1', accountId: 'u1', agent: 'p1/router', sessionId: 's-bot', projectId: 'p1', title: '修一下', goal: '很长的目标不该出现',
    originConnector: 'github', originExternalId: 'acme/demo#18', wakeKey: 'run-18', counted: true, approval: 'none', createdAt: now + 10, updatedAt: now + 10
  };
  const other: AgentTaskRequest = { ...request, id: 'req-x', taskId: 't-x', wakeKey: 'someone-else', title: '不该出现' };
  const job: TaskDispatch = {
    id: 'd1', taskId: 't1', accountId: 'u1', projectId: 'p1', title: '修一下', goal: 'g', human: false, notifySessionId: 's-bot', agentId: 'pi', model: 'm',
    originConnector: 'github', originExternalId: 'acme/demo#18', state: 'failed', workerId: null, sessionId: 's-task', waitReason: null, result: '测试挂了', notified: true,
    createdAt: now + 20, startedAt: now + 30_000, updatedAt: now + 210_000
  };
  const delivery: Delivery = {
    id: 'dlv-1', sessionId: 's-bot', seq: 1, kind: 'prompt', payload: { text: '密钥不该出现', parts: [] }, state: 'delivered', attempt: 1, nextAt: null, lastError: null,
    createdAt: now + 5, updatedAt: now + 7_000
  };
  const old: Delivery = { ...delivery, id: 'dlv-old', createdAt: now - 60_000, updatedAt: now - 50_000 };
  const view = await reader({ requests: [request, other], dispatches: [job], deliveries: [delivery, old] }).get('run-18', me);
  assert.ok(view);
  assert.equal(view.externalUrl, null);
  assert.equal(JSON.stringify(view).includes('外部正文'), false);
  assert.equal(JSON.stringify(view).includes('密钥'), false);
  assert.equal(JSON.stringify(view).includes('很长的目标'), false);
  assert.equal(JSON.stringify(view).includes('不该出现'), false);
  const dispatch = view.nodes.find((node) => node.kind === 'dispatch');
  assert.equal(dispatch?.parentId, null);
  assert.equal(dispatch?.links.some((link) => link.label === 'dispatch.sessionId'), true);
  assert.equal(view.nodes.find((node) => node.kind === 'trigger')?.links.some((link) => link.label === '由这次唤醒建下'), true);
  assert.equal(view.nodes.some((node) => node.kind === 'sink' && node.state === null), true);
  assert.equal(view.nodes.filter((node) => node.kind === 'delivery').length, 1);
  const tree = (await import('@agent-hub/observe')).buildTree(view);
  assert.equal(tree.roots[0]?.children.length, 0);
  assert.equal(tree.unrecorded[0]?.name, '回写');
  assert.equal(tree.unlinked.some((node) => node.kind === 'delivery'), true);
});

test('别人的绑定不带今日配额', async () => {
  const view = await reader().get('run-18', { user: { id: 'u2' } });
  assert.equal(view?.nodes.find((node) => node.kind === 'trigger')?.attrs.some((item) => item.key === '今日已计入'), false);
  const own = await reader().get('run-18', me);
  assert.equal(own?.nodes.find((node) => node.kind === 'trigger')?.attrs.some((item) => item.key === '今日已计入'), true);
});

test('看不见的项目整条不出现', async () => {
  const hidden = reader(undefined, { projectIds: [] });
  assert.equal(await hidden.get('run-18', me), null);
  assert.deepEqual((await hidden.list({ since: 0, source: null, projectId: null, needsLook: false, limit: 50 }, me)).items, []);
});

test('失败或缺环筛选：无写权限的跳过留下，调度失败留下', async () => {
  const runs = [
    run({ id: 'skip', state: 'skipped', reason: '标签是 @guest 贴的，他没有写权限，不处理', createdAt: now + 1 }),
    run({ id: 'bad', state: 'done', createdAt: now + 2 })
  ];
  const request: AgentTaskRequest = {
    id: 'req', taskId: 't1', accountId: 'u1', agent: null, sessionId: 's-bot', projectId: 'p1', title: '修', goal: '', originConnector: 'github', originExternalId: 'acme/demo#18',
    wakeKey: 'bad', counted: true, approval: 'none', createdAt: now, updatedAt: now
  };
  const job: TaskDispatch = {
    id: 'd', taskId: 't1', accountId: 'u1', projectId: 'p1', title: '修', goal: '', human: false, notifySessionId: null, agentId: null, model: null,
    originConnector: 'github', originExternalId: 'acme/demo#18', state: 'failed', workerId: null, sessionId: null, waitReason: null, result: null, notified: false,
    createdAt: now, startedAt: now, updatedAt: now
  };
  const listed = await reader({ runs, requests: [request], dispatches: [job] }).list({ since: 0, source: 'connector', projectId: null, needsLook: true, limit: 50 }, me);
  assert.deepEqual(listed.items.map((item) => item.id), ['connector:bad']);
  assert.equal(connectorGap(runs[0]!, [], []), null);
});

test('送达读失败只影响这一跳', async () => {
  const view = await reader(undefined, { failDeliveries: true }).get('run-18', me);
  assert.ok(view?.nodes.some((node) => node.kind === 'trigger'));
  assert.equal(view?.nodes.find((node) => node.kind === 'delivery')?.attrs[0]?.value, '读取失败');
});

test('列表截断：limit 小于条数时 truncated', async () => {
  const runs = [1, 2, 3].map((n) => run({ id: `r${n}`, externalId: String(n), createdAt: now + n }));
  const listed = await reader({ runs }).list({ since: 0, source: null, projectId: 'p1', needsLook: false, limit: 2 }, me);
  assert.equal(listed.items.length, 2);
  assert.equal(listed.truncated, true);
});

test('路由：关闭时不装成空数据；读取失败不挡住健康检查', async () => {
  const world = inMemoryDeps();
  const off = createApp({
    deps: world.deps, hub: createStreamHub(), token: null,
    observe: { enabled: false, readers: [] }
  });
  const disabled = await off.request('/api/observe');
  assert.equal((await disabled.json() as { enabled: boolean }).enabled, false);
  const boom = createApp({
    deps: world.deps, hub: createStreamHub(), token: null,
    observe: { enabled: true, readers: [{ id: 'connector', list: async () => { throw new Error('读坏了'); }, get: async () => { throw new Error('读坏了'); } }] }
  });
  assert.equal((await boom.request('/api/observe')).status, 503);
  assert.equal((await boom.request('/api/health')).status, 200);
  assert.equal((await boom.request('/api/observe/connector/missing')).status, 503);
});

test('两个团队：别人的触发不进我的列表', async () => {
  const accounts = inMemoryAccounts();
  const world = inMemoryDeps();
  const access = createAccessPolicy({ users: accounts.users, settings: accounts.settings, enrollment: { credentialFor: async () => null }, gateway: world.deps.gateway });
  const deps = { ...world.deps, access };
  const bindings: ConnectorBinding[] = [];
  const runs: TriggerRun[] = [];
  const observeReader = createConnectorObserveReader({
    now: () => Date.now(), projects: deps.projects, sessions: deps.sessions, tasks: deps.tasks,
    deliveries: { recent: async () => [] } as never,
    store: {
      allBindings: async () => bindings,
      binding: async (id: string) => bindings.find((item) => item.id === id) ?? null,
      run: async (id: string) => runs.find((item) => item.id === id) ?? null,
      runsSince: async (ids: readonly string[], since: number) => runs.filter((item) => ids.includes(item.bindingId) && item.createdAt >= since),
      countRunsByState: async () => ({ waiting: 0, delivered: 0, done: 0, failed: 0, timeout: 0, skipped: 0 })
    } as never,
    requests: { byWakeKeys: async () => [], countSince: async () => 0 } as never,
    dispatches: { byTaskIds: async () => [] } as never,
    policy: access
  });
  const app = createApp({ deps, hub: createStreamHub(), token: null, auth: { accounts, hubToken: null }, observe: { enabled: true, readers: [observeReader] } });
  const jar = new Map<string, string>();
  const browser = () => async (path: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (jar.get('hub_csrf')) headers['x-hub-csrf'] = jar.get('hub_csrf')!;
    const response = await app.fetch(new Request(`http://hub${path}`, { ...init, headers }));
    for (const line of response.headers.getSetCookie()) {
      const [name, value] = line.split(';')[0]!.split('=');
      if (value === '' || /Max-Age=0/.test(line)) jar.delete(name!);
      else jar.set(name!, value!);
    }
    return { status: response.status, body: await response.json().catch(() => null) as { id?: string; items?: { id: string }[] } };
  };
  const david = browser();
  assert.equal((await david('/api/auth/register', { method: 'POST', body: JSON.stringify({ email: 'david@b.co', password: 'long enough pw' }) })).status, 200);
  const davidUser = await accounts.users.byEmail('david@b.co');
  const project = await createProjectUseCase(deps, { name: 'secret', rootPath: '/tmp/secret', actor: { user: davidUser!, loginId: 'x' as never } });
  assert.ok(project.ok);
  bindings.push(binding({ agentProjectId: project.value.id, createdBy: davidUser!.id }));
  runs.push(run({ bindingId: 'b1' }));
  const own = await david('/api/observe?since=0');
  assert.equal(own.body.items?.length, 1);
  jar.clear();
  await accounts.settings.save({ ...(await accounts.settings.get()), openRegistration: true });
  const stranger = browser();
  const pending = await stranger('/api/auth/register', { method: 'POST', body: JSON.stringify({ email: 's@b.co', password: 'long enough pw' }) });
  assert.equal(pending.status, 202);
  assert.equal((await stranger('/api/auth/verify-email', { method: 'POST', body: JSON.stringify({ token: mailedToken(accounts, 's@b.co') }) })).status, 200);
  assert.equal((await stranger('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 's@b.co', password: 'long enough pw' }) })).status, 200);
  const foreign = await stranger('/api/observe?since=0');
  assert.deepEqual(foreign.body.items, []);
  assert.equal((await stranger('/api/observe/connector/run-18')).status, 404);
});

test('未启用的路由可以直接挂上，不调用适配器', async () => {
  const app = new Hono();
  let called = false;
  installObserveRoutes(app, { enabled: false, readers: [{ id: 'connector', list: async () => { called = true; return { truncated: false, items: [] }; }, get: async () => { called = true; return null; } }] }, () => systemSubject('test'));
  const body = await (await app.request('/api/observe')).json() as { enabled: boolean };
  assert.equal(body.enabled, false);
  assert.equal(called, false);
});
