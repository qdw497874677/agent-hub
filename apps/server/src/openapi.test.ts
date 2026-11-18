import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { addTeamMember, fakeAssetSets, inMemoryAccounts, inMemoryApiTokens, inMemoryAssetReview, inMemoryAssets, inMemoryDeps } from '@agent-hub/domain/testing';
import { asAgentId, createAccessPolicy, newWorkspace, permissionsOf, uploadAsset, type AgentDescriptor, type AssetReviewDeps } from '@agent-hub/domain';
import { journalEntrySchema, projectSchema, sessionSchema, taskSchema } from '@agent-hub/contract';
import { createApp } from './http.ts';
import { createStreamHub } from './stream-hub.ts';
import { buildSpecApp, openApiInfo } from './openapi/app.ts';
import { mcpTools, mcpToolsFor, projectEvents } from './openapi/mcp.ts';
import { createRepoAuth } from './repo-auth.ts';

const PASSWORD = 'long enough pw';
const fake: AgentDescriptor = {
  id: asAgentId('fake'),
  label: 'Fake',
  capabilities: Object.fromEntries(
    ['prompt', 'interrupt', 'fork', 'resume', 'tool_calls', 'artifacts', 'structured_events', 'attachments'].map((key) => [key, { state: 'available' }])
  ) as AgentDescriptor['capabilities'],
  models: ['m1'],
  defaultModel: 'm1',
  options: []
};

function harness(rate?: { general?: number; prompt?: number; streams?: number }, enrolledBy: Map<string, string> = new Map()) {
  const accounts = inMemoryAccounts(() => Date.now());
  const world = inMemoryDeps();
  world.agents.push(fake);
  const access = createAccessPolicy({
    users: accounts.users,
    settings: accounts.settings,
    enrollment: { credentialFor: async (workerId) => (enrolledBy.has(workerId) ? ({ enrolledBy: enrolledBy.get(workerId)! } as never) : null) },
    gateway: world.deps.gateway
  });
  const deps = {
    ...world.deps,
    access,
    repoAuth: createRepoAuth({ projects: world.deps.projects, workspaces: world.deps.workspaces, secrets: world.deps.secrets })
  };
  const apiTokens = inMemoryApiTokens();
  const tokenDeps = { apiTokens, users: accounts.users, projects: world.deps.projects, tokens: accounts.tokens, audit: accounts.audit, now: () => Date.now() };
  const hub = createStreamHub();
  // 资产自动化（导入 → 发布 → 分配）要资产中心在场：MCP 的 asset_* 工具靠它干活
  const assetsStore = inMemoryAssets(() => Date.now());
  const reviewStore = inMemoryAssetReview();
  const assetReview: AssetReviewDeps = {
    ...assetsStore.deps,
    review: reviewStore.review,
    notifications: reviewStore.notifications,
    audit: accounts.audit!,
    users: accounts.users,
    teams: accounts.teams,
    policy: access
  };
  const app = createApp({
    deps,
    hub,
    token: null,
    auth: { accounts },
    activity: { audit: accounts.audit!, users: accounts.users },
    assets: { deps: assetReview, audit: accounts.audit!, assetSets: fakeAssetSets() },
    openApi: { tokens: tokenDeps, manage: tokenDeps, rate, settings: accounts.settings, audit: accounts.audit! }
  });
  const browser = () => {
    const jar = new Map<string, string>();
    return async (path: string, init: RequestInit = {}) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      if (jar.get('hub_csrf')) headers['x-hub-csrf'] = jar.get('hub_csrf')!;
      const response = await app.fetch(new Request(`http://hub${path}`, { ...init, headers }));
      for (const line of response.headers.getSetCookie()) {
        const [name, value] = line.split(';')[0]!.split('=');
        if (value === '' || /Max-Age=0/.test(line)) jar.delete(name!);
        else jar.set(name!, value!);
      }
      return { status: response.status, body: (await response.json().catch(() => null)) as any };
    };
  };
  const api = (token: string) => async (path: string, init: RequestInit = {}) => {
    const response = await app.fetch(
      new Request(`http://hub/openapi/v1${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(init.headers ?? {}) } })
    );
    return { status: response.status, headers: response.headers, body: (await response.json().catch(() => null)) as any };
  };
  return { accounts, world, app, hub, apiTokens, assetsStore, browser, api, enrolledBy };
}
const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) });

async function setup(rate?: Parameters<typeof harness>[0], enrolledBy?: Map<string, string>) {
  const h = harness(rate, enrolledBy);
  const david = h.browser();
  assert.equal((await david('/api/auth/register', post({ email: 'david@b.co', password: PASSWORD }))).status, 200);
  const mint = async (who: ReturnType<typeof h.browser>, scopes: string[], extra: Record<string, unknown> = {}) => {
    const created = await who('/api/tokens', post({ name: 'bot', scopes, ...extra }));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.body as { token: string; info: { id: string } };
  };
  return { ...h, david, mint };
}

test('令牌：明文只给一次、只存哈希；列表不带哈希；吊销后 401', async () => {
  const { david, mint, api, apiTokens } = await setup();
  const { token, info } = await mint(david, ['projects:read']);
  assert.match(token, /^ahp_/);
  const row = [...apiTokens.rows.values()][0]!;
  assert.notEqual(row.tokenHash, token);
  const listed = (await david('/api/tokens')).body;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].tokenHash, undefined);

  assert.equal((await api(token)('/projects')).status, 200);
  assert.equal((await api('ahp_nope')('/projects')).status, 401);
  assert.equal((await api(token)('/me')).body.token.id, info.id);
  assert.equal((await david(`/api/tokens/${info.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await api(token)('/projects')).status, 401);
});

