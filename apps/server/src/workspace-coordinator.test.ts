import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import {
  asAgentId,
  asLoginId,
  asProjectId,
  asSessionId,
  asTaskId,
  asTeamId,
  asUserId,
  createProjectUseCase,
  newWorkspace,
  type AccessPolicy,
  type AgentDescriptor,
  type Principal,
  type Role,
  type Subject
} from '@agent-hub/domain';
import { inMemoryAccounts, inMemoryDeps } from '@agent-hub/domain/testing';
import { createSqliteWorkspaceCoordinators } from '@agent-hub/storage-sqlite';
import { installCoordinatorRoutes, type CoordinatorDeps } from './workspace-coordinator.ts';
import { createApp } from './http.ts';
import { createStreamHub } from './stream-hub.ts';

const fake: AgentDescriptor = {
  id: asAgentId('fake'),
  label: 'Fake',
  capabilities: {
    prompt: { state: 'available' },
    interrupt: { state: 'available' },
    fork: { state: 'available' },
    resume: { state: 'available' },
    tool_calls: { state: 'available' },
    artifacts: { state: 'available' },
    structured_events: { state: 'available' },
    attachments: { state: 'available' }
  },
  models: ['m1'],
  defaultModel: 'm1',
  options: []
};

function person(role: Role, teamId: string, id: string): Principal {
  return {
    user: {
      id: asUserId(id),
      email: `${id}@example.com`,
      displayName: id,
      role,
      passwordHash: null,
      emailVerifiedAt: 1,
      disabledAt: null,
      createdAt: 1,
      teamId: asTeamId(teamId),
      clusterAdmin: false,
      deletedAt: null
    },
    loginId: asLoginId(id)
  };
}

/** 团队 t1 的授权策略；`local` 决定 worker 资源算不算 hub 本机。 */
function policy(input: { readonly local?: boolean; readonly teamId?: string } = {}): AccessPolicy {
  return {
    context: async () => ({ hubTeamId: 't1', settings: { membersCanAddMachines: false } }),
    worker: async (workerId) => ({
      kind: 'worker',
      id: workerId ?? 'local',
      teamId: input.teamId ?? 't1',
      local: input.local === true
    })
  };
}

interface WorldOptions {
  readonly workerId?: string | null;
  readonly access?: AccessPolicy;
  readonly createdBy?: Principal;
}

