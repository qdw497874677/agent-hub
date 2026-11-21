import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteAttention } from '@agent-hub/storage-sqlite';
import { asAgentId, asProjectId, asTaskId, createAccessPolicy, deriveSession, type AgentDescriptor } from '@agent-hub/domain';
import { inMemoryAccounts, inMemoryDeps } from '@agent-hub/domain/testing';
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
  const store = createSqliteAttention(new DatabaseSync(':memory:'));
  const app = createApp({ deps, hub: createStreamHub(), token: null, auth: { accounts }, attention: { store } });
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
  return { accounts, world, store, browser };
}

async function setup() {
  const h = harness();
  const david = h.browser();
  assert.equal((await david('/api/auth/register', post({ email: 'd@b.co', password: PASSWORD }))).status, 200);
  const user = await h.accounts.users.byEmail('d@b.co');
  assert.ok(user);

  const project = (await david('/api/projects', post({ name: 'p' }))).body;
  const task = (await david('/api/tasks', post({ projectId: project.id, title: 't', goal: '' }))).body;
  // 会话直接落库：attention 只读会话尾部事件，不需要真的跑 agent。
  const made = deriveSession({ task, agentId: asAgentId('fake'), model: 'm1', now: Date.now(), createdBy: user.id });
  assert.ok(made.ok);
  await h.world.deps.sessions.save({ ...made.value, status: 'failed' });
  return { ...h, david, user, project, task, session: made.value };
}

test('attention/ack：请求体要 sessionId / 人类阶段 / 安全整数 since / 可选布尔 acked', async () => {
  const { david, session } = await setup();
  const ok = { sessionId: session.id, phase: 'failed', since: 1 };
  assert.equal((await david('/api/attention/ack', post({ phase: 'failed', since: 1 }))).status, 400);
  assert.equal((await david('/api/attention/ack', post({ ...ok, phase: 'idle' }))).status, 400, '非人类阶段');
  assert.equal((await david('/api/attention/ack', post({ ...ok, since: 1.5 }))).status, 400, '不是整数');
  assert.equal((await david('/api/attention/ack', post({ ...ok, since: Number.MAX_SAFE_INTEGER + 1 }))).status, 400, '不是安全整数');
  assert.equal((await david('/api/attention/ack', post({ ...ok, since: -1 }))).status, 400, '负数时刻');
  assert.equal((await david('/api/attention/ack', post({ ...ok, sessionId: 'x'.repeat(129) }))).status, 400, '超长 id');
  assert.equal((await david('/api/attention/ack', post({ ...ok, acked: 'nope' }))).status, 400);
  assert.equal((await david('/api/attention/ack', post({ ...ok, ackedAt: 1.5 }))).status, 400);
});

test('attention/ack：老前端（不带 acked）记下；撤销后重新上榜；重复撤销幂等', async () => {
  const { david, session, store, user } = await setup();
  const listed = (await david('/api/attention')).body as { items: { sessionId: string; phase: string; since: number }[] };
  const item = listed.items.find((i) => i.sessionId === session.id);
  assert.ok(item, '失败会话应先出现在待办里');
  const payload = { sessionId: session.id, phase: item.phase, since: item.since };

  // 老标签页只发三件套 = acked 默认 true，还拿到收据
  const acked = await david('/api/attention/ack', post(payload));
  assert.equal(acked.status, 200);
  assert.equal(typeof acked.body.ackedAt, 'number');
  assert.equal((await david('/api/attention')).body.items.some((i: { sessionId: string }) => i.sessionId === session.id), false);
  assert.equal((await store.acks(user.id)).length, 1);

  const undo = await david('/api/attention/ack', post({ ...payload, acked: false, ackedAt: acked.body.ackedAt }));
  assert.equal(undo.status, 200);
  assert.deepEqual(undo.body, { ok: true, undone: true });
  assert.equal((await david('/api/attention')).body.items.some((i: { sessionId: string }) => i.sessionId === session.id), true);

  // 重复撤销：仍然 200，不报错，也不影响别的
  assert.equal((await david('/api/attention/ack', post({ ...payload, acked: false }))).status, 200);
  assert.equal((await david('/api/attention')).body.items.some((i: { sessionId: string }) => i.sessionId === session.id), true);
});

test('attention/ack：迟到的收据删不掉后来的重看', async () => {
  const { david, session, store, user } = await setup();
  const listed = (await david('/api/attention')).body as { items: { sessionId: string; phase: string; since: number }[] };
  const item = listed.items.find((i) => i.sessionId === session.id);
  assert.ok(item);
  const payload = { sessionId: session.id, phase: item.phase, since: item.since };
  const first = await david('/api/attention/ack', post(payload));
  assert.equal(typeof first.body.ackedAt, 'number');
  assert.equal((await david('/api/attention/ack', post({ ...payload, acked: false, ackedAt: first.body.ackedAt }))).status, 200);
  // 重新看了一遍，拿到更晚的收据（这里直接落库，避开同毫秒的偶然相等）
  const later = first.body.ackedAt + 1000;
  await store.ack(user.id, { sessionId: session.id, phase: item.phase as never, since: item.since }, later);
  assert.equal((await david('/api/attention')).body.items.some((i: { sessionId: string }) => i.sessionId === session.id), false);
  // 旧收据的迟到撤销 → 不生效，新的仍在
  const stale = await david('/api/attention/ack', post({ ...payload, acked: false, ackedAt: first.body.ackedAt }));
  assert.equal(stale.status, 200);
  assert.deepEqual(stale.body, { ok: true, undone: false });
  assert.equal((await david('/api/attention')).body.items.some((i: { sessionId: string }) => i.sessionId === session.id), false);
  // 新收据能撤
  assert.equal((await david('/api/attention/ack', post({ ...payload, acked: false, ackedAt: later }))).status, 200);
  assert.equal((await david('/api/attention')).body.items.some((i: { sessionId: string }) => i.sessionId === session.id), true);
});

test('attention/ack：不是发起人也不是任务负责人 → 静默成功但不写（与 GET 一样不暴露会话存在）', async () => {
  const { david, world, store, project } = await setup();
  // 别人建的任务 + 别人发起的会话：david 是项目可见的团队成员，但不是发起人/负责人
  const otherTask = {
    id: asTaskId('task-other'),
    projectId: asProjectId(project.id),
    title: '别人的任务',
    goal: null,
    status: 'todo' as const,
    ownerId: 'someone-else',
    branch: null,
    baseBranch: null,
    summary: null,
    defaultAgent: null,
    logSeq: 0,
    createdAt: 1,
    updatedAt: 1
  };
  await world.deps.tasks.save(otherTask);
  const made = deriveSession({ task: otherTask, agentId: asAgentId('fake'), model: 'm1', now: Date.now(), createdBy: 'someone-else' });
  assert.ok(made.ok);
  await world.deps.sessions.save({ ...made.value, status: 'failed' });

  const response = await david('/api/attention/ack', post({ sessionId: made.value.id, phase: 'failed', since: 1 }));
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true });
  const stored = await store.acks('someone-else');
  assert.equal(stored.length, 0);
  // 撤销同样静默
  const undo = await david('/api/attention/ack', post({ sessionId: made.value.id, phase: 'failed', since: 1, acked: false }));
  assert.equal(undo.status, 200);
  assert.equal((await store.acks('someone-else')).length, 0);
});
