import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addTeamMember, inMemoryAccounts, inMemoryDeps, mailedToken } from '@agent-hub/domain/testing';
import { asAgentId, asProjectId, asWorkspaceGroupId, createAccessPolicy, deriveSession, newWorkspace, type AgentDescriptor, type WorkspaceGroupId, type WorkspaceId } from '@agent-hub/domain';
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
  const app = createApp({ deps, hub: createStreamHub(), token: null, auth: { accounts } });
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

test('会话改名：能写这条会话的人才能改；别的团队 / 不相干成员改不了；名字随会话列表下发', async () => {
  const { david, stranger, member, world } = await setup();
  const project = (await david('/api/projects', post({ name: 'p' }))).body;
  const task = (await david('/api/tasks', post({ projectId: project.id, title: '任务', goal: '' }))).body;
  const made = deriveSession({ task: { ...task, createdAt: task.createdAt }, agentId: asAgentId('fake'), model: 'm1', now: 1 });
  assert.ok(made.ok);
  await world.deps.sessions.save(made.value);
  const put = (title: string) => ({ method: 'PUT', body: JSON.stringify({ title }) });
  const path = `/api/sessions/${made.value.id}/title`;
  const ok = await david(path, put('  查登录 bug '));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.title, '查登录 bug');
  assert.ok([403, 404].includes((await stranger(path, put('x'))).status));
  assert.ok([403, 404].includes((await member(path, put('x'))).status));
  assert.equal((await david(path, put('x'.repeat(81)))).status, 400);
  const canvas = (await david(`/api/projects/${project.id}/canvas`)).body;
  assert.equal(canvas.sessions.find((s: { id: string }) => s.id === made.value.id)?.title, '查登录 bug');
});

test('分叉：共享项目里的成员不能分叉别人的会话（按会话创建者判，而不是按项目）', async () => {
  const { david, member, accounts, world } = await setup();
  const project = (await david('/api/projects', post({ name: 'p' }))).body;
  const task = (await david('/api/tasks', post({ projectId: project.id, title: '任务', goal: '' }))).body;
  const made = deriveSession({ task: { ...task, createdAt: task.createdAt }, agentId: asAgentId('fake'), model: 'm1', now: 1, createdBy: 'david' });
  assert.ok(made.ok);
  await world.deps.sessions.save({ ...made.value, status: 'stopped', lastSeq: 1 });
  // 项目共享给成员：他看得见会话，但不是创建者。
  const user = await accounts.users.byEmail('m@b.co');
  const stored = await world.deps.projects.byId(project.id);
  await world.deps.projects.save({ ...stored!, members: [user!.id] });

  const fork = post({ sessionId: made.value.id, agentId: 'fake', model: 'm1' });
  const denied = await member('/api/sessions/fork', fork);
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.match(denied.body.error.message, /创建者/, JSON.stringify(denied.body));
  // 创建者照常分叉。
  const allowed = await david('/api/sessions/fork', fork);
  assert.equal(allowed.status, 201, JSON.stringify(allowed.body));
});

test('#243 容器会话来源项目：组合组与临时空间可读；丢失的组 / 长期空间失败关闭', async () => {
  const { david, world } = await setup();
  const project = (await david('/api/projects', post({ name: 'p' }))).body;
  const task = (await david('/api/tasks', post({ projectId: project.id, title: '任务', goal: '' }))).body;

  const groupId = asWorkspaceGroupId('grp_243');
  await world.deps.workspaceGroups.save({
    id: groupId,
    projectId: asProjectId(project.id),
    workerId: null,
    root: '/tmp/grp-243',
    members: [],
    state: 'ready',
    ownerTaskId: null,
    createdAt: 1,
    error: null
  });

  const longLived = newWorkspace({ projectId: project.id, workerId: null, path: '/tmp/long-243', kind: 'long_lived', source: 'linked', now: 1 });
  assert.ok(longLived.ok);
  await world.deps.workspaces.save(longLived.value);
  const temporary = newWorkspace({
    projectId: project.id,
    workerId: null,
    path: '/tmp/temp-243',
    kind: 'temporary',
    source: 'worktree',
    ownerTaskId: task.id,
    now: 1
  });
  assert.ok(temporary.ok);
  await world.deps.workspaces.save(temporary.value);

  const saveContainer = async (input: {
    groupId?: WorkspaceGroupId | null;
    workspaceId?: WorkspaceId | null;
    originProjectId?: ReturnType<typeof asProjectId> | null;
  }) => {
    const made = deriveSession({
      task: null,
      agentId: asAgentId('fake'),
      model: 'm1',
      now: 1,
      createdBy: 'david',
      groupId: input.groupId ?? null,
      workspaceId: input.workspaceId ?? null,
      originProjectId: input.originProjectId ?? null
    });
    assert.ok(made.ok);
    await world.deps.sessions.save(made.value);
    return made.value;
  };

  // 组合组：建组时的 projectId 是固定来源。
  const grouped = await saveContainer({ groupId });
  assert.equal((await david(`/api/sessions/${grouped.id}`)).status, 200);

  // 临时工作空间：projectId 在出生时定死，可以当来源。
  const temporarySession = await saveContainer({ workspaceId: temporary.value.id });
  assert.equal((await david(`/api/sessions/${temporarySession.id}`)).status, 200);

  // 组丢了：即使同项目的临时工作空间还在，也不能退回它；守门中间件直接失败关闭。
  const lostGroup = await saveContainer({ groupId: asWorkspaceGroupId('grp_missing'), workspaceId: temporary.value.id });
  const deniedLostGroup = await david(`/api/sessions/${lostGroup.id}`);
  assert.equal(deniedLostGroup.status, 404, JSON.stringify(deniedLostGroup.body));

  // 新数据：派生时把已验证项目写死，长期工作空间也能作为来源，不受工作空间后续归属变化影响。
  const withOrigin = await saveContainer({ workspaceId: longLived.value.id, originProjectId: asProjectId(project.id) });
  assert.equal((await david(`/api/sessions/${withOrigin.id}`)).status, 200);

  // 来源项目后来没了：失败关闭，不退回长期工作空间。
  const danglingOrigin = await saveContainer({
    workspaceId: longLived.value.id,
    originProjectId: asProjectId('prj_missing_243')
  });
  assert.equal((await david(`/api/sessions/${danglingOrigin.id}`)).status, 404);

  // 只有长期工作空间：它的 projectId 只是记录（关联还能改），不算来源。
  const longLivedOnly = await saveContainer({ workspaceId: longLived.value.id });
  const deniedLongLived = await david(`/api/sessions/${longLivedOnly.id}`);
  assert.equal(deniedLongLived.status, 404, JSON.stringify(deniedLongLived.body));

  // 真正不存在的会话仍然由路由报 404。
  assert.equal((await david('/api/sessions/sess_missing')).status, 404);
});
