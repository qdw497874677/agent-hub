/**
 * 开放 API / MCP 管理模型提供商：权限范围、确认闸门、密钥不外泄、审计留痕。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { addTeamMember, inMemoryAccounts, inMemoryApiTokens, inMemoryDeps } from '@agent-hub/domain/testing';
import { createAccessPolicy, type AuditEntry } from '@agent-hub/domain';
import { createSqliteProviders } from '@agent-hub/storage-sqlite';
import { createApp } from './http.ts';
import { createStreamHub } from './stream-hub.ts';
import { createRepoAuth } from './repo-auth.ts';
import { createProviderWiring } from './providers.ts';

const PASSWORD = 'long enough pw';
const SECRET = 'sk-test-secret-DO-NOT-LEAK-9f3a7c';

const leak = (text: string): boolean => text.includes(SECRET);

type Call = (path: string, init?: RequestInit) => Promise<{ status: number; text: string; body: any }>;

function harness() {
  const accounts = inMemoryAccounts(() => Date.now());
  const world = inMemoryDeps();
  const access = createAccessPolicy({
    users: accounts.users,
    settings: accounts.settings,
    enrollment: { credentialFor: async () => null },
    gateway: world.deps.gateway
  });
  const deps = {
    ...world.deps,
    access,
    repoAuth: createRepoAuth({ projects: world.deps.projects, workspaces: world.deps.workspaces, secrets: world.deps.secrets })
  };
  const apiTokens = inMemoryApiTokens();
  const auditRows: AuditEntry[] = [];
  const audit = {
    append: async (entry: AuditEntry) => {
      auditRows.push(entry);
      await accounts.audit!.append(entry);
    },
    recent: (accounts.audit!.recent as Function).bind(accounts.audit!),
    query: (accounts.audit!.query as Function).bind(accounts.audit!)
  };
  const tokenDeps = { apiTokens, users: accounts.users, projects: world.deps.projects, tokens: accounts.tokens, audit, now: () => Date.now() };
  const providers = createSqliteProviders(new DatabaseSync(':memory:'), randomBytes(32));
  const wiring = createProviderWiring({
    deps: { providers, audit, now: () => Date.now() },
    projectTeam: async () => null,
    userTeam: async () => null,
    hostOf: () => 'worker-1',
    testFromWorker: async () => ({ ok: true, value: { ok: true, status: 200, message: '通了：1 个模型', models: ['glm-5.3-flash'] } }),
    log: () => undefined
  });
  const hub = createStreamHub();
  const app = createApp({
    deps,
    hub,
    token: null,
    auth: { accounts },
    activity: { audit, users: accounts.users },
    providers: wiring,
    openApi: { tokens: tokenDeps, manage: tokenDeps, settings: accounts.settings, audit }
  });
  const session = (): Call => {
    const jar = new Map<string, string>();
    return async (path, init = {}) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      if (jar.get('hub_csrf')) headers['x-hub-csrf'] = jar.get('hub_csrf')!;
      const response = await app.fetch(new Request(`http://hub${path}`, { ...init, headers }));
      for (const line of response.headers.getSetCookie()) {
        const [name, value] = line.split(';')[0]!.split('=');
        if (value === '' || /Max-Age=0/.test(line)) jar.delete(name!);
        else jar.set(name!, value!);
      }
      const text = await response.text();
      assert.equal(leak(text), false, '响应里出现了密钥');
      let body: any = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      return { status: response.status, text, body };
    };
  };
  const api = (token: string): Call => async (path, init = {}) => {
    const response = await app.fetch(
      new Request(`http://hub/openapi/v1${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(init.headers ?? {}) }
      }),
      { mcpPolicy: { writes: true } }
    );
    const text = await response.text();
    assert.equal(leak(text), false, `开放 API 响应里出现了密钥：${path}`);
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: response.status, text, body };
  };
  return { accounts, app, auditRows, session, api };
}

const post = (body: unknown) => ({ method: 'POST' as const, body: JSON.stringify(body) });
const del = (body: unknown) => ({ method: 'DELETE' as const, body: JSON.stringify(body) });

const providerBody = {
  slug: 'cn-glm-flash',
  name: '智谱 Coding',
  protocol: 'openai-chat',
  baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
  models: [{ id: 'glm-5.3-flash' }],
  routing: 'hub' as const,
  scope: 'hub' as const,
  enabled: true,
  apiKey: SECRET
};

async function setup() {
  const h = harness();
  const david = h.session();
  assert.equal((await david('/api/auth/register', post({ email: 'david@b.co', password: PASSWORD }))).status, 200);
  const mint = async (who: Call, scopes: string[], extra: Record<string, unknown> = {}) => who('/api/tokens', post({ name: 'tok', scopes, ...extra }));
  return { ...h, david, mint };
}

test('授予：管理员能开 providers:manage；成员不能；项目级令牌和缺 scope 都被拒', async () => {
  const { david, mint, accounts, api, session } = await setup();
  const granted = await mint(david, ['providers:manage', 'providers:read']);
  assert.equal(granted.status, 201, JSON.stringify(granted.body));

  await addTeamMember(accounts, 'm@b.co', PASSWORD);
  const member = session();
  assert.equal((await member('/api/auth/login', post({ email: 'm@b.co', password: PASSWORD }))).status, 200);
  const asMember = await mint(member, ['providers:manage']);
  assert.equal(asMember.status, 403);
  assert.match(asMember.text, /只有管理员/);

  const project = (await david('/api/projects', post({ name: 'demo' }))).body as { id: string };
  const scoped = await mint(david, ['providers:manage'], { projectIds: [project.id] });
  assert.equal(scoped.status, 403);
  assert.match(scoped.text, /只限项目/);

  const useOnly = await mint(david, ['providers:use']);
  assert.equal(useOnly.status, 201);
  const created = await api(useOnly.body.token)('/providers', post(providerBody));
  assert.equal(created.status, 403);
  assert.match(created.text, /providers:manage/);
});

test('管理令牌：新建、列表、探测、测试、无确认只预览、确认后删除；密钥不进响应和审计', async () => {
  const { david, mint, api, auditRows } = await setup();
  const minted = await mint(david, ['providers:manage']);
  assert.equal(minted.status, 201);
  const call = api(minted.body.token);

  const created = await call('/providers', post(providerBody));
  assert.equal(created.status, 201, created.text);
  assert.equal(created.body.hasKey, true);
  assert.equal(created.body.apiKey, undefined);
  assert.equal(created.body.slug, 'cn-glm-flash');
  const id = created.body.id as string;

  const listed = await call('/providers');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.providers.length, 1);
  assert.equal(listed.body.providers[0].hasKey, true);
  assert.equal(listed.body.providers[0].apiKey, undefined);
  assert.ok(listed.body.providers[0].models.some((m: { id: string }) => m.id === 'glm-5.3-flash'));
  assert.equal(typeof listed.body.workerRouting, 'object');

  const probed = await call('/providers/probe', post({ providerId: id, workerId: 'worker-1' }));
  assert.equal(probed.status, 200, probed.text);
  assert.equal(probed.body.ok, true);

  const tested = await call(`/providers/${id}/test`, post({ workerId: 'worker-1' }));
  assert.equal(tested.status, 200, tested.text);
  assert.equal(tested.body.ok, true);
  assert.ok(Array.isArray(tested.body.models));

  const preview = await call(`/providers/${id}`, del({}));
  assert.equal(preview.status, 200, preview.text);
  assert.equal(preview.body.confirmRequired, true);
  assert.ok(preview.body.models.includes('hub-cn-glm-flash/glm-5.3-flash'));
  assert.equal((await call('/providers')).body.providers.length, 1, '没确认不应删除');

  const removed = await call(`/providers/${id}`, del({ confirm: true }));
  assert.equal(removed.status, 200, removed.text);
  assert.equal(removed.body.confirmed, true);
  assert.equal((await call('/providers')).body.providers.length, 0);

  const dumped = JSON.stringify(auditRows);
  assert.equal(leak(dumped), false, '审计里出现了密钥');
  assert.ok(auditRows.some((row) => row.action === 'provider.create' && String(row.detail).includes('经令牌')));
  assert.ok(auditRows.some((row) => row.action === 'provider.delete' && String(row.detail).includes('经令牌')));
  assert.ok(auditRows.some((row) => row.action === 'provider.test'));
});

test('MCP：管理令牌能看到并调用 provider 工具；只读令牌只能 list；注解正确；路由要确认', async () => {
  const { david, mint, api, auditRows } = await setup();
  const manage = (await mint(david, ['providers:manage'])).body.token as string;
  const read = (await mint(david, ['providers:read'])).body.token as string;
  const rpc = (token: string) => async (body: unknown) => {
    const result = await api(token)('/mcp', post(body));
    assert.equal(result.status, 200, result.text);
    return result.body;
  };

  const manageList = await rpc(manage)({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const manageNames = (manageList.result.tools as { name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean } }[]).map((t) => t.name);
  for (const name of ['provider_list', 'provider_create', 'provider_update', 'provider_set_key', 'provider_probe', 'provider_test', 'provider_delete', 'provider_routing_set']) {
    assert.ok(manageNames.includes(name), `缺 ${name}`);
  }
  const tools = manageList.result.tools as { name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean } }[];
  const listTool = tools.find((t) => t.name === 'provider_list')!;
  assert.equal(listTool.annotations.readOnlyHint, true);
  assert.equal(listTool.annotations.destructiveHint, false);
  const deleteTool = tools.find((t) => t.name === 'provider_delete')!;
  assert.equal(deleteTool.annotations.readOnlyHint, false);
  assert.equal(deleteTool.annotations.destructiveHint, true);
  const createTool = tools.find((t) => t.name === 'provider_create')!;
  assert.equal(createTool.annotations.destructiveHint, false);
  const routingTool = tools.find((t) => t.name === 'provider_routing_set')!;
  assert.equal(routingTool.annotations.destructiveHint, true);

  const readList = await rpc(read)({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const readNames = (readList.result.tools as { name: string }[]).map((t) => t.name);
  assert.ok(readNames.includes('provider_list'));
  assert.ok(!readNames.includes('provider_create'));
  assert.ok(!readNames.includes('provider_delete'));

  const created = await rpc(manage)({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'provider_create', arguments: { ...providerBody, clientRequestId: 'p-create-1' } }
  });
  assert.equal(created.result.isError, false, JSON.stringify(created));
  const provider = created.result.structuredContent as { id: string; apiKey?: unknown };
  assert.ok(provider.id);
  assert.equal(provider.apiKey, undefined);

  const routingPreview = await rpc(manage)({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'provider_routing_set', arguments: { workerId: 'worker-1', routing: 'hub', clientRequestId: 'p-route-1' } }
  });
  assert.equal(routingPreview.result.isError, false, JSON.stringify(routingPreview));
  assert.equal(routingPreview.result.structuredContent.confirmRequired, true);

  const routing = await rpc(manage)({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'provider_routing_set', arguments: { workerId: 'worker-1', routing: 'hub', confirm: true, clientRequestId: 'p-route-2' } }
  });
  assert.equal(routing.result.isError, false, JSON.stringify(routing));
  assert.equal(routing.result.structuredContent.confirmed, true);

  const denied = await rpc(read)({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'provider_create', arguments: { ...providerBody, slug: 'other', clientRequestId: 'p-create-denied' } }
  });
  assert.equal(denied.result.isError, true);
  assert.match(denied.result.content[0].text, /403.*providers:manage/);

  const dumped = JSON.stringify(auditRows);
  assert.equal(leak(dumped), false, '审计里出现了密钥');
  assert.ok(auditRows.some((row) => row.action === 'provider.routing' && String(row.detail).includes('经令牌')));
});
