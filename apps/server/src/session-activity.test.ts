import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addTeamMember, inMemoryAccounts, inMemoryDeps } from '@agent-hub/domain/testing';
import { ANONYMIZED_NAME, asAgentId, createAccessPolicy, newWorkspace, type AgentDescriptor } from '@agent-hub/domain';
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
    auth: { accounts, hubToken: null },
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
  await addTeamMember(accounts, 'm@b.co', PASSWORD);
  const memberUser = await accounts.users.byEmail('m@b.co');
  await accounts.settings.save({ ...(await accounts.settings.get()), localWorkerGrants: [memberUser!.id] });
  const member = browser();
  assert.equal((await member('/api/auth/login', post({ email: 'm@b.co', password: PASSWORD }))).status, 200);
  // 成员自己的项目；david 是团队 owner，也看得见、能在里面说话
  const project = (await member('/api/projects', post({ name: 'p' }))).body;
  const task = (await member('/api/tasks', post({ projectId: project.id, title: 't', goal: '' }))).body;
  const workspace = newWorkspace({ projectId: project.id, workerId: null, path: '/tmp/x', kind: 'long_lived', source: 'linked', now: 1 });
  assert.ok(workspace.ok);
  await world.deps.workspaces.save(workspace.value);
  const session = await david('/api/sessions/derive', post({ taskId: task.id, agentId: 'fake', model: 'm1', workspaceId: workspace.value.id }));
  assert.equal(session.status, 201, JSON.stringify(session.body));
  return { accounts, world, david, member, project, session: session.body };
}

test('每条 prompt 记下发送人；读出时按账号现在的名字，删除匿名化后显示匿名名', async () => {
  const { accounts, david, member, project, session } = await setup();
  assert.equal((await david(`/api/sessions/${session.id}/prompt`, post({ text: '你好' }))).status, 200);
  assert.equal((await member(`/api/sessions/${session.id}/prompt`, post({ text: '我也来' }))).status, 200);
  const prompts = (await david(`/api/sessions/${session.id}/events`)).body.filter((e: any) => e.event.kind === 'prompt');
  const davidUser = await accounts.users.byEmail('david@b.co');
  const memberUser = await accounts.users.byEmail('m@b.co');
  assert.deepEqual(prompts.map((e: any) => e.event.author.id), [davidUser!.id, memberUser!.id]);

  await accounts.users.save({ ...memberUser!, displayName: ANONYMIZED_NAME, deletedAt: 5 });
  const again = (await david(`/api/sessions/${session.id}/events`)).body.filter((e: any) => e.event.kind === 'prompt');
  assert.equal(again[1].event.author.name, ANONYMIZED_NAME);
  const canvas = (await david(`/api/projects/${project.id}/canvas`)).body;
  const preview = canvas.previews[session.id].filter((e: any) => e.event.kind === 'prompt');
  assert.equal(preview[1].event.author.name, ANONYMIZED_NAME);
});

test('开会话、分叉、停下都记审计（带团队），会话详情能看到是谁', async () => {
  const { accounts, david, member, session } = await setup();
  await member(`/api/sessions/${session.id}/prompt`, post({ text: 'hi' }));
  assert.equal((await member(`/api/sessions/${session.id}/interrupt`, post({}))).status, 200);
  const fork = await david('/api/sessions/fork', post({ sessionId: session.id, agentId: 'fake', model: 'm1' }));
  assert.equal(fork.status, 201, JSON.stringify(fork.body));

  const activity = (await david(`/api/sessions/${session.id}/activity`)).body;
  assert.deepEqual(activity.map((a: any) => a.action).sort(), ['session.fork', 'session.interrupt', 'session.start']);
  const memberUser = await accounts.users.byEmail('m@b.co');
  assert.equal(activity.find((a: any) => a.action === 'session.interrupt').actor.id, memberUser!.id);
  assert.ok(!('ip' in activity[0]), '详情里不给 IP');
  const forked = (await david(`/api/sessions/${fork.body.id}/activity`)).body;
  assert.equal(forked.length, 1);
  assert.match(forked[0].detail, new RegExp(session.id));

  const rows = accounts.auditRows.filter((r) => r.action.startsWith('session.'));
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => r.teamId === memberUser!.teamId && r.teamId !== null));

  await accounts.users.save({ ...memberUser!, displayName: ANONYMIZED_NAME, deletedAt: 5 });
  const after = (await david(`/api/sessions/${session.id}/activity`)).body;
  assert.equal(after.find((a: any) => a.action === 'session.interrupt').actor.name, ANONYMIZED_NAME);
});
