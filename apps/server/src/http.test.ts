import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentToDto } from '@agent-hub/contract/codec';
import type { AgentDescriptor, DeliveryQueue, EnvironmentPlanner, JournalEntry, MetadataSearchGateway, MetadataSearchQuery, Session, SessionEvent, SessionId, Task } from '@agent-hub/domain';
import { asAgentId, asProjectId, asSessionId, asTaskId, createProject, createTask, recordEvent, unavailable, withActiveTask, ok } from '@agent-hub/domain';
import { fakeHosting, fakeSessions, fakeTasks, inMemoryDeliveries, inMemoryDeps } from '@agent-hub/domain/testing';
import { createApp } from './http.ts';
import { createStreamHub } from './stream-hub.ts';
import { createRequestGuard } from './request-guard.ts';
import { createLiveCatalog } from './agent-catalog.ts';
import { createTaskGate } from './task-gate.ts';
import { createOptionWaiters } from './option-waiters.ts';

test('archive route refuses competing work and unknown publication, then archives and restores without dispatch', async () => {
  const taskGate = createTaskGate();
  const deliveries = inMemoryDeliveries();
  const { deps, dispatched } = inMemoryDeps({ taskGate, deliveries });
  const now = deps.now();
  const project = createProject({ name: 'Archive route', now });
  assert.ok(project.ok);
  await deps.projects.save(project.value);
  const task = createTask({ projectId: project.value.id, title: 'Archive me', now });
  assert.ok(task.ok);
  const taskId = task.value.id;
  await deps.tasks.save(task.value);
  let unresolvedPublish = false;
  const app = createApp({ deps, hub: createStreamHub(), token: null, taskArchiveBlockers: async () => unresolvedPublish ? 'publish' : null });
  const archive = (archived: boolean) => app.request(`/api/tasks/${taskId}/archive`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ archived })
  });
  const leave = taskGate.enter(taskId);
  assert.ok(leave);
  assert.equal((await archive(true)).status, 409);
  leave();
  unresolvedPublish = true;
  assert.equal((await archive(true)).status, 409);
  assert.equal((await deps.tasks.byId(taskId))?.archivedAt, null);
  unresolvedPublish = false;
  const archived = await archive(true);
  assert.equal(archived.status, 200);
  const archiveTime = (await archived.json() as { archivedAt: number }).archivedAt;
  assert.ok(archiveTime >= now);
  assert.equal((await archive(true)).status, 200);
  assert.equal((await deps.tasks.byId(taskId))?.archivedAt, archiveTime);
  const admission = await withActiveTask(deps, taskId, async () => { throw new Error('archived work admitted'); });
  assert.equal(admission.ok, false);
  const restored = await archive(false);
  assert.equal(restored.status, 200);
  assert.equal((await restored.json() as { archivedAt: number | null }).archivedAt, null);
  assert.deepEqual(await withActiveTask(deps, taskId, async () => ok('ready')), ok('ready'));
  assert.deepEqual(dispatched, []);
});

/**
 * HTTP 层的合同测试：用内存假件把整个 server 跑起来，
 * 证明路由、状态码、S7.1 的 resume 路径都是真的，而不是文档里的承诺。
 */

const descriptor: AgentDescriptor = {
  id: asAgentId('fake'),
  label: 'Fake',
  capabilities: {
    prompt: { state: 'available' },
    interrupt: { state: 'available' },
    fork: { state: 'limited', reason: '测试 agent 只支持整条复用' },
    resume: { state: 'available' },
    tool_calls: { state: 'available' },
    artifacts: { state: 'available' },
    structured_events: { state: 'available' },
  attachments: { state: 'available' }
  },
  models: ['fake-1'],
  defaultModel: 'fake-1',
  options: [
    {
      id: 'model',
      label: '模型',
      category: 'model',
      kind: 'select',
      current: 'fake-1',
      choices: [
        { kind: 'value', value: { value: 'fake-1', label: 'fake-1' } },
        { kind: 'value', value: { value: 'fake-2', label: 'fake-2' } }
      ]
    },
    {
      id: 'thinking',
      label: '思考强度',
      category: 'thought_level',
      kind: 'select',
      current: 'low',
      choices: [
        { kind: 'value', value: { value: 'off', label: 'off' } },
        { kind: 'value', value: { value: 'low', label: 'low' } }
      ]
    }
  ]
};