async function world(options: WorldOptions = {}) {
  const w = inMemoryDeps();
  w.agents.push(fake);
  const workerId = options.workerId ?? null;
  if (workerId) w.workers.push({ workerId, label: '远端', origin: 'remote', state: 'online' });
  const owner = options.createdBy ?? person('owner', 't1', 'u-owner');
  const created = await createProjectUseCase(w.deps, { name: 'hub', rootPath: '/tmp/hub', actor: owner, workerId });
  assert.ok(created.ok, JSON.stringify(created));
  const project = created.value;
  const [workspace] = await w.deps.workspaces.byProject(project.id);
  assert.ok(workspace, '建项目时应该已经落了一个长期工作空间');
  const deps: CoordinatorDeps = { ...w.deps, ...(options.access ? { access: options.access } : {}) };
  // 登记簿和生产一样落在 SQLite 里：单测不换成假实现，免得测不到真正的主键约束。
  const coordinators = createSqliteWorkspaceCoordinators(new DatabaseSync(':memory:'));
  let subject: Subject | null = owner;
  const app = new Hono();
  installCoordinatorRoutes(app, { deps, coordinators }, () => subject);
  const body = (extra: Record<string, unknown> = {}) => ({ projectId: project.id, workspaceId: workspace.id, agentId: 'fake', ...extra });
  const post = (payload: Record<string, unknown> = body()) =>
    app.request('/api/coordinators', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
  const get = (query: string) => app.request(`/api/coordinators?${query}`);
  return {
    ...w,
    deps,
    project,
    workspace,
    coordinators,
    owner,
    post,
    get,
    setSubject: (next: Subject | null) => {
      subject = next;
    }
  };
}

type Body = { error?: { code: string; message: string }; created?: boolean; coordinator?: { sessionId: string; projectId: string }; session?: Record<string, unknown>; coordinators?: unknown[] };

test('POST：没登录 403，令牌（含 bot）不能冒充人', async () => {
  const w = await world();
  w.setSubject(null);
  const anonymous = await w.post();
  assert.equal(anonymous.status, 403);
  assert.equal(((await anonymous.json()) as Body).error?.code, 'forbidden');

  w.setSubject({ ...w.owner, via: { tokenId: 'tk', name: 'service', kind: 'service', permissions: [] } });
  assert.equal((await w.post()).status, 403);

  w.setSubject({ ...w.owner, via: { tokenId: 'tk', name: 'bot', kind: 'bot', permissions: [], bot: { projectId: w.project.id, name: 'b' } } });
  assert.equal((await w.post()).status, 403);
});

test('POST：人开出来的会话无任务、来源项目定死、落在点名的工作空间', async () => {
  const w = await world();
  const response = await w.post();
  assert.equal(response.status, 201);
  const body = (await response.json()) as Required<Pick<Body, 'created' | 'coordinator' | 'session'>>;
  assert.equal(body.created, true);
  // 出站会话走 sessionSchema（和 /api/sessions 一致），身份相关的字段从登记与会话行上核对。
  assert.equal(body.session.taskId, null);
  assert.equal(body.session.workspaceId, w.workspace.id);
  assert.equal(body.session.workerId, 'local');
  assert.equal(body.coordinator.sessionId, body.session.id);
  assert.equal(body.coordinator.projectId, w.project.id);
  const stored = await w.deps.sessions.byId(asSessionId(body.session.id as string));
  assert.ok(stored);
  assert.equal(stored.originProjectId, w.project.id);
  assert.equal(stored.createdBy, w.owner.user.id);
  assert.deepEqual(
    (await w.deps.sessions.listByWorkspace(w.workspace.id)).map((session) => session.id),
    [body.session.id]
  );
});

test('POST：重复提交复用同一条会话，不重复起进程', async () => {
  const w = await world();
  const first = await w.post();
  assert.equal(first.status, 201);
  const started = ((await first.json()) as { session: { id: string } }).session.id;
  const second = await w.post();
  assert.equal(second.status, 200);
  const body = (await second.json()) as { created: boolean; session: { id: string } };
  assert.equal(body.created, false);
  assert.equal(body.session.id, started);
  assert.equal((await w.deps.sessions.listByWorkspace(w.workspace.id)).length, 1);
  assert.equal(w.dispatched.filter((command) => command.kind === 'start_session').length, 1);
});

test('POST：参数必须显式给，工作空间必须长期、已关联这个项目', async () => {
  const w = await world();
  assert.equal((await w.post({ projectId: w.project.id, agentId: 'fake' })).status, 400);
  assert.equal((await w.post({ projectId: w.project.id, workspaceId: w.workspace.id })).status, 400);
  assert.equal((await w.post({ projectId: w.project.id, workspaceId: 'nope', agentId: 'fake' })).status, 404);

  const unlinked = newWorkspace({ projectId: null, workerId: null, path: '/tmp/team-space', kind: 'long_lived', source: 'linked', now: 1 });
  assert.ok(unlinked.ok);
  await w.deps.workspaces.save(unlinked.value);
  assert.equal((await w.post({ projectId: w.project.id, workspaceId: unlinked.value.id, agentId: 'fake' })).status, 404);

  const temporary = newWorkspace({
    projectId: w.project.id,
    ownerTaskId: asTaskId('t1'),
    workerId: null,
    path: '/tmp/wt',
    kind: 'temporary',
    source: 'worktree',
    now: 1
  });
  assert.ok(temporary.ok);
  await w.deps.workspaces.save(temporary.value);
  const rejected = await w.post({ projectId: w.project.id, workspaceId: temporary.value.id, agentId: 'fake' });
  assert.equal(rejected.status, 400);
  assert.match(((await rejected.json()) as Body).error?.message ?? '', /长期工作空间/);
});

test('POST：要项目 session.create；看不见的项目一律 404', async () => {
  const w = await world({ workerId: 'remote-1', access: policy() });
  // viewer 看得见项目（team 范围），但没有 session.create。
  w.setSubject(person('viewer', 't1', 'u-viewer'));
  const denied = await w.post();
  assert.equal(denied.status, 403);
  assert.equal(((await denied.json()) as Body).error?.code, 'forbidden');

  w.setSubject(person('member', 't2', 'u-stranger'));
  assert.equal((await w.post()).status, 404);
});

test('POST：创建者本人能开；本机 Worker 只给集群管理员', async () => {
  const creator = person('member', 't1', 'u-creator');
  const remote = await world({ workerId: 'remote-1', access: policy(), createdBy: creator });
  remote.setSubject(creator);
  assert.equal((await remote.post()).status, 201);

  const local = await world({ access: policy({ local: true }), createdBy: creator });
  local.setSubject(creator);
  const denied = await local.post();
  assert.equal(denied.status, 403);
  assert.match(((await denied.json()) as Body).error?.message ?? '', /本机 Worker/);
});

test('POST：派生失败会释放占位，换对参数能重新开', async () => {
  const w = await world();
  const ghost = await w.post({ projectId: w.project.id, workspaceId: w.workspace.id, agentId: 'ghost' });
  assert.equal(ghost.status, 409);
  assert.equal(await w.coordinators.get(w.project.id, w.workspace.id), null);
  const retried = await w.post();
  assert.equal(retried.status, 201);
  assert.equal(((await retried.json()) as Body).created, true);
});

test('GET：按项目 + 工作空间读一条，按项目列全部；看不见的项目 404', async () => {
  const w = await world();
  const started = ((await (await w.post()).json()) as { session: { id: string } }).session.id;

  const one = await w.get(`projectId=${w.project.id}&workspaceId=${w.workspace.id}`);
  assert.equal(one.status, 200);
  assert.equal(((await one.json()) as { coordinator: { sessionId: string } }).coordinator.sessionId, started);

  const list = await w.get(`projectId=${w.project.id}`);
  assert.equal(list.status, 200);
  assert.deepEqual(((await list.json()) as { coordinators: { sessionId: string }[] }).coordinators.map((row) => row.sessionId), [started]);

  assert.equal((await w.get('projectId=missing')).status, 404);
  assert.equal((await w.get('projectId=')).status, 400);

  await w.deps.projects.save({ ...w.project, deletedAt: 5 });
  assert.equal((await w.get(`projectId=${w.project.id}`)).status, 404);
});

test('漂移：会话被 bot 认领后不再算主会话，重开报冲突而不是偷偷接管', async () => {
  const w = await world();
  const started = ((await (await w.post()).json()) as { session: { id: string } }).session.id;
  const session = await w.deps.sessions.byId(asSessionId(started));
  assert.ok(session);
  await w.deps.sessions.save({ ...session, botId: 'bot-1' });

  assert.equal((await w.get(`projectId=${w.project.id}&workspaceId=${w.workspace.id}`)).status, 404);
  assert.deepEqual(((await (await w.get(`projectId=${w.project.id}`)).json()) as { coordinators: unknown[] }).coordinators, []);

  const again = await w.post();
  assert.equal(again.status, 409);
  assert.match(((await again.json()) as Body).error?.message ?? '', /对不上/);
  // 登记还在，原来那条会话也没有被换掉。
  assert.equal((await w.coordinators.get(w.project.id, w.workspace.id))?.sessionId, started);
  assert.equal((await w.deps.sessions.listByWorkspace(w.workspace.id)).length, 1);
});

test('占位丢失会话（崩溃在半路）也不按时间自动接管，只报冲突', async () => {
  const w = await world();
  await w.coordinators.reserve({ projectId: w.project.id, workspaceId: w.workspace.id, sessionId: 'missing', createdAt: 1 });
  const denied = await w.post();
  assert.equal(denied.status, 409);
  assert.match(((await denied.json()) as Body).error?.message ?? '', /会话不在了/);
  assert.equal((await w.coordinators.get(w.project.id, w.workspace.id))?.sessionId, 'missing');
  assert.deepEqual(await w.deps.sessions.listByWorkspace(w.workspace.id), []);
});

test('登记簿：并发占位只中一次', async () => {
  const registry = createSqliteWorkspaceCoordinators(new DatabaseSync(':memory:'));
  const record = { projectId: 'p', workspaceId: 'w', sessionId: 's', createdAt: 1 };
  const [first, second] = await Promise.all([registry.reserve(record), registry.reserve({ ...record, sessionId: 's2' })]);
  assert.deepEqual([first.status, second.status].sort(), ['exists', 'reserved']);
  assert.equal((await registry.get('p', 'w'))?.sessionId, 's');
});

test('真实装配：登录 cookie 走 /api/coordinators，首页只带出复核过的主会话', async () => {
  let clock = 1_000_000;
  const accounts = inMemoryAccounts(() => clock);
  const w = inMemoryDeps({ now: () => clock });
  w.agents.push(fake);
  const coordinators = createSqliteWorkspaceCoordinators(new DatabaseSync(':memory:'));
  const app = createApp({ deps: w.deps, hub: createStreamHub(), token: null, auth: { accounts }, coordinators: { coordinators } });

  const jar = new Map<string, string>();
  const call = async (path: string, init: RequestInit & { csrf?: boolean } = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(init.headers as Record<string, string>) };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (init.csrf && jar.get('hub_csrf')) headers['x-hub-csrf'] = jar.get('hub_csrf')!;
    const response = await app.fetch(new Request(`http://hub${path}`, { ...init, headers }));
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const [name, value] = pair!.split('=');
      if (value === '' || /Max-Age=0/.test(line)) jar.delete(name!);
      else jar.set(name!, value!);
    }
    return { status: response.status, body: (await response.json().catch(() => null)) as any };
  };

  assert.equal((await call('/api/auth/register', { method: 'POST', body: JSON.stringify({ email: 'a@b.co', password: 'long enough pw' }) })).status, 200);
  const created = await call('/api/projects', { method: 'POST', csrf: true, body: JSON.stringify({ name: 'demo', rootPath: '/tmp/demo' }) });
  assert.equal(created.status, 201);
  const projectId = created.body.id as string;
  const [workspace] = await w.deps.workspaces.byProject(asProjectId(projectId));
  assert.ok(workspace);

  const started = await call('/api/coordinators', {
    method: 'POST',
    csrf: true,
    body: JSON.stringify({ projectId, workspaceId: workspace.id, agentId: 'fake' })
  });
  assert.equal(started.status, 201);
  assert.equal(started.body.session.taskId, null);
  const sessionId = started.body.session.id as string;

  // 首页的 recentSessions 现在能带出无任务主会话（taskId null），普通无任务会话不会。
  const home = await call('/api/home');
  assert.equal(home.status, 200);
  const mine = home.body.recentSessions.filter((row: { sessionId: string }) => row.sessionId === sessionId);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].taskId, null);

  const canvas = await call(`/api/projects/${projectId}/canvas`);
  assert.equal(canvas.status, 200);
  const coordinatorOnCanvas = canvas.body.sessions.filter((row: { id: string }) => row.id === sessionId);
  assert.equal(coordinatorOnCanvas.length, 1);
  assert.equal(coordinatorOnCanvas[0].taskId, null);

  // 没有 CSRF 头的写请求进不来，令牌 / 匿名也进不来。
  assert.equal((await call('/api/coordinators', { method: 'POST', body: JSON.stringify({ projectId, workspaceId: workspace.id, agentId: 'fake' }) })).status, 403);

  const second = await call('/api/coordinators', {
    method: 'GET'
  });
  assert.equal(second.status, 400);
  const listed = await call(`/api/coordinators?projectId=${projectId}`);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.coordinators.map((row: { sessionId: string }) => row.sessionId), [sessionId]);
});