test('令牌不认 cookie、令牌也造不了令牌；开放 API 不接受 cookie 登录', async () => {
  const { david, mint, app } = await setup();
  const { token } = await mint(david, ['projects:read']);
  // /api/tokens 不认 Bearer ahp_（只认登录态）
  const viaToken = await app.fetch(new Request('http://hub/api/tokens', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x', scopes: ['projects:read'] }) }));
  assert.equal(viaToken.status, 401);
  // 开放 API 不认 cookie
  assert.equal((await david('/openapi/v1/projects')).status, 401);
});

test('权限范围：只读令牌不能写；没有 workers:read 看不到机器', async () => {
  const { david, mint, api } = await setup();
  const read = api((await mint(david, ['projects:read'])).token);
  assert.equal((await read('/projects', post({ name: 'p' }))).status, 403);
  assert.equal((await read('/workers')).status, 403);
  const write = api((await mint(david, ['projects:read', 'projects:write'])).token);
  const created = await write('/projects', post({ name: 'p' }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  projectSchema.parse(created.body);
  const task = await write('/tasks', post({ projectId: created.body.id, title: 't', goal: '' }));
  assert.equal(task.status, 201);
  taskSchema.parse(task.body);
  assert.equal((await read(`/tasks?projectId=${created.body.id}`)).body.length, 1);
  assert.equal((await read(`/tasks/${task.body.id}`)).body.sessions.length, 0);
  // 只读令牌不能开会话
  assert.equal((await read('/sessions', post({ taskId: task.body.id, agentId: 'fake', model: 'm1' }))).status, 403);
});

test('成员的令牌不超过成员本人的权限：看不见主人的项目', async () => {
  const h = await setup();
  await addTeamMember(h.accounts, 'm@b.co', PASSWORD);
  const member = h.browser();
  assert.equal((await member('/api/auth/login', post({ email: 'm@b.co', password: PASSWORD }))).status, 200);
  const his = (await h.david('/api/projects', post({ name: 'his' }))).body;
  const token = (await h.mint(member, ['projects:read', 'projects:write'])).token;
  assert.equal((await h.api(token)(`/tasks?projectId=${his.id}`)).status, 404);
  assert.deepEqual((await h.api(token)('/projects')).body, []);
  // 成员建不了服务账号
  assert.equal((await member('/api/tokens', post({ name: 's', kind: 'service', scopes: ['projects:read'] }))).status, 403);
});

test('对话：开会话 → prompt（作者带 via）→ events / stream；审计写 via 令牌', async () => {
  const { david, mint, api, world, hub, accounts, app } = await setup();
  const token = (await mint(david, ['projects:read', 'projects:write', 'sessions:read', 'sessions:write', 'workers:read'])).token;
  const call = api(token);
  const project = (await call('/projects', post({ name: 'p' }))).body;
  const task = (await call('/tasks', post({ projectId: project.id, title: 't', goal: '' }))).body;
  world.workers.push({ workerId: 'w1', label: 'w1', origin: 'remote', state: 'online' } as never);
  const workerId = 'w1';
  const workspace = newWorkspace({ projectId: project.id, workerId, path: '/srv/x', kind: 'long_lived', source: 'linked', now: 1 });
  assert.ok(workspace.ok);
  await world.deps.workspaces.save(workspace.value);
  const session = await call('/sessions', post({ taskId: task.id, agentId: 'fake', model: 'm1', workspaceId: workspace.value.id }));
  assert.equal(session.status, 201, JSON.stringify(session.body));
  sessionSchema.parse(session.body);
  const prompted = await call(`/sessions/${session.body.id}/prompt`, post({ text: 'hi' }));
  assert.equal(prompted.status, 202, JSON.stringify(prompted.body));
  // 回执带轮次：调用方拿它配 sinceTurn 跟这一轮。
  assert.equal(prompted.body.turn, 1);
  const events = (await call(`/sessions/${session.body.id}/events`)).body;
  const prompt = events.map((e: unknown) => journalEntrySchema.parse(e)).find((e: { event: { kind: string } }) => e.event.kind === 'prompt');
  assert.equal(prompt.event.author.via, 'bot');
  assert.equal(prompt.turn, 1);

  const second = await call(`/sessions/${session.body.id}/prompt`, post({ text: '再来一句' }));
  assert.equal(second.body.turn, 2);
  const secondOnly = (await call(`/sessions/${session.body.id}/events?sinceTurn=2`)).body.map((e: unknown) => journalEntrySchema.parse(e));
  assert.ok(secondOnly.length > 0);
  assert.ok(secondOnly.every((entry: { turn?: number }) => entry.turn === 2));
  // 老事件没有 turn（不属于任何轮次）：sinceTurn 不返回，不带时照常给全量（#230）
  world.deps.sessions.journal.get(session.body.id)!.push({ seq: 999, at: 3, event: { kind: 'diagnostic', level: 'info', text: '老事件没有轮次' } });
  const all = (await call(`/sessions/${session.body.id}/events`)).body.map((e: unknown) => journalEntrySchema.parse(e));
  assert.ok(all.some((entry: { event: { kind: string } }) => entry.event.kind === 'diagnostic'), '不带 sinceTurn 时老事件仍然返回');
  const turnsOnly = (await call(`/sessions/${session.body.id}/events?sinceTurn=2`)).body.map((e: unknown) => journalEntrySchema.parse(e));
  assert.ok(turnsOnly.every((entry: { turn?: number }) => entry.turn === 2));
  assert.ok(!turnsOnly.some((entry: { event: { kind: string } }) => entry.event.kind === 'diagnostic'), '没有 turn 的旧事件被过滤');
  assert.ok(accounts.auditRows.some((row) => row.action === 'session.start' && row.detail.includes('via 令牌「bot」')));

  // SSE：补发已有事件
  const controller = new AbortController();
  const response = await app.fetch(new Request(`http://hub/openapi/v1/sessions/${session.body.id}/stream`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = response.body!.getReader();
  let text = '';
  while (!text.includes('"kind":"prompt"')) text += new TextDecoder().decode((await reader.read()).value);
  assert.match(text, /event: event\n/);
  assert.match(text, /\nid: \d+\n/);
  void hub;
  controller.abort();
  await reader.cancel().catch(() => undefined);
});

test('令牌打本机：机器没配原生模型也先 403，不把拒绝说成未配置模型', async () => {
  const { david, mint, api, world } = await setup();
  world.workers.splice(0, world.workers.length, {
    workerId: 'local',
    label: '本机',
    origin: 'local',
    state: 'online',
    agentIds: ['fake'],
    agentModels: [{ agentId: 'fake', models: [], defaultModel: '', readiness: { state: 'unavailable', reason: '未配置模型' }, providers: ['openai-chat'] }]
  });
  const call = api((await mint(david, ['projects:read', 'projects:write', 'sessions:read', 'sessions:write', 'workers:read'])).token);
  const project = (await call('/projects', post({ name: 'p' }))).body;
  const task = (await call('/tasks', post({ projectId: project.id, title: 't', goal: '' }))).body;
  const workspace = newWorkspace({ projectId: project.id, workerId: null, path: '/tmp/x', kind: 'long_lived', source: 'linked', now: 1 });
  assert.ok(workspace.ok);
  await world.deps.workspaces.save(workspace.value);
  const derived = await call('/sessions', post({ taskId: task.id, agentId: 'fake', model: '', workspaceId: workspace.value.id }));
  assert.equal(derived.status, 403, JSON.stringify(derived.body));
  assert.equal(JSON.stringify(derived.body).includes('未配置模型'), false);
  assert.equal(world.dispatched.length, 0);
});

test('worker.use_local 永远授不出去：hub 管理员的令牌也不能在本机开会话', async () => {
  const { david, mint, api, world } = await setup();
  const call = api((await mint(david, ['projects:read', 'projects:write', 'sessions:read', 'sessions:write', 'workers:read'])).token);
  const project = (await call('/projects', post({ name: 'p' }))).body;
  const task = (await call('/tasks', post({ projectId: project.id, title: 't', goal: '' }))).body;
  const workspace = newWorkspace({ projectId: project.id, workerId: null, path: '/tmp/x', kind: 'long_lived', source: 'linked', now: 1 });
  assert.ok(workspace.ok);
  await world.deps.workspaces.save(workspace.value);
  const before = world.dispatched.length;
  const derived = await call('/sessions', post({ taskId: task.id, agentId: 'fake', model: 'm1', workspaceId: workspace.value.id }));
  assert.equal(derived.status, 403, JSON.stringify(derived.body));
  assert.equal(world.dispatched.length, before);
  // 机器列表里也没有本机
  const workers = (await call('/workers')).body as { workerId: string; origin?: string }[];
  assert.ok(workers.every((w) => w.origin !== 'local'));
});

test('工作区改动与活动：都按项目/会话权限判定，不是拿到 id 就能读', async () => {
  const { david, mint, api, world } = await setup();
  const owner = api((await mint(david, ['projects:read', 'projects:write', 'sessions:read'])).token);
  const project = (await owner('/projects', post({ name: 'p' }))).body;
  const workspace = newWorkspace({ projectId: project.id, workerId: null, path: '/tmp/x', kind: 'long_lived', source: 'linked', now: 1 });
  assert.ok(workspace.ok);
  await world.deps.workspaces.save(workspace.value);

  // 项目成员 + 项目读权限能看；只有会话读权限的令牌不行。
  const allowed = await owner(`/workspaces/${workspace.value.id}/changes`);
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));

  // 权限不够时按策略返回 404（不泄露目录存在），不能是 200。
  const narrow = api((await mint(david, ['sessions:read'])).token);
  const denied = await narrow(`/workspaces/${workspace.value.id}/changes`);
  assert.equal(denied.status, 404, JSON.stringify(denied.body));

  const missing = await owner('/sessions/ses_00000000-0000-4000-8000-000000000000/activity');
  assert.equal(missing.status, 404, JSON.stringify(missing.body));
});

test('开会话：workspaceMode=isolated 一定新开临时空间，不静默复用长期目录（#236）', async () => {
  const { david, mint, api, world } = await setup();
  const call = api((await mint(david, ['projects:read', 'projects:write', 'sessions:read', 'sessions:write', 'workers:read'])).token);
  const project = (await call('/projects', post({ name: 'p' }))).body;
  const task = (await call('/tasks', post({ projectId: project.id, title: 't', goal: '' }))).body;
  world.workers.push({ workerId: 'w1', label: 'w1', origin: 'remote', state: 'online', roots: ['/srv/work'] } as never);
  const workspace = newWorkspace({ projectId: project.id, workerId: 'w1', path: '/srv/work/demo', kind: 'long_lived', source: 'linked', now: 1 });
  assert.ok(workspace.ok);
  await world.deps.workspaces.save(workspace.value);

  const derived = await call('/sessions', post({ taskId: task.id, agentId: 'fake', model: 'm1', workspaceId: workspace.value.id }));
  assert.equal(derived.status, 201, JSON.stringify(derived.body));

  const isolated = await call(
    '/sessions',
    post({ taskId: task.id, agentId: 'fake', model: 'm1', workerId: 'w1', workspaceMode: 'isolated' })
  );
  assert.equal(isolated.status, 201, JSON.stringify(isolated.body));
  assert.notEqual(isolated.body.workspaceId, workspace.value.id, '显式 isolated 不该复用长期目录');
  const made = await world.deps.workspaces.byId(isolated.body.workspaceId);
  assert.equal(made?.kind, 'temporary');
});

test('同步仓库：project_repos 加的仓库能在已有工作空间里补克隆（#236）', async () => {
  const { david, mint, api, world } = await setup();
  const call = api((await mint(david, ['projects:read', 'projects:write'])).token);
  const project = (await call('/projects', post({ name: 'p', repoUrl: 'https://example.com/core.git' }))).body;
  world.workers.push({ workerId: 'w1', label: 'w1', origin: 'remote', state: 'online', roots: ['/srv/work'] } as never);
  const workspace = newWorkspace({ projectId: project.id, workerId: 'w1', path: '/srv/work/agent-hub-workspaces/demo', kind: 'long_lived', source: 'cloned', repoUrl: 'https://example.com/core.git', isGit: true, now: 1 });
  assert.ok(workspace.ok);
  await world.deps.workspaces.save(workspace.value);
  world.git.repos.add(workspace.value.path);
  world.git.remotes.set(workspace.value.path, 'https://example.com/core.git');
  world.git.absent.add('/srv/work/agent-hub-workspaces/docs');

  const updated = await call(`/projects/${project.id}/repos`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      repos: [
        { name: 'core', url: 'https://example.com/core.git' },
        { name: 'docs', url: 'https://example.com/docs.git', defaultBranch: 'main' }
      ]
    })
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));

  const synced = await call(`/workspaces/${workspace.value.id}/sync`, { method: 'POST' });
  assert.equal(synced.status, 200, JSON.stringify(synced.body));
  assert.deepEqual(synced.body.added, [{ name: 'docs', path: '/srv/work/agent-hub-workspaces/docs' }]);
  assert.deepEqual(synced.body.present, [{ name: 'core', path: workspace.value.path }]);

  // 再同步一次：什么都不做（幂等工具因此可以放心重试）
  const again = await call(`/workspaces/${workspace.value.id}/sync`, { method: 'POST' });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual(again.body.added, []);

  // 私有仓库：清单里的 credential 要在克隆时真正变成 Authorization 头（只在密钥箱里，不回给调用方）
  const privateRepo = await call(`/projects/${project.id}/repos`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repos: [{ name: 'secret-repo', url: 'https://code.example.com/team/secret.git', credential: 'tok-123' }] })
  });
  assert.equal(privateRepo.status, 200, JSON.stringify(privateRepo.body));
  assert.ok(!JSON.stringify(privateRepo.body).includes('tok-123'));
  world.git.absent.add('/srv/work/agent-hub-workspaces/secret-repo');
  const withToken = await call(`/workspaces/${workspace.value.id}/sync`, { method: 'POST' });
  assert.equal(withToken.status, 200, JSON.stringify(withToken.body));
  const header = Buffer.from('x-access-token:tok-123').toString('base64');
  assert.ok(
    world.git.authCalls.some((line) => line.includes(':clone:https://code.example.com/team/secret.git') && line.includes(header)),
    `克隆该私有仓库时要带令牌头：${world.git.authCalls.join('\n')}`
  );
});

