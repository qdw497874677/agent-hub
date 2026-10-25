import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentToDto } from '@agent-hub/contract/codec';
import type { AgentDescriptor, JournalEntry, Session, SessionEvent, SessionId, Task } from '@agent-hub/domain';
import { asAgentId, asSessionId, recordEvent } from '@agent-hub/domain';
import { fakeHosting, fakeSessions, fakeTasks, inMemoryDeps } from '@agent-hub/domain/testing';
import { createApp } from './http.ts';
import { createStreamHub } from './stream-hub.ts';
import { createLiveCatalog } from './agent-catalog.ts';

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
    structured_events: { state: 'available' }
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

function harness(token: string | null = null) {
  const tasks = fakeTasks();
  const sessions = fakeSessions(tasks.rows);
  const hosting = fakeHosting();
  const world = inMemoryDeps({
    tasks,
    sessions,
    hosting,
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
  const app = createApp({ deps, hub, token });

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
  assert.equal(prompted.status, 200);
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

test('分叉一个不存在的会话返回 404，分叉点超出历史返回 409', async () => {
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
  assert.match((beyond.body as { error: { message: string } }).error.message, /超出/);
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

test('绑非 loopback 时 token 可从请求头或查询串带（SSE 设不了请求头）', async () => {
  const { call } = harness('s3cret');

  assert.equal((await call('/api/health')).status, 401);
  assert.equal((await call('/api/health?token=wrong')).status, 401);
  assert.equal((await call('/api/health?token=s3cret')).status, 200);
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
