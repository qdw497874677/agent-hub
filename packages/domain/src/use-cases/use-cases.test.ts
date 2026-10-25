import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDescriptor } from '../agent.ts';
import type { Session } from '../session.ts';
import { asAgentId } from '../ids.ts';
import { unavailable } from '../errors.ts';
import { err, ok } from '../result.ts';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { createProjectUseCase } from './projects.ts';
import { createTaskUseCase } from './tasks.ts';
import { changeSessionOption, deriveSessionUseCase, forkSessionUseCase, recordEvent } from './sessions.ts';
import { ensureHosted } from './hosting.ts';
import {
  ingestAgentSessionRef,
  ingestRuntimeStatus,
  ingestWorkerEvent,
  promptSessionUseCase,
  workerGone
} from './conversation.ts';
import { loadHome } from './home.ts';
import { saveLayoutUseCase } from './canvas.ts';
import { listWorkers } from './workers.ts';

/**
 * 用例层单测：只用内存端口，不起 HTTP、不起 SQLite。
 * 每条测试回答一个「编排顺序为什么是这样」的问题。
 */

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
    structured_events: { state: 'available' }
  },
  models: ['m1'],
  defaultModel: 'm1',
  options: []
};

async function world(overrides: Parameters<typeof inMemoryDeps>[0] = {}) {
  const w = inMemoryDeps(overrides);
  w.agents.push(fake);
  const project = await createProjectUseCase(w.deps, { name: 'demo', rootPath: '/tmp/demo' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: '写测试' });
  assert.ok(task.ok);
  return { ...w, project: project.value, task: task.value };
}

async function derived(w: Awaited<ReturnType<typeof world>>, model = 'm1'): Promise<Session> {
  const session = await deriveSessionUseCase(w.deps, { taskId: w.task.id, agentId: 'fake', model });
  assert.ok(session.ok);
  return session.value;
}

test('派生：模型只走 options.model 一条路，并登记为托管中', async () => {
  const w = await world();
  const session = await derived(w, 'm1');
  const [start] = w.dispatched;
  assert.equal(start?.kind, 'start_session');
  assert.deepEqual(start?.kind === 'start_session' && start.options, { model: 'm1' });
  assert.equal(start?.kind === 'start_session' && start.workspaceRoot, '/tmp/demo');
  assert.ok(w.deps.hosting.has(session.id));
});

test('派生：网关失败时会话记为 failed，且不算托管', async () => {
  const w = await world({ gateway: { status: async () => [], dispatch: async () => err(unavailable('没有 worker')) } });
  const result = await deriveSessionUseCase(w.deps, { taskId: w.task.id, agentId: 'fake', model: '' });
  assert.equal(result.ok, false);
  const [stored] = await w.deps.sessions.listAll();
  assert.equal(stored?.status, 'failed');
  assert.equal(w.deps.hosting.live.size, 0);
});

test('分叉：继承来源会话的可调项，再用新模型覆盖', async () => {
  const w = await world();
  const source = await derived(w);
  await w.deps.sessions.save({ ...source, options: { model: 'm1', thinking: 'high' } });
  await recordEvent(w.deps, { sessionId: source.id, event: { kind: 'text', delta: 'hi' } });
  const forked = await forkSessionUseCase(w.deps, { sessionId: source.id, atSeq: 1, agentId: 'fake', model: 'm2' });
  assert.ok(forked.ok);
  const start = w.dispatched.at(-1);
  assert.ok(start?.kind === 'start_session');
  assert.deepEqual(start.options, { model: 'm2', thinking: 'high' });
  assert.deepEqual(start.resume, { agentSessionRef: null, cursor: 1 });
});

test('发消息：会话没人托管时，先记下提问、再 resume、最后发 prompt', async () => {
  const w = await world();
  const session = await derived(w);
  w.deps.hosting.clear();
  w.dispatched.length = 0;

  const sent = await promptSessionUseCase(w.deps, { sessionId: session.id, text: '继续' });
  assert.ok(sent.ok);
  assert.deepEqual(w.dispatched.map((command) => command.kind), ['start_session', 'prompt']);
  const start = w.dispatched[0];
  assert.ok(start?.kind === 'start_session');
  assert.equal(start.resume?.cursor, 0, 'resume 停在提问之前：这句提问随后作为新的 prompt 发出');
  const journal = w.deps.sessions.journal.get(session.id) ?? [];
  assert.deepEqual(journal.map((entry) => entry.event), [{ kind: 'prompt', text: '继续' }]);
});

test('发消息：已托管就不重复拉起', async () => {
  const w = await world();
  const session = await derived(w);
  w.dispatched.length = 0;
  assert.ok((await promptSessionUseCase(w.deps, { sessionId: session.id, text: 'hi' })).ok);
  assert.deepEqual(w.dispatched.map((command) => command.kind), ['prompt']);
});

test('发消息：agent 起不来时提问仍然留在 journal 里', async () => {
  let fail = false;
  const w = await world({
    gateway: { status: async () => [], dispatch: async () => (fail ? err(unavailable('worker 掉了')) : ok(undefined)) }
  });
  const session = await derived(w);
  w.deps.hosting.clear();
  fail = true;
  const sent = await promptSessionUseCase(w.deps, { sessionId: session.id, text: '还在吗' });
  assert.equal(sent.ok, false);
  assert.equal((w.deps.sessions.journal.get(session.id) ?? []).length, 1);
});