test('限流：超了 429 + Retry-After', async () => {
  const { david, mint, api } = await setup({ general: 3 });
  const call = api((await mint(david, ['projects:read'])).token);
  for (let i = 0; i < 3; i++) assert.equal((await call('/projects')).status, 200);
  const limited = await call('/projects');
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
});

test('服务账号：主人能建；不占席位、不出现在成员列表；吊销即停用', async () => {
  const { david, api, accounts } = await setup();
  const created = await david('/api/tokens', post({ name: 'ci-bot', kind: 'service', scopes: ['projects:read'] }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const me = (await api(created.body.token)('/me')).body;
  assert.equal(me.user.service, true);
  assert.equal(me.user.name, 'ci-bot');
  const members = (await david('/api/team')).body;
  assert.ok(!JSON.stringify(members).includes('service.agent-hub.invalid'));
  assert.equal((await david(`/api/tokens/${created.body.info.id}`, { method: 'DELETE' })).status, 200);
  const user = await accounts.users.byId(me.user.id);
  assert.ok(user?.disabledAt);
});

test('MCP：列工具、调工具（同一个令牌、同一套权限）', async () => {
  const { david, mint, app } = await setup();
  const token = (await mint(david, ['projects:read'])).token;
  const rpc = async (body: unknown) => {
    const response = await app.fetch(new Request('http://hub/openapi/v1/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json().catch(() => null)) as any };
  };
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  assert.equal(init.status, 200, JSON.stringify(init.body));
  const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const names = list.body.result.tools.map((t: { name: string }) => t.name);
  // 只列这个令牌用得了的：projects:read 只有项目 / 任务，看不到会话、资产（#E4）
  assert.deepEqual(names.sort(), ['get_project', 'get_task', 'list_projects', 'list_task_log', 'list_tasks', 'workspace_changes']);
  // 写工具不进清单；注解标成只读。
  assert.ok(!names.includes('prompt') && !names.includes('create_task') && !names.includes('delete_project'));
  const project = list.body.result.tools.find((t: { name: string }) => t.name === 'list_projects');
  assert.equal(project.annotations.readOnlyHint, true);
  assert.match(project.description, /下一步/);
  const called = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_projects', arguments: {} } });
  assert.equal(called.body.result.isError, false, JSON.stringify(called.body));
  // 白名单外：不是 403，而是「没有这个工具」（连存在性都不确认）。
  const denied = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'create_task', arguments: { projectId: 'p', title: 'x' } } });
  assert.equal(denied.body.result.isError, true);
  assert.match(denied.body.result.content[0].text, /没有这个工具/);
  // 开着、但令牌没权限：调用时说清缺哪个 scope
  const locked = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_session', arguments: { sessionId: 's' } } });
  assert.equal(locked.body.result.isError, true);
  assert.match(locked.body.result.content[0].text, /403.*sessions:read/);
  // 没令牌：401
  const anonymous = await app.fetch(new Request('http://hub/openapi/v1/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
  assert.equal(anonymous.status, 401);
});

test('规范快照：openapi.json 与 docs/openapi/v1.json 一致（改了接口要更新快照）', async () => {
  const { app } = await setup();
  const live = await (await app.fetch(new Request('http://hub/openapi/v1/openapi.json'))).json();
  const built = buildSpecApp().getOpenAPI31Document(openApiInfo);
  assert.deepEqual(live, JSON.parse(JSON.stringify(built)));
  const file = fileURLToPath(new URL('../../../docs/openapi/v1.json', import.meta.url));
  const snapshot = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(live, snapshot, '规范变了：跑 npm run openapi:snapshot 并在 PR 里说明');
  assert.ok(Object.values(live.paths).flatMap((p: any) => Object.keys(p)).length >= 26);
  assert.equal((await app.fetch(new Request('http://hub/openapi/v1/docs'))).status, 200);
  assert.equal(mcpTools({ modules: new Set(['tasks', 'projects', 'sessions', 'assets']) }).length, 30);
});

test('过期的令牌、被停用的人的令牌：401', async () => {
  const { david, mint, api, apiTokens, accounts } = await setup();
  const { token, info } = await mint(david, ['projects:read']);
  const row = apiTokens.rows.get(info.id)!;
  apiTokens.rows.set(info.id, { ...row, expiresAt: Date.now() - 1 });
  assert.equal((await api(token)('/projects')).status, 401);
  apiTokens.rows.set(info.id, row);
  assert.equal((await api(token)('/projects')).status, 200);
  const user = (await accounts.users.byId(row.userId as never))!;
  await accounts.users.save({ ...user, disabledAt: Date.now() });
  assert.equal((await api(token)('/projects')).status, 401);
});


test('MCP 策略：按模块收窄、只读闸门；投影丢掉工具输入输出', () => {
  // 默认不强制只读：有写工具就一起列出来（能不能调由令牌权限和只读模式决定）
  assert.deepEqual(mcpTools({ modules: new Set(['tasks']) }).map((t) => t.name).sort(), ['append_task_log', 'edit_task_log', 'get_task', 'list_task_log', 'list_tasks', 'set_task_status', 'set_task_summary', 'task_create']);
  assert.deepEqual(mcpTools({ modules: new Set(['projects']), readOnly: true }).map((t) => t.name), ['list_projects', 'get_project', 'workspace_changes']);
  assert.equal(mcpTools({ readOnly: true }).length, 12);
  // 资产自动化：三个新写工具只在开了写开关时出现，且都可重放
  const assetWrites = mcpTools({ modules: new Set(['assets']), writes: true });
  assert.deepEqual(assetWrites.map((t) => t.name).sort(), ['asset_assign', 'asset_create', 'asset_import', 'asset_publish', 'get_asset', 'list_assets']);
  assert.ok(assetWrites.filter((t) => !t.readOnly).every((t) => t.idempotent));
  assert.equal(assetWrites.filter((t) => t.readOnly).length, 2);
  const projected = projectEvents([
    { seq: 1, at: 1, event: { kind: 'prompt', text: 'AWS_SECRET_ACCESS_KEY=abc' } },
    { seq: 2, at: 2, turn: 1, event: { kind: 'tool_call', name: 'bash', input: { command: 'echo AWS_SECRET_ACCESS_KEY=abc' } } },
    { seq: 3, at: 3, event: { kind: 'tool_result', ok: true, output: 'AWS_SECRET_ACCESS_KEY=abc' } },
    { seq: 4, at: 4, event: { kind: 'text', delta: '好了' } },
    { seq: 5, at: 5, event: { kind: 'thinking', text: '密钥是 abc' } },
    { seq: 6, at: 6, event: { kind: 'ended', outcome: 'done', reason: 'ok' } }
  ]) as { event: Record<string, unknown>; turn?: number }[];
  const text = JSON.stringify(projected);
  assert.ok(!text.includes('AWS_SECRET'), text);
  assert.deepEqual(projected.map((p) => p.event['kind']), ['tool', 'tool_result', 'text', 'ended']);
  // 正文在领域里叫 delta；投影后统一成 text，不能丢内容。
  assert.deepEqual(projected[2]!.event, { kind: 'text', text: '好了' });
  assert.deepEqual(projected[0]!.event, { kind: 'tool', name: 'bash' });
  // turn 要留给调用方（events?sinceTurn= 对得上轮次）；没有 turn 的老事件不凭空生成。
  assert.equal(projected[0]!.turn, 1);
  assert.equal('turn' in projected[1]!, false);
});

test('MCP 委派：写工具默认不出现，MCP_WRITE 打开后可建任务，clientRequestId 重放同一结果', async () => {
  const { david, mint, app } = await setup();
  const project = (await david('/api/projects', post({ name: '委派' }))).body as { id: string };
  const token = (await mint(david, ['projects:read', 'projects:write', 'sessions:write'])).token;
  const replays = new Map<string, string>();
  const store = {
    async get(key: string) {
      return replays.get(key) ?? null;
    },
    async put(key: string, body: string) {
      replays.set(key, body);
    }
  };
  const rpc = async (body: unknown, policy?: { writes?: boolean; readOnly?: boolean }) => {
    const response = await app.fetch(
      new Request('http://hub/openapi/v1/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify(body)
      }),
      { mcpReplays: store, mcpPolicy: { modules: new Set(['tasks', 'sessions', 'projects']), readOnly: false, writes: true, ...policy } }
    );
    return (await response.json().catch(() => null)) as any;
  };
  const list = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const names = list.result.tools.map((t: { name: string }) => t.name);
  assert.ok(names.includes('task_create') && names.includes('session_start') && names.includes('session_reply') && names.includes('session_cancel'));
  const writeTool = list.result.tools.find((t: { name: string }) => t.name === 'task_create');
  assert.equal(writeTool.annotations.readOnlyHint, false);
  assert.equal(writeTool.annotations.idempotentHint, true);

  const noKey = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'task_create', arguments: { projectId: project.id, title: '委派任务' } } });
  assert.equal(noKey.result.isError, true);
  assert.match(noKey.result.content[0].text, /clientRequestId/);

  const call = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'task_create', arguments: { projectId: project.id, title: '委派任务', clientRequestId: 'req-1' } } };
  const first = await rpc(call);
  assert.equal(first.result.isError, false, JSON.stringify(first.result));
  const second = await rpc({ ...call, id: 4 });
  assert.deepEqual(second.result.structuredContent, first.result.structuredContent);
  const listed = await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'list_tasks', arguments: { projectId: project.id } } });
  const tasks = JSON.parse(listed.result.content[0].text) as { id: string }[];
  assert.equal(tasks.length, 1);

  // 只读闸门压过写开关。
  const readOnly = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }, { readOnly: true });
  assert.ok(!readOnly.result.tools.some((t: { name: string }) => t.name === 'task_create'));
});

