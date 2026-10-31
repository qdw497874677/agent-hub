import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { addTeamMember, inMemoryAccounts, inMemoryApiTokens, inMemoryDeps } from '@agent-hub/domain/testing';
import { asAgentId, createAccessPolicy, newWorkspace, type AgentDescriptor } from '@agent-hub/domain';
import { journalEntrySchema, projectSchema, sessionSchema, taskSchema } from '@agent-hub/contract';
import { createApp } from './http.ts';
import { createStreamHub } from './stream-hub.ts';
import { buildSpecApp, openApiInfo } from './openapi/app.ts';
import { mcpTools } from './openapi/mcp.ts';

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

function harness(rate?: { general?: number; prompt?: number; streams?: number }) {
  const accounts = inMemoryAccounts(() => Date.now());
  const world = inMemoryDeps();
  world.agents.push(fake);
  const access = createAccessPolicy({ users: accounts.users, settings: accounts.settings, enrollment: { credentialFor: async () => null }, gateway: world.deps.gateway });
  const deps = { ...world.deps, access };
  const apiTokens = inMemoryApiTokens();
  const tokenDeps = { apiTokens, users: accounts.users, tokens: accounts.tokens, audit: accounts.audit, now: () => Date.now() };
  const hub = createStreamHub();
  const app = createApp({
    deps,
    hub,
    token: null,
    auth: { accounts, hubToken: null },
    activity: { audit: accounts.audit!, users: accounts.users },
    openApi: { tokens: tokenDeps, manage: tokenDeps, rate }
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
  return { accounts, world, app, hub, apiTokens, browser, api };
}
const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) });

async function setup(rate?: Parameters<typeof harness>[0]) {
  const h = harness(rate);
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
  const events = (await call(`/sessions/${session.body.id}/events`)).body;
  const prompt = events.map((e: unknown) => journalEntrySchema.parse(e)).find((e: { event: { kind: string } }) => e.event.kind === 'prompt');
  assert.equal(prompt.event.author.via, 'bot');
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
  assert.ok(names.includes('list_projects') && names.includes('prompt') && names.includes('create_task'));
  const called = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_projects', arguments: {} } });
  assert.equal(called.body.result.isError, false, JSON.stringify(called.body));
  const denied = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'create_project', arguments: { name: 'x' } } });
  assert.equal(denied.body.result.isError, true);
  assert.match(denied.body.result.content[0].text, /403/);
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
  assert.ok(mcpTools().length >= 24);
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