test('发消息：会话不存在是 not_found', async () => {
  const w = await world();
  const sent = await promptSessionUseCase(w.deps, { sessionId: 'nope', text: 'x' });
  assert.ok(!sent.ok && sent.error.code === 'not_found');
});

test('改可调项：不在跑就先 resume，再 set_option；不写乐观值', async () => {
  const w = await world();
  const session = await derived(w);
  w.deps.hosting.clear();
  w.dispatched.length = 0;
  const changed = await changeSessionOption(w.deps, { sessionId: session.id, id: 'model', value: 'm2' });
  assert.ok(changed.ok);
  assert.deepEqual(w.dispatched.map((command) => command.kind), ['start_session', 'set_option']);
  assert.equal(changed.value.model, 'm1', '新值要等 agent 回报才落库');
});

test('ensureHosted：项目没了就拒绝，而不是对空气发指令', async () => {
  const w = await world();
  const session = await derived(w);
  w.deps.hosting.clear();
  w.deps.tasks.rows.clear();
  const hosted = await ensureHosted(w.deps, session);
  assert.ok(!hosted.ok && hosted.error.code === 'not_found');
});

test('worker 事件：相对路径的产出物按项目根补上字节数', async () => {
  const stats: string[] = [];
  const w = await world();
  w.deps.fs.stat = async (path) => {
    stats.push(path);
    return 42;
  };
  const session = await derived(w);
  const result = await ingestWorkerEvent(w.deps, session.id, { kind: 'artifact', path: 'out/a.md', bytes: 0 });
  assert.ok(result.ok);
  assert.deepEqual(stats, ['/tmp/demo/out/a.md']);
  const [entry] = w.deps.sessions.journal.get(session.id) ?? [];
  assert.deepEqual(entry?.event, { kind: 'artifact', path: 'out/a.md', bytes: 42 });
});

test('运行状态：ended 划掉托管，并以库里的状态推给界面', async () => {
  const w = await world();
  const session = await derived(w);
  await ingestRuntimeStatus(w.deps, session.id, 'ended');
  assert.equal(w.deps.hosting.has(session.id), false);
  assert.equal(w.frames.at(-1)?.status, session.status);
  await ingestRuntimeStatus(w.deps, session.id, 'running');
  assert.equal(w.frames.at(-1)?.status, 'running');
});

test('agent 会话号落库，resume 时原样带回', async () => {
  const w = await world();
  const session = await derived(w);
  assert.ok((await ingestAgentSessionRef(w.deps, session.id, 'agent-123')).ok);
  w.deps.hosting.clear();
  w.dispatched.length = 0;
  const fresh = await w.deps.sessions.byId(session.id);
  assert.ok(fresh);
  assert.ok((await ensureHosted(w.deps, fresh)).ok);
  const start = w.dispatched[0];
  assert.ok(start?.kind === 'start_session');
  assert.equal(start.resume?.agentSessionRef, 'agent-123');
});

test('worker 掉线：所有会话都不再算托管', async () => {
  const w = await world();
  await derived(w);
  await derived(w);
  workerGone(w.deps);
  assert.equal(w.deps.hosting.live.size, 0);
});

test('首页：最近会话按时间倒序、受条数限制、项目按活跃度排序', async () => {
  const w = await world();
  const first = await derived(w);
  const second = await derived(w);
  const home = await loadHome(w.deps, 1);
  assert.equal(home.projects[0]?.sessionCount, 2);
  assert.equal(home.projects[0]?.taskCount, 1);
  assert.deepEqual(home.recentSessions.map((row) => row.sessionId), [second.id]);
  assert.notEqual(first.id, second.id);
  assert.equal(home.recentSessions[0]?.projectName, 'demo');
});

test('保存布局：从空布局开始，逐个放置', async () => {
  const w = await world();
  const layout = await saveLayoutUseCase(w.deps, w.project.id, { positions: { a: { x: 1, y: 2 }, b: { x: 3, y: 4 } } });
  assert.deepEqual(layout.positions, { a: { x: 1, y: 2 }, b: { x: 3, y: 4 } });
  assert.deepEqual(layout.sizes, {});
  assert.deepEqual((await w.deps.layout.load(w.project.id))?.positions, layout.positions);
});

test('保存尺寸：与位置合并，只拖位置不会冲掉已存的尺寸，无效尺寸被忽略', async () => {
  const w = await world();
  await saveLayoutUseCase(w.deps, w.project.id, {
    positions: { a: { x: 0, y: 0 } },
    sizes: { a: { width: 400, height: 300 }, bad: { width: 0, height: 10 }, nan: { width: Number.NaN, height: 5 } }
  });
  const moved = await saveLayoutUseCase(w.deps, w.project.id, { positions: { a: { x: 9, y: 9 } } });
  assert.deepEqual(moved.positions, { a: { x: 9, y: 9 } });
  assert.deepEqual(moved.sizes, { a: { width: 400, height: 300 } });
  assert.deepEqual((await w.deps.layout.load(w.project.id))?.sizes, { a: { width: 400, height: 300 } });
});

test('节点列表来自网关端口', async () => {
  const w = await world({
    gateway: {
      status: async () => [{ workerId: 'w1', label: '本机', origin: 'local', state: 'online' }],
      dispatch: async () => ok(undefined)
    }
  });
  assert.deepEqual((await listWorkers(w.deps)).map((row) => row.workerId), ['w1']);
});