const b64 = (text: string) => Buffer.from(text).toString('base64');
const skillFiles = (body: string) => [{ path: 'SKILL.md', data: b64(`---\nname: greeter\ndescription: Greets people\n---\n${body}\n`) }];

test('资产自动化：assets:publish 能导入 → 发布 → 分配；没有该 scope 时 403；非集群管理员发布全局 403', async () => {
  const { david, mint, app, accounts, assetsStore, browser, world, enrolledBy } = await setup();
  const replays = new Map<string, string>();
  const store = {
    async get(key: string) {
      return replays.get(key) ?? null;
    },
    async put(key: string, body: string) {
      replays.set(key, body);
    }
  };
  const mcp = (token: string) => async (name: string, args: Record<string, unknown>) => {
    const response = await app.fetch(
      new Request('http://hub/openapi/v1/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
      }),
      { mcpReplays: store, mcpPolicy: { modules: new Set(['assets']), readOnly: false, writes: true } }
    );
    return (await response.json().catch(() => null)) as any;
  };

  const publishToken = (await mint(david, ['assets:read', 'assets:write', 'assets:publish'])).token;
  const plainToken = (await mint(david, ['assets:read', 'assets:write'])).token;
  const publish = mcp(publishToken);
  const plain = mcp(plainToken);

  // 1) 导入：publish=true 要 assets:publish；没给就在碰仓库之前 403
  const blocked = await plain('asset_import', { kind: 'skill', url: 'https://example.com/x.git', path: 'skills/foo', publish: true, clientRequestId: 'imp-0' });
  assert.equal(blocked.result.isError, true, JSON.stringify(blocked.result));
  assert.match(blocked.result.content[0].text, /403/);
  assert.match(blocked.result.content[0].text, /assets:publish/);
  // 空 path 也拒（否则技能会把整个仓库拖进来）—— 复用 create 之外的分支，走的是 400
  const noPath = await publish('asset_import', { kind: 'skill', url: 'https://example.com/x.git', clientRequestId: 'imp-1' });
  assert.equal(noPath.result.isError, true, JSON.stringify(noPath.result));
  assert.match(noPath.result.content[0].text, /400/);

  // 2) 建资产（待审核）→ 发布 → 分配
  const created = await publish('asset_create', { kind: 'skill', files: skillFiles('v1'), clientRequestId: 'create-1' });
  assert.equal(created.result.isError, false, JSON.stringify(created.result));
  const asset = created.result.structuredContent as { id: string; pinned: string; latest: string };
  assert.equal(asset.pinned, '');
  assert.notEqual(asset.latest, '');

  const published = await publish('asset_publish', { assetId: asset.id, clientRequestId: 'publish-1' });
  assert.equal(published.result.isError, false, JSON.stringify(published.result));
  assert.equal(published.result.structuredContent.pinned, asset.latest);
  // 返回的是对外视图（列表同款），不是领域对象：有 workerIds/files/bytes，没有内部 tokenSecret。
  const view = published.result.structuredContent as { workerIds: string[]; files: number; bytes: number; source: { tokenSecret?: string } };
  assert.ok(Array.isArray(view.workerIds));
  assert.equal(typeof view.files, 'number');
  assert.equal(typeof view.bytes, 'number');
  assert.equal(view.source.tokenSecret, undefined);
  // 再发一次：没有待发布的新版本 → 409
  const again = await publish('asset_publish', { assetId: asset.id, clientRequestId: 'publish-2' });
  assert.equal(again.result.isError, true);
  assert.match(again.result.content[0].text, /409/);

  const assigned = await publish('asset_assign', { assetId: asset.id, workerId: 'w1', clientRequestId: 'assign-1' });
  assert.equal(assigned.result.isError, false, JSON.stringify(assigned.result));
  assert.deepEqual(assigned.result.structuredContent, { assetId: asset.id, workerId: 'w1', installed: true });
  assert.ok(assetsStore.installs.some((row) => row.assetId === asset.id && row.workerId === 'w1'));

  // 2b) 跨团队机器（#230）：凭据归属另一个团队 → 403，不能把资产装到别人的机器上
  await accounts.users.save({
    id: 'u-outsider',
    email: 'outsider@x.co',
    displayName: 'outsider',
    role: 'member',
    passwordHash: null,
    emailVerifiedAt: 1,
    disabledAt: null,
    createdAt: 1,
    teamId: 't-other',
    clusterAdmin: false,
    deletedAt: null
  } as never);
  enrolledBy.set('w-other', 'u-outsider');
  world.workers.push({ workerId: 'w-other', label: 'other', origin: 'remote', state: 'online' } as never);
  assetsStore.workers.push({ workerId: 'w-other', label: 'other', origin: 'remote', state: 'online' } as never);
  const crossTeam = await publish('asset_assign', { assetId: asset.id, workerId: 'w-other', clientRequestId: 'assign-other' });
  assert.equal(crossTeam.result.isError, true, JSON.stringify(crossTeam.result));
  assert.match(crossTeam.result.content[0].text, /403/);
  assert.ok(!assetsStore.installs.some((row) => row.assetId === asset.id && row.workerId === 'w-other'));

  // 3) 没有 assets:publish：发布 / 分配都 403
  const publishDenied = await plain('asset_publish', { assetId: asset.id, clientRequestId: 'publish-3' });
  assert.equal(publishDenied.result.isError, true);
  assert.match(publishDenied.result.content[0].text, /403/);
  const assignDenied = await plain('asset_assign', { assetId: asset.id, workerId: 'w1', clientRequestId: 'assign-2' });
  assert.equal(assignDenied.result.isError, true);
  assert.match(assignDenied.result.content[0].text, /403/);
  // 没 assets:write 的令牌连导入都进不去
  const readOnlyToken = (await mint(david, ['assets:read'])).token;
  const importDenied = await mcp(readOnlyToken)('asset_import', { kind: 'skill', url: 'https://example.com/x.git', path: 'skills/foo', clientRequestId: 'imp-2' });
  assert.equal(importDenied.result.isError, true);
  assert.match(importDenied.result.content[0].text, /403/);

  // 4) 全局资产：非集群管理员发布 403（全局发布只有集群管理员能做）
  // 管理后台要另装 admin 路由，这里直接用领域用例造一个全局资产
  const boss = (await accounts.users.firstClusterAdmin())!;
  const globalMade = await uploadAsset(assetsStore.deps, {
    kind: 'skill',
    projectId: null,
    files: [{ path: 'SKILL.md', data: new Uint8Array(Buffer.from(`---\nname: greeter\ndescription: Greets people\n---\nglobal\n`)) }],
    scope: 'global',
    ownerId: boss.id,
    teamId: null,
    publish: true
  });
  assert.ok(globalMade.ok, JSON.stringify(globalMade));
  const global = { id: globalMade.value.id };
  assert.equal(globalMade.value.scope, 'global');
  await addTeamMember(accounts, 'a@b.co', PASSWORD, 'owner');
  const adminBrowser = browser();
  assert.equal((await adminBrowser('/api/auth/login', post({ email: 'a@b.co', password: PASSWORD }))).status, 200);
  const adminToken = (await mint(adminBrowser, ['assets:read', 'assets:write', 'assets:publish'])).token;
  const globalDenied = await mcp(adminToken)('asset_publish', { assetId: global.id, clientRequestId: 'publish-global' });
  assert.equal(globalDenied.result.isError, true, JSON.stringify(globalDenied.result));
  assert.match(globalDenied.result.content[0].text, /403/);
  assert.match(globalDenied.result.content[0].text, /集群管理员/);
  // 审计留痕：发布 / 分配都写进了活动日志，且看得出是经哪个令牌做的
  const actions = accounts.auditRows.map((row) => row.action);
  assert.ok(actions.includes('asset.publish'));
  assert.ok(actions.includes('asset.install'));
  assert.ok(accounts.auditRows.some((row) => row.action === 'asset.publish' && row.detail.includes('经令牌')));
});

