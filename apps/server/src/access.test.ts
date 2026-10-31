import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addTeamMember, inMemoryAccounts, inMemoryDeps, mailedToken } from '@agent-hub/domain/testing';
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

/** 一个 hub：David 是 hub 管理员；可以开放注册造出别的团队。授权走真的 createAccessPolicy。 */
function harness() {
  const accounts = inMemoryAccounts();
  const world = inMemoryDeps();
  world.agents.push(fake);
  const access = createAccessPolicy({
    users: accounts.users,
    settings: accounts.settings,
    enrollment: { credentialFor: async () => null },
    gateway: world.deps.gateway
  });
  const deps = { ...world.deps, access };
  const app = createApp({ deps, hub: createStreamHub(), token: null, auth: { accounts, hubToken: null } });
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
  return { accounts, world, browser };
}
const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) });

async function setup() {
  const h = harness();
  const david = h.browser();
  assert.equal((await david('/api/auth/register', post({ email: 'david@b.co', password: PASSWORD }))).status, 200);
  // 自助注册的人：自己一个团队
  await h.accounts.settings.save({ ...(await h.accounts.settings.get()), openRegistration: true });
  const stranger = h.browser();
  assert.equal((await stranger('/api/auth/register', post({ email: 's@b.co', password: PASSWORD }))).status, 202);
  await stranger('/api/auth/verify-email', post({ token: mailedToken(h.accounts, 's@b.co') }));
  assert.equal((await stranger('/api/auth/login', post({ email: 's@b.co', password: PASSWORD }))).status, 200);
  // hub 团队的普通成员
  await addTeamMember(h.accounts, 'm@b.co', PASSWORD);
  const member = h.browser();
  assert.equal((await member('/api/auth/login', post({ email: 'm@b.co', password: PASSWORD }))).status, 200);
  return { ...h, david, stranger, member };
}

test('团队隔离：别的团队的项目看不见、打不开、不能在里面建任务', async () => {
  const { david, stranger } = await setup();
  const project = (await david('/api/projects', post({ name: 'secret' }))).body;
  assert.ok(project.id);
  assert.deepEqual((await stranger('/api/projects')).body, []);
  assert.equal((await stranger(`/api/projects/${project.id}`)).status, 404);
  assert.equal((await stranger('/api/tasks', post({ projectId: project.id, title: 'x', goal: '' }))).status, 404);
  assert.equal((await stranger(`/api/search?projectId=${project.id}&q=x`)).status, 404);
  assert.equal((await stranger('/api/home')).body.projects.length, 0);
  assert.equal((await david('/api/home')).body.projects.length, 1);
});

test('成员只看自己建的；团队 owner 看全部', async () => {
  const { david, member } = await setup();
  const mine = (await member('/api/projects', post({ name: 'mine' }))).body;
  const his = (await david('/api/projects', post({ name: 'his' }))).body;
  assert.deepEqual((await member('/api/projects')).body.map((p: { id: string }) => p.id), [mine.id]);
  assert.equal((await member(`/api/projects/${his.id}`)).status, 404);
  assert.deepEqual((await david('/api/projects')).body.map((p: { id: string }) => p.id).sort(), [mine.id, his.id].sort());
});

test('self-registered team owner cannot start session on hub-local worker（HTTP + 派发前）', async () => {
  const { stranger, world } = await setup();
  // 本机不出现在他的机器列表里，也不能浏览本机目录、不能把项目建在本机目录上
  assert.deepEqual((await stranger('/api/workers')).body, []);
  assert.equal((await stranger('/api/fs/directories?path=/')).status, 403);
  assert.equal((await stranger('/api/projects', post({ name: 'p', rootPath: '/etc' }))).status, 403);
  // 建一个不带目录的项目、一个任务，然后点名本机开会话：派发前拒绝
  const project = (await stranger('/api/projects', post({ name: 'p' }))).body;
  const task = (await stranger('/api/tasks', post({ projectId: project.id, title: 't', goal: '' }))).body;
  assert.ok(task.id, JSON.stringify(task));
  // 就算数据里有一个落在本机的工作空间（比如老数据 / 被人塞进来），派发前也拦住
  const workspace = newWorkspace({ projectId: project.id, workerId: null, path: '/tmp/x', kind: 'long_lived', source: 'linked', now: 1 });
  assert.ok(workspace.ok);
  await world.deps.workspaces.save(workspace.value);
  const derived = await stranger('/api/sessions/derive', post({ taskId: task.id, agentId: 'fake', model: 'm1', workspaceId: workspace.value.id }));
  assert.equal(derived.status, 403, JSON.stringify(derived.body));
  assert.equal(world.dispatched.length, 0);
});

test('hub 团队成员不能用本机（localWorkerGrants 已收回）；只有升为集群管理员才可以', async () => {
  const { member, accounts, world } = await setup();
  assert.equal((await member('/api/fs/directories?path=/')).status, 403);
  const user = await accounts.users.byEmail('m@b.co');
  // 老设置里的名单不再生效
  await accounts.settings.save({ ...(await accounts.settings.get()), localWorkerGrants: [user!.id] } as never);
  assert.equal((await member('/api/fs/directories?path=/')).status, 403);
  await accounts.users.save({ ...user!, clusterAdmin: true });
  assert.equal((await member('/api/fs/directories?path=/')).status, 200);
  assert.equal((await member('/api/workers')).body.length, world.workers.length);
});
