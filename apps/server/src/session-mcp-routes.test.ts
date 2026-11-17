import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addTeamMember, inMemoryAccounts, inMemoryDeps } from '@agent-hub/domain/testing';
import { asAgentId, createAccessPolicy, newWorkspace, type AgentDescriptor } from '@agent-hub/domain';
import { createApp } from './http.ts';
import { createStreamHub } from './stream-hub.ts';

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
const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) });
const patch = (body: unknown) => ({ method: 'PATCH', body: JSON.stringify(body) });

async function setup() {
  const accounts = inMemoryAccounts();
  const world = inMemoryDeps();
  world.agents.push(fake);
  const access = createAccessPolicy({ users: accounts.users, settings: accounts.settings, enrollment: { credentialFor: async () => null }, gateway: world.deps.gateway });
  const deps = { ...world.deps, access };
  const app = createApp({
    deps,
    hub: createStreamHub(),
    token: null,
    auth: { accounts },
    activity: { audit: accounts.audit!, users: accounts.users }
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
  const david = browser();
  assert.equal((await david('/api/auth/register', post({ email: 'david@b.co', password: PASSWORD }))).status, 200);
  // 只读角色：看得见团队项目，但没有 session.prompt，改不动这条会话。
  await addTeamMember(accounts, 'eve@b.co', PASSWORD);
  const eveUser = await accounts.users.byEmail('eve@b.co');
  await accounts.users.save({ ...eveUser!, role: 'viewer' });
  const eve = browser();
  assert.equal((await eve('/api/auth/login', post({ email: 'eve@b.co', password: PASSWORD }))).status, 200);

  const project = (await david('/api/projects', post({ name: 'p' }))).body;
  const task = (await david('/api/tasks', post({ projectId: project.id, title: 't', goal: '' }))).body;
  const workspace = newWorkspace({ projectId: project.id, workerId: null, path: '/tmp/x', kind: 'long_lived', source: 'linked', now: 1 });
  assert.ok(workspace.ok);
  await world.deps.workspaces.save(workspace.value);
  const session = await david('/api/sessions/derive', post({ taskId: task.id, agentId: 'fake', model: 'm1', workspaceId: workspace.value.id }));
  assert.equal(session.status, 201, JSON.stringify(session.body));
  return { accounts, david, eve, session: session.body };
}

test('PATCH /api/sessions/:id/mcp：按会话关 MCP，返回 DTO 并写审计；空数组 = 全部开启', async () => {
  const { accounts, david, session } = await setup();
  assert.deepEqual(session.mcpDisabled, []);

  const off = await david(`/api/sessions/${session.id}/mcp`, patch({ disabled: ['fs', 'browser', 'fs'] }));
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.deepEqual(off.body.mcpDisabled, ['fs', 'browser']);
  assert.deepEqual((await david(`/api/sessions/${session.id}`)).body.mcpDisabled, ['fs', 'browser']);
  assert.equal(accounts.auditRows[0]?.action, 'session.mcp');
  assert.match(accounts.auditRows[0]?.detail ?? '', /关掉：fs、browser/);

  const on = await david(`/api/sessions/${session.id}/mcp`, patch({ disabled: [] }));
  assert.equal(on.status, 200);
  assert.deepEqual(on.body.mcpDisabled, []);
  assert.match(accounts.auditRows[0]?.detail ?? '', /全部开启/);
});

test('PATCH /api/sessions/:id/mcp：非法名字 400，只读角色 403', async () => {
  const { david, eve, session } = await setup();
  const bad = await david(`/api/sessions/${session.id}/mcp`, patch({ disabled: ['FS'] }));
  assert.equal(bad.status, 400);
  assert.deepEqual((await david(`/api/sessions/${session.id}`)).body.mcpDisabled, []);

  const denied = await eve(`/api/sessions/${session.id}/mcp`, patch({ disabled: ['fs'] }));
  assert.equal(denied.status, 403);
  assert.deepEqual((await david(`/api/sessions/${session.id}`)).body.mcpDisabled, []);
});

test('GET /api/sessions/:id/mcp：没有资产/没落到机器上时给空清单与说明', async () => {
  const { david, eve, session } = await setup();
  const empty = await david(`/api/sessions/${session.id}/mcp`);
  assert.equal(empty.status, 200, JSON.stringify(empty.body));
  assert.deepEqual(empty.body.servers, []);
  assert.deepEqual(empty.body.disabled, []);
  assert.match(empty.body.note ?? '', /MCP/);

  await david(`/api/sessions/${session.id}/mcp`, patch({ disabled: ['fs'] }));
  const kept = await david(`/api/sessions/${session.id}/mcp`);
  assert.deepEqual(kept.body.disabled, ['fs']);

  const viewer = await eve(`/api/sessions/${session.id}/mcp`);
  assert.equal(viewer.status, 200);
  assert.deepEqual(viewer.body.disabled, ['fs']);
});