test('项目级资产发布：同团队非项目成员的令牌 403；项目成员 / 负责人可以（#230）', async () => {
  const { david, mint, api, accounts, browser, assetsStore } = await setup();
  const boss = (await accounts.users.firstClusterAdmin())!;
  const project = (await david('/api/projects', post({ name: '项目' }))).body as { id: string; name: string; teamId: string; createdBy: string; members?: string[] };
  assetsStore.projectList.set(project.id, { id: project.id, name: project.name, teamId: project.teamId, createdBy: project.createdBy, members: project.members ?? [boss.id], deletedAt: null } as never);
  const made = await uploadAsset(assetsStore.deps, {
    kind: 'skill',
    projectId: project.id,
    files: skillFiles('p1').map((file) => ({ path: file.path, data: Buffer.from(file.data, 'base64') })),
    scope: 'project',
    ownerId: boss.id,
    teamId: boss.teamId,
    publish: false
  });
  assert.ok(made.ok, JSON.stringify(made));

  // 同团队成员、但不是项目成员：assets:publish 也不能发布项目级资产
  await addTeamMember(accounts, 'm@b.co', PASSWORD, 'member');
  const member = browser();
  assert.equal((await member('/api/auth/login', post({ email: 'm@b.co', password: PASSWORD }))).status, 200);
  const memberToken = (await mint(member, ['assets:read', 'assets:write', 'assets:publish'])).token;
  const denied = await api(memberToken)(`/assets/${made.value.id}/publish`, post({}));
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.equal((await assetsStore.deps.assets.get(made.value.id))?.pinned, '');

  const ownerToken = (await mint(david, ['assets:read', 'assets:write', 'assets:publish'])).token;
  const published = await api(ownerToken)(`/assets/${made.value.id}/publish`, post({}));
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.equal(published.body.pinned, made.value.latest);
});