function harness(token: string | null = null, environment?: EnvironmentPlanner, deliveries?: DeliveryQueue, metadataSearch?: MetadataSearchGateway) {
  const tasks = fakeTasks();
  const sessions = fakeSessions(tasks.rows);
  const hosting = fakeHosting();
  const world = inMemoryDeps({
    tasks,
    sessions,
    hosting,
    ...(deliveries ? { deliveries } : {}),
    ...(metadataSearch ? { metadataSearch } : {}),
    stream: createStreamHub().stream,
    agents: createLiveCatalog(),
    now: () => 1_700_000_000_000,
    search: {
      // 搜索的 SQL 在 storage-sqlite 里单独测；这里只需要证明路由把参数接对了。
      async search(query) {
        return [...tasks.rows.values()]
          .filter((task) => task.projectId === query.projectId)
          .filter((task) => task.title.includes(query.query))
          .map((task) => ({
            kind: 'task' as const,
            taskId: task.id,
            sessionId: null,
            title: task.title,
            snippet: task.goal ?? ''
          }));
      }
    }
  });
  const { deps, dispatched } = world;
  const hub = createStreamHub();
  const live = hosting.live;
  const app = createApp({ deps: environment ? { ...deps, environment } : deps, hub, token });

  const call = async (path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> => {
    const response = await app.fetch(
      new Request(`http://hub${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) }
      })
    );
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  return { deps, app, call, dispatched, sessions, hub, live };
}

test('option confirmation route distinguishes saved, exact runtime receipt, timeout and legacy response', async () => {
  const { deps, call } = harness();
  (deps.agents as ReturnType<typeof createLiveCatalog>).upsert('w1', [agentToDto(descriptor)]);
  const project = await call('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'options', rootPath: '/tmp/options' }) });
  const task = await call('/api/tasks', { method: 'POST', body: JSON.stringify({ projectId: (project.body as { id: string }).id, title: 'options' }) });
  const derived = await call('/api/sessions/derive', { method: 'POST', body: JSON.stringify({ taskId: (task.body as { id: string }).id, agentId: 'fake', model: 'fake-1' }) });
  assert.equal(derived.status, 201);
  const id = asSessionId((derived.body as { id: string }).id);
  const original = await deps.sessions.byId(id);
  assert.ok(original);
  await deps.sessions.save({ ...original, status: 'stopped', optionSpec: descriptor.options });
  const confirmations = createOptionWaiters(15);
  let receipt: 'applied' | 'rejected' | 'none' = 'applied';
  const gateway = { ...deps.gateway, async dispatch(command: Parameters<typeof deps.gateway.dispatch>[0]) {
    if (command.kind === 'set_option' && command.requestId && receipt !== 'none') {
      confirmations.receipt(id, command.requestId, command.optionId, receipt, receipt === 'applied' ? descriptor.options : undefined);
    }
    return ok(undefined);
  } };
  const app = createApp({ deps: { ...deps, gateway }, hub: createStreamHub(), token: null, optionConfirmations: confirmations });
  const post = (input: object) => app.request(`/api/sessions/${id}/options`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  const saved = await post({ optionId: 'thinking', value: 'off', confirm: true });
  assert.equal(saved.status, 200);
  assert.equal(saved.headers.get('cache-control'), 'no-store');
  assert.equal((await saved.json() as { state: string }).state, 'saved');
  const stopped = await deps.sessions.byId(id);
  assert.ok(stopped);
  await deps.sessions.save({ ...stopped, status: 'running' });
  const confirmed = await post({ optionId: 'thinking', value: 'low', confirm: true });
  assert.equal((await confirmed.json() as { state: string }).state, 'confirmed');
  receipt = 'rejected';
  const rejected = await post({ optionId: 'thinking', value: 'low', confirm: true });
  assert.equal((await rejected.json() as { state: string }).state, 'rejected');
  receipt = 'none';
  const unknown = await post({ optionId: 'thinking', value: 'low', confirm: true });
  assert.equal((await unknown.json() as { state: string }).state, 'unconfirmed');
  const legacy = await post({ optionId: 'thinking', value: 'low' });
  const legacyBody = await legacy.json() as { id: string; state?: string };
  assert.equal(legacyBody.id, id);
  assert.equal(legacyBody.state, undefined);
  const model = await post({ optionId: 'model', value: 'fake-1', confirm: true });
  const modelBody = await model.json() as { id: string; state?: string };
  assert.equal(modelBody.id, id);
  assert.equal(modelBody.state, undefined);
});

test('元数据搜索路由：q / 可选 limit 接线，返回三组稳定 DTO', async () => {
  const calls: MetadataSearchQuery[] = [];
  const metadataSearch: MetadataSearchGateway = {
    async search(query) {
      calls.push(query);
      return {
        projects: [{ projectId: asProjectId('p-meta') }],
        tasks: [{ taskId: asTaskId('t-meta'), projectId: asProjectId('p-meta'), title: '元数据任务' }],
        sessions: [
          {
            sessionId: asSessionId('s-meta'),
            taskId: null,
            projectId: null,
            originProjectId: asProjectId('p-meta'),
            title: '元数据会话',
            taskTitle: null,
            updatedAt: 1_700_000_000_123
          }
        ]
      };
    }
  };
  const { deps, call } = harness(null, undefined, undefined, metadataSearch);
  const project = createProject({ id: asProjectId('p-meta'), name: '元数据项目', now: 1 });
  assert.ok(project.ok);
  await deps.projects.save(project.value);

  const limited = await call('/api/metadata-search?q=元数据&limit=2');
  assert.equal(limited.status, 200);
  assert.deepEqual(limited.body, {
    projects: [{ projectId: 'p-meta', name: '元数据项目' }],
    tasks: [{ taskId: 't-meta', projectId: 'p-meta', title: '元数据任务', projectName: '元数据项目' }],
    sessions: [
      {
        sessionId: 's-meta',
        taskId: null,
        projectId: 'p-meta',
        projectName: '元数据项目',
        title: '元数据会话',
        taskTitle: null,
        updatedAt: 1_700_000_000_123
      }
    ]
  });
  assert.equal(calls[0]?.query, '元数据');
  assert.equal(calls[0]?.limitPerGroup, 2);

  assert.equal((await call('/api/metadata-search?q=元数据')).status, 200);
  assert.equal(calls[1]?.limitPerGroup, 10, '不传 limit 用默认上限');

  const invalid = await call(`/api/metadata-search?q=${'x'.repeat(161)}`);
  assert.equal(invalid.status, 400);
  assert.equal(calls.length, 2, '非法输入不落到存储层');
});

test('创建项目一次绑定多个仓库，返回主仓和令牌状态而不回显凭据', async () => {
  const { call } = harness();
  const credential = 'synthetic-repo-token-for-http-test';
  const created = await call('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'multi', primaryRepoId: 'web', repos: [
      { id: 'api', name: 'api', url: 'https://git.example.test/example/api.git', defaultBranch: 'main' },
      { id: 'web', name: 'web', url: 'https://git.example.test/example/web.git', defaultBranch: 'develop', credential }
    ] })
  });
  assert.equal(created.status, 201);
  const result = created.body as { primaryRepoId: string; repos: { id: string; defaultBranch: string; hasToken?: boolean }[] };
  assert.equal(result.primaryRepoId, 'web');
  assert.deepEqual(result.repos.map((repo) => [repo.id, repo.defaultBranch, repo.hasToken === true]), [
    ['api', 'main', false], ['web', 'develop', true]
  ]);
  assert.doesNotMatch(JSON.stringify(created.body), /synthetic-repo-token|"(?:tokenSecret|credential)":/);
});

test('建项目 → 建任务 → 派生会话，整条纵切走通', async () => {
  const { deps, call, dispatched } = harness();

  const project = await call('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'demo', rootPath: '/tmp/demo' })
  });
  assert.equal(project.status, 201);
  const projectId = (project.body as { id: string }).id;

  const task = await call('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ projectId, title: '跑通第一条会话' })
  });
  assert.equal(task.status, 201);
  const taskId = (task.body as { id: string }).id;

  // 没有 worker 时，agent 列表为空 → 派生必须被拒绝，而不是假装成功
  const denied = await call('/api/sessions/derive', {
    method: 'POST',
    body: JSON.stringify({ taskId, agentId: 'fake', model: 'fake-1' })
  });
  assert.equal(denied.status, 409);
  assert.match((denied.body as { error: { message: string } }).error.message, /没有在线节点/);

  (deps.agents as ReturnType<typeof createLiveCatalog>).upsert('w1', [agentToDto(descriptor)]);

  const derived = await call('/api/sessions/derive', {
    method: 'POST',
    body: JSON.stringify({ taskId, agentId: 'fake', model: 'fake-1' })
  });
  assert.equal(derived.status, 201);
  const sessionId = (derived.body as { id: string }).id;
  assert.equal(dispatched.at(-1)?.kind, 'start_session');

  const canvas = await call(`/api/projects/${projectId}/canvas`);
  assert.equal(canvas.status, 200);
  const payload = canvas.body as { tasks: Task[]; sessions: Session[]; edges: { kind: string }[] };
  assert.equal(payload.tasks.length, 1);
  assert.equal(payload.sessions.length, 1);
  assert.deepEqual(
    payload.edges.map((edge) => edge.kind),
    ['derive']
  );
  assert.equal(payload.sessions[0]?.id, sessionId);
});

test('会话不在 worker 手上时，prompt 先 resume 再发（S7.1）', async () => {
  const { deps, call, dispatched, live } = harness();
  (deps.agents as ReturnType<typeof createLiveCatalog>).upsert('w1', [agentToDto(descriptor)]);

  const project = await call('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'demo', rootPath: '/tmp/demo' })
  });
  const projectId = (project.body as { id: string }).id;
  const task = await call('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ projectId, title: 't' })
  });
  const taskId = (task.body as { id: string }).id;
  const derived = await call('/api/sessions/derive', {
    method: 'POST',
    body: JSON.stringify({ taskId, agentId: 'fake', model: 'fake-1' })
  });
  const sessionId = (derived.body as { id: string }).id as SessionId;

  // 模拟「server 重启过」：live 集合被清空，但库里的会话还在
  live.clear();
  dispatched.length = 0;

  const prompted = await call(`/api/sessions/${sessionId}/prompt`, {
    method: 'POST',
    body: JSON.stringify({ text: '接着说' })
  });
  assert.equal(prompted.status, 202);
  assert.deepEqual(
    dispatched.map((command) => command.kind),
    ['start_session', 'prompt']
  );
  const start = dispatched[0];
  assert.equal(start?.kind, 'start_session');
  if (start?.kind === 'start_session') {
    assert.equal(start.resume?.cursor, 0);
    assert.equal(start.workspaceRoot, '/tmp/demo');
  }

  // 用户说了什么必须留在 journal 里：专注对话重开后要能看到自己问过什么。
  const entries = (await call(`/api/sessions/${sessionId}/events`)).body as JournalEntry[];
  assert.deepEqual(entries.at(-1)?.event, { kind: 'prompt', text: '接着说' });
});

test('prompt 返回 202 和发送回执；同一 clientMessageId 重发不再落库', async () => {
  const { deps, call } = harness();
  (deps.agents as ReturnType<typeof createLiveCatalog>).upsert('w1', [agentToDto(descriptor)]);

  const project = await call('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'demo', rootPath: '/tmp/demo' }) });
  const task = await call('/api/tasks', { method: 'POST', body: JSON.stringify({ projectId: (project.body as { id: string }).id, title: 't' }) });
  const derived = await call('/api/sessions/derive', {
    method: 'POST',
    body: JSON.stringify({ taskId: (task.body as { id: string }).id, agentId: 'fake', model: 'fake-1' })
  });
  const sessionId = (derived.body as { id: string }).id;

  const prompted = await call(`/api/sessions/${sessionId}/prompt`, {
    method: 'POST',
    body: JSON.stringify({ text: '回执', clientMessageId: 'cm-http-1' })
  });
  assert.equal(prompted.status, 202, JSON.stringify(prompted.body));
  const ack = prompted.body as { ok: boolean; seq: number; deliveryId: string | null; state: string };
  assert.equal(ack.ok, true);
  assert.equal(typeof ack.seq, 'number');
  // 这个 harness 没接送达队列：ack 里的 deliveryId 为 null，state 是「已尝试派发」
  assert.equal(ack.deliveryId, null);
  assert.equal(ack.state, 'sending');

  // 客户端超时重试：同一个 clientMessageId 再发一次，返回同一 seq，journal 只有一条
  const again = await call(`/api/sessions/${sessionId}/prompt`, {
    method: 'POST',
    body: JSON.stringify({ text: '回执', clientMessageId: 'cm-http-1' })
  });
  assert.equal(again.status, 202);
  assert.equal((again.body as { seq: number }).seq, ack.seq);

  const entries = (await call(`/api/sessions/${sessionId}/events`)).body as JournalEntry[];
  const prompts = entries.filter((entry) => entry.event.kind === 'prompt');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]?.seq, ack.seq);
  assert.ok(prompts[0]?.event.kind === 'prompt' && prompts[0].event.clientMessageId === 'cm-http-1');
});

test('MS-2：接上送达队列后，派发失败仍然是 202；失败落在 delivery，不是 HTTP 500', async () => {
  // 产品语义变了：调用方不能再拿 500 判断「Agent 发不出去」（design/message-send-feedback.md §9.2）。
  // 这条测试固定住新语义 —— 已进 journal + 队列就算接收成功，送达失败只体现为 delivery 状态。
  const deliveries = inMemoryDeliveries();
  const { deps, call } = harness(null, undefined, deliveries);
  (deps.agents as ReturnType<typeof createLiveCatalog>).upsert('w1', [agentToDto(descriptor)]);
  // 网关只在 prompt 上 unavailable：派生会话要的 start_session 必须还能成功，
  // 而 prompt 这条就是以前会把请求变成 500 的路径。
  const baseDispatch = deps.gateway.dispatch;
  deps.gateway.dispatch = async (command) =>
    command.kind === 'prompt' ? { ok: false, error: unavailable('Worker 不在线') } : baseDispatch(command);

  const project = await call('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'demo', rootPath: '/tmp/demo' }) });
  const task = await call('/api/tasks', { method: 'POST', body: JSON.stringify({ projectId: (project.body as { id: string }).id, title: 't' }) });
  const derived = await call('/api/sessions/derive', {
    method: 'POST',
    body: JSON.stringify({ taskId: (task.body as { id: string }).id, agentId: 'fake', model: 'fake-1' })
  });
  assert.equal(derived.status, 201, JSON.stringify(derived.body));
  const sessionId = (derived.body as { id: string }).id;

  const prompted = await call(`/api/sessions/${sessionId}/prompt`, {
    method: 'POST',
    body: JSON.stringify({ text: '派发会失败', clientMessageId: 'cm-http-fail' })
  });
  assert.equal(prompted.status, 202, JSON.stringify(prompted.body));
  const ack = prompted.body as { ok: boolean; seq: number; deliveryId: string | null; state: string };
  assert.equal(ack.state, 'queued', 'ack 确认落盘排队，不等运行时接收');
  assert.ok(ack.deliveryId);

  // 后台那一段微任务跑完后，失败只落在 delivery 上。
  await new Promise<void>((resolve) => setImmediate(resolve));
  const row = await deliveries.byId(ack.deliveryId);
  assert.equal(row?.state, 'queued', 'unavailable 可重试，排下一次');
  assert.equal(row?.lastError, 'Worker 不在线');

  // journal 里那句话还在（客户端不会误以为没发出去）。
  const entries = (await call(`/api/sessions/${sessionId}/events`)).body as JournalEntry[];
  const prompts = entries.filter((entry) => entry.event.kind === 'prompt');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]?.seq, ack.seq);
  assert.ok(prompts[0]?.event.kind === 'prompt' && prompts[0].event.clientMessageId === 'cm-http-fail');
});

test('分叉一个不存在的会话返回 404，还没内容的会话分叉返回 409', async () => {
  const { deps, call } = harness();
  (deps.agents as ReturnType<typeof createLiveCatalog>).upsert('w1', [agentToDto(descriptor)]);

  const missing = await call('/api/sessions/fork', {
    method: 'POST',
    body: JSON.stringify({ sessionId: asSessionId('nope'), atSeq: 1, agentId: 'fake', model: 'fake-1' })
  });
  assert.equal(missing.status, 404);

  const project = await call('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'demo', rootPath: '/tmp/demo' })
  });
  const projectId = (project.body as { id: string }).id;
  const task = await call('/api/tasks', { method: 'POST', body: JSON.stringify({ projectId, title: 't' }) });
  const taskId = (task.body as { id: string }).id;
  const derived = await call('/api/sessions/derive', {
    method: 'POST',
    body: JSON.stringify({ taskId, agentId: 'fake', model: 'fake-1' })
  });
  const sessionId = (derived.body as { id: string }).id;

  const beyond = await call('/api/sessions/fork', {
    method: 'POST',
    body: JSON.stringify({ sessionId, atSeq: 42, agentId: 'fake', model: 'fake-1' })
  });
  assert.equal(beyond.status, 409);
  assert.match((beyond.body as { error: { message: string } }).error.message, /还没有内容/);
});

test('布局保存后能读回来，坐标按节点 id 记住', async () => {
  const { call } = harness();
  const project = await call('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'demo', rootPath: '/tmp/demo' })
  });
  const projectId = (project.body as { id: string }).id;

  const saved = await call(`/api/projects/${projectId}/layout`, {
    method: 'PUT',
    body: JSON.stringify({ positions: { 'session-1': { x: 12, y: 34 } } })
  });
  assert.equal(saved.status, 200);
  const layout = saved.body as { positions: Record<string, { x: number; y: number }> };
  assert.deepEqual(layout.positions['session-1'], { x: 12, y: 34 });

  const canvas = await call(`/api/projects/${projectId}/canvas`);
  const payload = canvas.body as { layout: { positions: Record<string, { x: number; y: number }> } };
  assert.deepEqual(payload.layout.positions['session-1'], { x: 12, y: 34 });

  const resized = await call(`/api/projects/${projectId}/layout`, {
    method: 'PUT',
    body: JSON.stringify({ sizes: { 'session-1': { width: 420, height: 360 } } })
  });
  assert.equal(resized.status, 200);
  const after = (await call(`/api/projects/${projectId}/canvas`)).body as {
    layout: { positions: Record<string, unknown>; sizes: Record<string, unknown> };
  };
  assert.deepEqual(after.layout.sizes['session-1'], { width: 420, height: 360 });
  assert.deepEqual(after.layout.positions['session-1'], { x: 12, y: 34 });

  const invalid = await call(`/api/projects/${projectId}/layout`, {
    method: 'PUT',
    body: JSON.stringify({ sizes: { 'session-1': { width: -1, height: 10 } } })
  });
  assert.equal(invalid.status, 400);
});

test('项目目录不存在的请求返回 400 而不是 500', async () => {
  const { call } = harness();
  const created = await call('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: '', rootPath: 'relative/path' })
  });
  assert.equal(created.status, 400);
});

test('event 落盘后能从 /events 读回，seq 单调', async () => {
  const { deps, call, sessions } = harness();
  (deps.agents as ReturnType<typeof createLiveCatalog>).upsert('w1', [agentToDto(descriptor)]);
  const project = await call('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'demo', rootPath: '/tmp/demo' })
  });
  const projectId = (project.body as { id: string }).id;
  const task = await call('/api/tasks', { method: 'POST', body: JSON.stringify({ projectId, title: 't' }) });
  const taskId = (task.body as { id: string }).id;
  const derived = await call('/api/sessions/derive', {
    method: 'POST',
    body: JSON.stringify({ taskId, agentId: 'fake', model: 'fake-1' })
  });
  const sessionId = asSessionId((derived.body as { id: string }).id);

  const event: SessionEvent = { kind: 'text', delta: '你好' };
  await recordEvent(deps, { sessionId, event });
  await recordEvent(deps, { sessionId, event: { kind: 'text', delta: '世界' } });

  const events = await call(`/api/sessions/${sessionId}/events`);
  assert.equal(events.status, 200);
  const entries = events.body as JournalEntry[];
  assert.deepEqual(
    entries.map((entry) => entry.seq),
    [1, 2]
  );
  assert.equal(sessions.journal.get(sessionId)?.length, 2);
});

test('绑非 loopback 时 token 只认请求头；SSE 也不再接受 ?token=', async () => {
  const { app, call } = harness('s3cret');

  assert.equal((await call('/api/health')).status, 401);
  assert.equal((await call('/api/health?token=wrong')).status, 401);
  assert.equal((await call('/api/health?token=s3cret')).status, 401);
  // SEC-1a：查询串会进访问日志、浏览器历史和 Referer，SSE 也不例外
  assert.equal((await app.fetch(new Request('http://hub/api/stream?token=s3cret'))).status, 401);
  assert.equal(
    (await call('/api/health', { headers: { authorization: 'Bearer s3cret' } })).status,
    200
  );
  // 请求头优先：带对了就放行，查询串里的错值不参与判定
  assert.equal(
    (await call('/api/health?token=wrong', { headers: { authorization: 'Bearer s3cret' } })).status,
    200
  );
});

test('附件：发图 + @ 引用走通；缩略图可回取且只放行本会话；@ 选择器列项目文件；超限 400', async () => {
  const { deps, app, call, dispatched } = harness();
  (deps.agents as ReturnType<typeof createLiveCatalog>).upsert('w1', [agentToDto(descriptor)]);
  const project = await call('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'demo', rootPath: '/tmp/demo' }) });
  const projectId = (project.body as { id: string }).id;
  const task = await call('/api/tasks', { method: 'POST', body: JSON.stringify({ projectId, title: 't' }) });
  const taskId = (task.body as { id: string }).id;
  const derived = await call('/api/sessions/derive', {
    method: 'POST',
    body: JSON.stringify({ taskId, agentId: 'fake', model: 'fake-1' })
  });
  const sessionId = (derived.body as { id: string }).id;

  const data = Buffer.from('png!').toString('base64');
  const prompted = await call(`/api/sessions/${sessionId}/prompt`, {
    method: 'POST',
    body: JSON.stringify({
      text: '',
      attachments: [
        { kind: 'image', name: 'a.png', mimeType: 'image/png', data },
        { kind: 'mention', path: 'src/main.ts' }
      ]
    })
  });
  assert.equal(prompted.status, 202, JSON.stringify(prompted.body));
  const sent = dispatched.at(-1);
  assert.equal(sent?.kind === 'prompt' ? sent.parts.length : 0, 2);
  // 附件由会话所在的 Worker 落盘（hub 不碰那台机器的文件系统）：这里替 worker 写一下
  const part = sent?.kind === 'prompt' ? sent.parts[0] : undefined;
  assert.ok(part?.path?.startsWith('/tmp/demo/.agent-hub/attachments/'));
  await deps.fs.writeFile(part?.path ?? '', Buffer.from('png!'));

  const entries = (await call(`/api/sessions/${sessionId}/events`)).body as JournalEntry[];
  const last = entries.at(-1)?.event;
  assert.ok(last?.kind === 'prompt' && last.attachments?.[0]);
  const imagePath = last.attachments[0].path;
  const image = await app.fetch(new Request(`http://hub/api/sessions/${sessionId}/attachment?path=${encodeURIComponent(imagePath)}`));
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await image.arrayBuffer()).toString(), 'png!');
  const escape = await call(`/api/sessions/${sessionId}/attachment?path=${encodeURIComponent('.env')}`);
  assert.equal(escape.status, 400);

  const files = await call(`/api/projects/${projectId}/files?q=a.png`);
  assert.equal(files.status, 200);
  assert.deepEqual((files.body as { files: string[] }).files, [imagePath]);

  const empty = await call(`/api/sessions/${sessionId}/prompt`, { method: 'POST', body: JSON.stringify({ text: ' ' }) });
  assert.equal(empty.status, 400);
  const svg = await call(`/api/sessions/${sessionId}/prompt`, {
    method: 'POST',
    body: JSON.stringify({ text: 'x', attachments: [{ kind: 'image', name: 'a.svg', mimeType: 'image/svg+xml', data }] })
  });
  assert.equal(svg.status, 400);
});

/** 只关心版本计算的环境适配器：prepare 原样放行（派生路由不走它）。 */
const fixedPlanner = (revision: string | null): EnvironmentPlanner => ({
  prepare: async (command) => ({ command, revision: null }),
  revision: async () => revision
});

type HarnessCall = (path: string, init?: RequestInit) => Promise<{ status: number; body: unknown }>;

/** 走真的派生路由造一条会话，只读接口的测试就不用重复铺项目 / 任务。 */
async function seedSession(call: HarnessCall, deps: ReturnType<typeof harness>['deps']): Promise<SessionId> {
  (deps.agents as ReturnType<typeof createLiveCatalog>).upsert('w1', [agentToDto(descriptor)]);
  const project = await call('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'demo', rootPath: '/tmp/demo' }) });
  const projectId = (project.body as { id: string }).id;
  const task = await call('/api/tasks', { method: 'POST', body: JSON.stringify({ projectId, title: 't' }) });
  const taskId = (task.body as { id: string }).id;
  const derived = await call('/api/sessions/derive', {
    method: 'POST',
    body: JSON.stringify({ taskId, agentId: 'fake', model: 'fake-1' })
  });
  assert.equal(derived.status, 201);
  return (derived.body as { id: string }).id as SessionId;
}

test('环境状态：没有环境适配器时 supported=false，会话上记的版本照返回', async () => {
  const { deps, call, sessions } = harness();
  const sessionId = await seedSession(call, deps);
  await sessions.setEnvironmentRevision(sessionId, 'rev-applied', 1);

  const status = await call(`/api/sessions/${sessionId}/environment`);
  assert.equal(status.status, 200);
  assert.deepEqual(status.body, { revision: null, appliedRevision: 'rev-applied', pending: false, supported: false });

  // 不存在的会话：404，而不是编一个空状态出来
  const missing = await call('/api/sessions/nope/environment');
  assert.equal(missing.status, 404);
});

test('环境状态：算出来的版本和已应用的一致时 pending=false', async () => {
  const { deps, call, sessions } = harness(null, fixedPlanner('rev-1'));
  const sessionId = await seedSession(call, deps);
  await sessions.setEnvironmentRevision(sessionId, 'rev-1', 1);

  const status = await call(`/api/sessions/${sessionId}/environment`);
  assert.equal(status.status, 200);
  assert.deepEqual(status.body, { revision: 'rev-1', appliedRevision: 'rev-1', pending: false, supported: true });
});

test('环境状态：资产 / MCP 变了以后 pending=true', async () => {
  const { deps, call, sessions } = harness(null, fixedPlanner('rev-2'));
  const sessionId = await seedSession(call, deps);
  await sessions.setEnvironmentRevision(sessionId, 'rev-1', 1);

  const status = await call(`/api/sessions/${sessionId}/environment`);
  assert.equal(status.status, 200);
  assert.deepEqual(status.body, { revision: 'rev-2', appliedRevision: 'rev-1', pending: true, supported: true });
});

test('环境状态：现在算不出来（revision=null）时 pending=false，不吓唬人', async () => {
  const { deps, call, sessions } = harness(null, fixedPlanner(null));
  const sessionId = await seedSession(call, deps);
  await sessions.setEnvironmentRevision(sessionId, 'rev-1', 1);

  const status = await call(`/api/sessions/${sessionId}/environment`);
  assert.equal(status.status, 200);
  assert.deepEqual(status.body, { revision: null, appliedRevision: 'rev-1', pending: false, supported: true });
});

test('Host：空 Host 的普通请求也 403（不泄露页面）；合法 Host 照常', async () => {
  const { deps } = inMemoryDeps();
  const app = createApp({ deps, hub: createStreamHub(), token: null, guard: createRequestGuard([]) });
  // HTTP/1.1 起 Host 必填：空值不能当成「HTTP/1.0 老客户端」放过去。
  const noHost = await app.fetch(new Request('http://hub/api/health', { headers: { host: '' } }));
  assert.equal(noHost.status, 403);
  // app.fetch 不会自动补 Host（真浏览器 / 客户端会带），所以这里显式给一个合法值。
  const ok = await app.fetch(new Request('http://127.0.0.1:7878/api/health', { headers: { host: '127.0.0.1:7878' } }));
  assert.equal(ok.status, 200);
});