test('/openapi/v1/projects：仓库只给 hasToken，令牌名 / 明文都不出去', async () => {
  const { david, mint, api } = await setup();
  const project = (await david('/api/projects', post({ name: 'p' }))).body;
  const saved = await david(`/api/projects/${project.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ repos: [{ name: 'api', url: 'https://gitlab.test/me/api.git', credential: 'glpat-abc' }] })
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const read = api((await mint(david, ['projects:read'])).token);
  const got = await read(`/projects/${project.id}`);
  assert.equal(got.status, 200, JSON.stringify(got.body));
  assert.equal(got.body.repos[0].hasToken, true);
  assert.equal('tokenSecret' in got.body.repos[0], false);
  assert.equal(JSON.stringify(got.body).includes('glpat-abc'), false);
  const list = await read('/projects');
  assert.equal(JSON.stringify(list.body).includes('repo-git:'), false);
});

test('MCP 工具清单按令牌权限筛：只列令牌用得了的（#E4）', () => {
  const policy = { modules: new Set(['tasks', 'projects', 'sessions', 'assets'] as const), writes: true };
  const names = (scopes: Parameters<typeof permissionsOf>[0]) => mcpToolsFor(permissionsOf(scopes), policy).map((t) => t.name).sort();
  assert.deepEqual(names(['assets:read']), ['get_asset', 'list_assets']);
  // 交资产（进审核）不等于发布 / 分配
  assert.deepEqual(names(['assets:write']), ['asset_create', 'asset_import', 'get_asset', 'list_assets']);
  assert.ok(names(['assets:publish']).includes('asset_publish') && names(['assets:publish']).includes('asset_assign'));
  // 只有 sessions:write 看不到项目写工具
  const sessions = names(['sessions:write']);
  assert.ok(sessions.includes('session_start') && !sessions.includes('project_create') && !sessions.includes('list_projects'));
  // 没有令牌信息（单测直接调）时不筛
  assert.equal(mcpToolsFor(undefined, policy).length, mcpTools(policy).length);
});

test('外部接入：限定项目的令牌经 MCP 只看得到选中的项目；调用写进令牌的调用记录', async () => {
  const { david, app } = await setup();
  const mine = (await david('/api/projects', post({ name: '甲' }))).body as { id: string };
  const other = (await david('/api/projects', post({ name: '乙' }))).body as { id: string };
  const created = await david('/api/tokens', post({ name: 'scoped', scopes: ['projects:read'], projectIds: [mine.id] }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { token, info } = created.body as { token: string; info: { id: string; projectIds: string[] } };
  assert.deepEqual(info.projectIds, [mine.id]);
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const response = await app.fetch(
      new Request('http://hub/openapi/v1/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
      })
    );
    return (await response.json()) as any;
  };
  const listed = await rpc('list_projects', {});
  assert.equal(listed.result.isError, false, JSON.stringify(listed));
  const names = JSON.stringify(listed.result.structuredContent);
  assert.ok(names.includes('甲') && !names.includes('乙'), names);
  const denied = await rpc('get_project', { projectId: other.id });
  assert.equal(denied.result.isError, true);
  // 调用记录：每次 tools/call 一条，只有工具名和结果
  const activity = await david(`/api/tokens/${info.id}/activity`);
  assert.equal(activity.status, 200);
  const calls = (activity.body as { action: string; detail: string }[]).filter((row) => row.action === 'mcp.call');
  assert.equal(calls.length, 2);
  assert.ok(calls.some((row) => row.detail.startsWith('list_projects · 成功')));
  assert.ok(calls.some((row) => row.detail.startsWith('get_project · 失败')));
  // 能用的工具数：projects:read → 项目 + 任务的只读工具
  const tools = await david(`/api/tokens/${info.id}/tools`);
  assert.deepEqual((tools.body as { tools: { name: string }[] }).tools.map((t) => t.name).sort(), ['get_project', 'get_task', 'list_projects', 'list_task_log', 'list_tasks', 'workspace_changes']);
});

test('外部接入：轮换后旧令牌 401、新令牌可用，旧记录留在列表里', async () => {
  const { david, api, mint } = await setup();
  const first = await mint(david, ['projects:read']);
  const rotated = await david(`/api/tokens/${first.info.id}/rotate`, post({}));
  assert.equal(rotated.status, 201, JSON.stringify(rotated.body));
  const next = rotated.body as { token: string; info: { id: string } };
  assert.equal((await api(first.token)('/projects')).status, 401);
  assert.equal((await api(next.token)('/projects')).status, 200);
  const list = (await david('/api/tokens')).body as { id: string; revokedAt: number | null }[];
  assert.ok(list.some((t) => t.id === first.info.id && t.revokedAt !== null));
  // 吊销同样保留记录
  assert.equal((await david(`/api/tokens/${next.info.id}`, { method: 'DELETE' })).status, 200);
  assert.ok(((await david('/api/tokens')).body as { id: string; revokedAt: number | null }[]).some((t) => t.id === next.info.id && t.revokedAt !== null));
});

test('外部接入：只读模式——默认按令牌权限放行，集群管理员可强制只读；null 恢复默认；成员不能改', async () => {
  const { david, mint, app, browser, accounts } = await setup();
  const token = (await mint(david, ['projects:read', 'projects:write'])).token;
  const toolNames = async () => {
    const response = await app.fetch(
      new Request('http://hub/openapi/v1/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
      })
    );
    return ((await response.json()) as any).result.tools.map((t: { name: string }) => t.name) as string[];
  };
  const before = (await david('/api/mcp/access')).body as { readOnly: boolean; source: string; canManage: boolean };
  assert.equal(before.source, 'env');
  assert.equal(before.readOnly, false, '默认不强制只读，写不写由令牌 scope 决定');
  assert.equal(before.canManage, true, '第一个注册的人是集群管理员');
  assert.ok((await toolNames()).includes('task_create'), '有 task.create 权限的令牌默认就能看到写工具');
  const on = await david('/api/mcp/access', { method: 'PUT', body: JSON.stringify({ readOnly: true }) });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.deepEqual({ readOnly: on.body.readOnly, source: on.body.source }, { readOnly: true, source: 'setting' });
  assert.ok(!(await toolNames()).includes('task_create'), '强制只读时写工具不出现');
  const reset = await david('/api/mcp/access', { method: 'PUT', body: JSON.stringify({ readOnly: null }) });
  assert.equal(reset.body.source, 'env');
  assert.ok((await toolNames()).includes('task_create'));
  // 同一份清单，只读令牌仍然只拿到只读工具
  const reader = (await mint(david, ['projects:read'])).token;
  const readTools = await (async () => {
    const response = await app.fetch(
      new Request('http://hub/openapi/v1/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${reader}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
      })
    );
    return ((await response.json()) as any).result.tools.map((t: { name: string }) => t.name) as string[];
  })();
  assert.ok(!readTools.includes('task_create'));
  // 团队里的普通成员：能看不能改
  await addTeamMember(accounts, 'eve@b.co', PASSWORD);
  const eve = browser();
  assert.equal((await eve('/api/auth/login', post({ email: 'eve@b.co', password: PASSWORD }))).status, 200);
  const eveView = await eve('/api/mcp/access');
  assert.equal(eveView.status, 200);
  assert.equal(eveView.body.canManage, false);
  assert.equal((await eve('/api/mcp/access', { method: 'PUT', body: JSON.stringify({ readOnly: true }) })).status, 403);
});

test('外部接入：限定项目的令牌能用项目所在团队的团队资产（读 + 按权限写）；别的团队 404；个人资产看不到；项目不在团队里就没有团队资产', async () => {
  const { david, mint, api, assetsStore, world, accounts } = await setup();
  const mine = (await david('/api/projects', post({ name: '甲' }))).body as { id: string; teamId: string };
  const elsewhere = (await david('/api/projects', post({ name: '乙' }))).body as { id: string; teamId: string };
  const namedSkill = (name: string) => [{ path: 'SKILL.md', data: b64(`---\nname: ${name}\ndescription: ${name}\n---\nhi\n`) }];
  const myId = (await accounts.users.firstClusterAdmin())!.id;
  for (const p of [mine, elsewhere]) assetsStore.projectList.set(p.id, { id: p.id, name: p.id, teamId: p.teamId, createdBy: myId, members: [myId], deletedAt: null } as never);
  const make = async (name: string, scope: 'team' | 'global' | 'personal' | 'project', teamId: string | null, projectId: string | null = null) => {
    const made = await uploadAsset(assetsStore.deps, {
      kind: 'skill',
      name,
      projectId,
      files: skillFiles(name).map((file) => ({ path: file.path, data: Buffer.from(file.data, 'base64') })),
      scope,
      ownerId: myId,
      teamId,
      publish: true
    });
    assert.ok(made.ok, JSON.stringify(made));
    return made.value.id;
  };
  const teamAsset = await make('team-own', 'team', mine.teamId);
  const otherTeam = await make('team-other', 'team', 'team-somebody-else');
  const global = await make('global-one', 'global', null);
  const personal = await make('personal-one', 'personal', mine.teamId);
  const inProject = await make('project-mine', 'project', mine.teamId, mine.id);
  const outProject = await make('project-other', 'project', mine.teamId, elsewhere.id);

  const writer = (await mint(david, ['assets:read', 'assets:write', 'projects:read'], { projectIds: [mine.id] })).token;
  const call = api(writer);
  // 读：同团队团队资产、全局、范围内项目资产可见；别的团队、个人、范围外项目都看不到
  const listed = await call('/assets');
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  const ids = (listed.body as { id: string }[]).map((a) => a.id);
  for (const id of [teamAsset, global, inProject]) assert.ok(ids.includes(id), `应可见 ${id}`);
  for (const id of [otherTeam, personal, outProject]) assert.ok(!ids.includes(id), `不应可见 ${id}`);
  assert.equal((await call(`/assets/${teamAsset}`)).status, 200);
  assert.equal((await call(`/assets/${otherTeam}`)).status, 404);
  assert.equal((await call(`/assets/${personal}`)).status, 404);
  // 写：有 assets:write 就能给同团队的团队资产交新版本、建团队资产；个人资产不行；别的团队的照样 404
  const revised = await call(`/assets/${teamAsset}/revisions`, post({ files: skillFiles('team-own v2') }));
  assert.equal(revised.status, 200, JSON.stringify(revised.body));
  assert.equal((await call(`/assets/${otherTeam}/revisions`, post({ files: skillFiles('x') }))).status, 404);
  const createdTeam = await call('/assets', post({ kind: 'skill', scope: 'team', files: namedSkill('team-new') }));
  assert.equal(createdTeam.status, 201, JSON.stringify(createdTeam.body));
  assert.equal((await call('/assets', post({ kind: 'skill', scope: 'personal', files: namedSkill('mine-new') }))).status, 403);
  // 只读令牌：看得到团队资产，但交不了新版本
  const reader = (await mint(david, ['assets:read'], { projectIds: [mine.id] })).token;
  assert.equal((await api(reader)(`/assets/${teamAsset}`)).status, 200);
  assert.equal((await api(reader)(`/assets/${teamAsset}/revisions`, post({ files: skillFiles('nope') }))).status, 403);

  // 项目不在任何团队里（hub 项目）：限定到它的令牌没有团队资产可用；全局照样可读
  const loose = (await mint(david, ['assets:read', 'assets:write'], { projectIds: [elsewhere.id] })).token;
  const project = (await world.deps.projects.byId(elsewhere.id as never))!;
  await world.deps.projects.save({ ...project, teamId: null } as never);
  assert.equal((await api(loose)(`/assets/${teamAsset}`)).status, 404);
  assert.equal((await api(loose)(`/assets/${global}`)).status, 200);
  assert.equal((await api(loose)(`/assets/${teamAsset}/revisions`, post({ files: skillFiles('nope') }))).status, 404);
  assert.equal((await api(loose)('/assets', post({ kind: 'skill', scope: 'team', files: namedSkill('team-x') }))).status, 403);
});

test('开放 API project_repos：令牌只写不读，响应只有 hasToken；MCP 工具按写开关出现', async () => {
  const { david, mint, app, api } = await setup();
  const project = (await david('/api/projects', post({ name: '私有仓库' }))).body as { id: string };
  const token = (await mint(david, ['projects:read', 'projects:write'])).token;
  const call = api(token);

  const saved = await call(`/projects/${project.id}/repos`, {
    method: 'PUT',
    body: JSON.stringify({ repos: [{ name: 'api', url: 'https://gitlab.test/me/api.git', credential: 'glpat-secret' }] })
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.repos[0].hasToken, true);
  assert.equal(JSON.stringify(saved.body).includes('glpat'), false);
  assert.equal('tokenSecret' in saved.body.repos[0], false);

  // 省略 credential = 不动已有的令牌
  const kept = await call(`/projects/${project.id}/repos`, {
    method: 'PUT',
    body: JSON.stringify({ repos: [{ name: 'api', url: 'https://gitlab.test/me/api.git' }] })
  });
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  assert.equal(kept.body.repos[0].hasToken, true);

  // MCP：写开关关着就列不出来，打开后能调
  const rpc = async (body: unknown, policy?: { writes?: boolean; readOnly?: boolean }) => {
    const response = await app.fetch(
      new Request('http://hub/openapi/v1/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify(body)
      }),
      { mcpPolicy: { modules: new Set(['projects']), readOnly: false, writes: false, ...policy } }
    );
    return (await response.json().catch(() => null)) as any;
  };
  const closed = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  assert.ok(!closed.result.tools.some((t: { name: string }) => t.name === 'project_repos'));
  const open = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { writes: true });
  const tool = open.result.tools.find((t: { name: string }) => t.name === 'project_repos');
  assert.ok(tool);
  assert.equal(tool.annotations.readOnlyHint, false);
  const cleared = await rpc(
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'project_repos', arguments: { projectId: project.id, repos: [{ name: 'api', url: 'https://gitlab.test/me/api.git', credential: '' }], clientRequestId: 'req-repos' } } },
    { writes: true }
  );
  assert.equal(cleared.result.isError, false, JSON.stringify(cleared.result));
  assert.equal(cleared.result.structuredContent.hasToken === undefined ? cleared.result.structuredContent.repos[0].hasToken : cleared.result.structuredContent.hasToken, false);
});

test('MCP session_model：写工具要 clientRequestId，换模型不重启进程（同提供商）', async () => {
  const { david, mint, app, world, api } = await setup();
  const token = (await mint(david, ['projects:read', 'projects:write', 'sessions:read', 'sessions:write', 'workers:read'])).token;
  const call = api(token);
  const project = (await call('/projects', post({ name: '换模型' }))).body;
  const task = (await call('/tasks', post({ projectId: project.id, title: 't', goal: '' }))).body;
  world.workers.push({ workerId: 'w1', label: 'w1', origin: 'remote', state: 'online' } as never);
  const workspace = newWorkspace({ projectId: project.id, workerId: 'w1', path: '/srv/y', kind: 'long_lived', source: 'linked', now: 1 });
  assert.ok(workspace.ok);
  await world.deps.workspaces.save(workspace.value);
  const session = await call('/sessions', post({ taskId: task.id, agentId: 'fake', model: 'm1', workspaceId: workspace.value.id }));
  assert.equal(session.status, 201, JSON.stringify(session.body));

  const rpc = async (body: unknown, policy?: { writes?: boolean }) => {
    const response = await app.fetch(
      new Request('http://hub/openapi/v1/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify(body)
      }),
      { mcpPolicy: { modules: new Set(['sessions']), readOnly: false, writes: true, ...policy } }
    );
    return (await response.json().catch(() => null)) as any;
  };

  const list = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const tool = list.result.tools.find((t: { name: string }) => t.name === 'session_model');
  assert.ok(tool, 'MCP_WRITE 打开时会话工具里有 session_model');
  assert.equal(tool.annotations.readOnlyHint, false);
  const hidden = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { writes: false });
  assert.ok(!hidden.result.tools.some((t: { name: string }) => t.name === 'session_model'));

  const noKey = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'session_model', arguments: { sessionId: session.body.id, model: 'm2' } } });
  assert.equal(noKey.result.isError, true);
  assert.match(noKey.result.content[0].text, /clientRequestId/);

  const changed = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'session_model', arguments: { sessionId: session.body.id, model: 'm2', clientRequestId: 'req-model' } } });
  assert.equal(changed.result.isError, false, JSON.stringify(changed.result));
  // 同一提供商：只下发 set_option，不重启进程（换提供商才走 switchSessionModel）。
  const frame = world.dispatched.filter((c: { kind: string }) => c.kind === 'set_option').at(-1) as { optionId?: string; value?: unknown } | undefined;
  assert.equal(frame?.optionId, 'model');
  assert.equal(frame?.value, 'm2');
});
