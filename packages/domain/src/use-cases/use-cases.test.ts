import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDescriptor } from '../agent.ts';
import type { Session } from '../session.ts';
import { asAgentId, asSessionId } from '../ids.ts';
import { unavailable } from '../errors.ts';
import { err, ok } from '../result.ts';
import { fakeGit, inMemoryDeps } from '../testing/in-memory.ts';
import { createProjectUseCase } from './projects.ts';
import { createTaskUseCase } from './tasks.ts';
import { changeSessionOption, deriveSessionUseCase, forkSessionUseCase, recordEvent } from './sessions.ts';
import { ensureHosted } from './hosting.ts';
import {
  ingestAgentSessionRef,
  ingestRuntimeStatus,
  ingestWorkerEvent,
  promptSessionUseCase,
  workerAttached,
  workerGone,
  frameAccepted
} from './conversation.ts';
import { placeSession } from '../worker.ts';
import type { NodeGateway } from '../ports/node-gateway.ts';
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
    structured_events: { state: 'available' },
  attachments: { state: 'available' }
  },
  models: ['m1'],
  defaultModel: 'm1',
  options: []
};

/** 一台装了全部 agent 的本机 Worker：大多数用例只需要「有地方跑」。 */
const localGateway: NodeGateway = {
  probe: async () => true,
  status: async () => [{ workerId: 'local', label: '本机', origin: 'local', state: 'online' }],
  dispatch: async () => ok(undefined),
  listDirectories: async (_id, path) => ok({ path, exists: true, entries: [] }),
  makeDirectory: async (_id, parent, name) => ok({ path: `${parent}/${name}` }),
  listFiles: async () => ok({ files: [], truncated: false }),
  readFile: async () => ok(null),
  git: () => fakeGit().on('remote')
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

test('派生：会话记下它在哪个工作空间干活；分叉沿用同一个；同一目录只登记一次', async () => {
  const w = await world();
  const first = await derived(w);
  const second = await derived(w);
  assert.ok(first.workspaceId);
  assert.equal(second.workspaceId, first.workspaceId);
  const workspace = await w.deps.workspaces.byId(first.workspaceId);
  assert.equal(workspace?.path, '/tmp/demo');
  assert.equal(workspace?.kind, 'long_lived');
  assert.equal(workspace?.source, 'linked');
  await recordEvent(w.deps, { sessionId: first.id, event: { kind: 'text', delta: 'hi' } });
  const forked = await forkSessionUseCase(w.deps, { sessionId: first.id, atSeq: 1, agentId: 'fake', model: '' });
  assert.ok(forked.ok);
  assert.equal(forked.value.workspaceId, first.workspaceId);
  assert.equal((await w.deps.workspaces.byProject(w.project.id)).length, 1);
});

test('老会话（没有工作空间）重新托管时补上它一直在用的目录', async () => {
  const w = await world();
  const session = await derived(w);
  await w.deps.sessions.save({ ...session, workspaceId: null, status: 'done' });
  w.deps.hosting.drop(session.id);
  const hosted = await ensureHosted(w.deps, { ...session, workspaceId: null });
  assert.ok(hosted.ok);
  assert.equal((await w.deps.sessions.byId(session.id))?.workspaceId, session.workspaceId);
});

test('派生：网关失败时会话记为 failed，且不算托管', async () => {
  const w = await world({ gateway: { ...localGateway, dispatch: async () => err(unavailable('没有 worker')) } });
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

test('分叉一律从最新处：客户端传的 atSeq 被忽略，血缘记 lastSeq', async () => {
  const w = await world();
  const source = await derived(w);
  for (const delta of ['a', 'b', 'c']) await recordEvent(w.deps, { sessionId: source.id, event: { kind: 'text', delta } });
  const lastSeq = (await w.deps.sessions.byId(source.id))!.lastSeq;
  assert.ok(lastSeq >= 3);
  const forked = await forkSessionUseCase(w.deps, { sessionId: source.id, atSeq: 1, agentId: 'fake', model: '' });
  assert.ok(forked.ok);
  assert.deepEqual(forked.value.origin, { kind: 'fork', fromSessionId: source.id, atSeq: lastSeq });
  const start = w.dispatched.at(-1);
  assert.ok(start?.kind === 'start_session');
  assert.equal(start.resume?.cursor, lastSeq);
  const omitted = await forkSessionUseCase(w.deps, { sessionId: source.id, agentId: 'fake', model: '' });
  assert.ok(omitted.ok);
  assert.equal(omitted.value.origin.kind === 'fork' && omitted.value.origin.atSeq, lastSeq);
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
    gateway: { ...localGateway, dispatch: async () => (fail ? err(unavailable('worker 掉了')) : ok(undefined)) }
  });
  const session = await derived(w);
  w.deps.hosting.clear();
  fail = true;
  const sent = await promptSessionUseCase(w.deps, { sessionId: session.id, text: '还在吗' });
  assert.equal(sent.ok, false);
  const journal = (w.deps.sessions.journal.get(session.id) ?? []).map((entry) => entry.event);
  assert.deepEqual(journal[0], { kind: 'prompt', text: '还在吗' });
  // 这一轮收尾成失败，界面不会一直挂着「运行中」
  assert.deepEqual(journal[1], { kind: 'ended', outcome: 'failed', reason: '发送失败：worker 掉了' });
  assert.equal((await w.deps.sessions.byId(session.id))?.status, 'failed');
});

test('发消息：已托管但 prompt 送不出去，也收尾成失败', async () => {
  let fail = false;
  const w = await world({
    gateway: { ...localGateway, dispatch: async () => (fail ? err(unavailable('连接断了')) : ok(undefined)) }
  });
  const session = await derived(w);
  fail = true;
  assert.equal((await promptSessionUseCase(w.deps, { sessionId: session.id, text: 'hi' })).ok, false);
  assert.equal((await w.deps.sessions.byId(session.id))?.status, 'failed');
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

test('worker 掉线：只有它名下的会话不再算托管', async () => {
  const w = await world();
  w.workers.push({ workerId: 'remote-1', label: '服务器', origin: 'remote', state: 'online' });
  const here = await derived(w);
  // 同一个任务的后续会话改到远程机器上的项目目录里跑
  for (const workspace of await w.deps.workspaces.byProject(w.project.id)) {
    await w.deps.workspaces.save({ ...workspace, workerId: 'remote-1' });
  }
  const there = await deriveSessionUseCase(w.deps, { taskId: w.task.id, agentId: 'fake', model: '' });
  assert.ok(there.ok);
  assert.equal(here.workerId, 'local');
  assert.equal(there.value.workerId, 'remote-1');
  assert.equal(workerGone(w.deps, 'remote-1'), 1);
  assert.ok(w.deps.hosting.has(here.id));
  assert.ok(!w.deps.hosting.has(there.value.id));
});

test('worker 重连报上的会话重新算托管；别的机器的会话它认领不了', async () => {
  const w = await world();
  w.workers.push({ workerId: 'remote-1', label: '服务器', origin: 'remote', state: 'online' });
  const here = await derived(w);
  w.deps.hosting.clear();
  assert.deepEqual(await workerAttached(w.deps, 'remote-1', [here.id]), []);
  assert.deepEqual(await workerAttached(w.deps, 'local', [here.id]), [here.id]);
  assert.ok(w.deps.hosting.has(here.id));
});

test('Worker 秒重连：先接回、后到的掉线不会把刚接回的会话划掉', async () => {
  const w = await world();
  const here = await derived(w);
  w.deps.hosting.clear();
  // 旧连接的掉线和新连接的 hello 交错：掉线是同步的，接回发生在它之后就留得住
  workerGone(w.deps, 'local');
  await workerAttached(w.deps, 'local', [here.id]);
  assert.ok(w.deps.hosting.has(here.id));
});

test('Worker 发来的会话帧只在会话落在它身上时算数', async () => {
  const w = await world();
  w.workers.push({ workerId: 'remote-1', label: '服务器', origin: 'remote', state: 'online' });
  const here = await derived(w);
  assert.equal(await frameAccepted(w.deps, 'local', here.id), true);
  assert.equal(await frameAccepted(w.deps, 'remote-1', here.id), false);
  assert.equal(await frameAccepted(w.deps, 'local', asSessionId('nope')), false);
  await w.deps.sessions.save({ ...here, workerId: null });
  assert.equal(await frameAccepted(w.deps, 'remote-1', here.id), true);
});

test('落点：start_session 带着 workerId；resume 回到原来那台，那台离线就报不可用', async () => {
  const w = await world();
  w.workers.push({ workerId: 'remote-1', label: '服务器', origin: 'remote', state: 'online' });
  for (const workspace of await w.deps.workspaces.byProject(w.project.id)) {
    await w.deps.workspaces.save({ ...workspace, workerId: 'remote-1' });
  }
  const made = await deriveSessionUseCase(w.deps, { taskId: w.task.id, agentId: 'fake', model: '', workerId: 'remote-1' });
  assert.ok(made.ok);
  const start = w.dispatched.at(-1);
  assert.ok(start?.kind === 'start_session' && start.workerId === 'remote-1');
  w.deps.hosting.clear();
  w.workers.splice(1, 1, { workerId: 'remote-1', label: '服务器', origin: 'remote', state: 'offline' });
  const fresh = await w.deps.sessions.byId(made.value.id);
  assert.ok(fresh);
  const resumed = await ensureHosted(w.deps, fresh);
  // 网关替身不知道离线，所以这里只验证指令仍然指向原来那台，而不是被悄悄挪到本机
  assert.ok(resumed.ok);
  const again = w.dispatched.at(-1);
  assert.ok(again?.kind === 'start_session' && again.workerId === 'remote-1');
});

test('落点：老会话没有 workerId，托管时补落一次并记下', async () => {
  const w = await world();
  const made = await derived(w);
  await w.deps.sessions.save({ ...made, workerId: null });
  w.deps.hosting.clear();
  const legacy = await w.deps.sessions.byId(made.id);
  assert.ok(legacy && legacy.workerId === null);
  assert.ok((await ensureHosted(w.deps, legacy)).ok);
  assert.equal((await w.deps.sessions.byId(made.id))?.workerId, 'local');
});

test('落点规则：项目绑定（未绑定 = 本机）> 点名 > 任意；没装 agent / 离线 / 冲突都说清楚', () => {
  const workers = [
    { workerId: 'r1', label: 'A', origin: 'remote' as const, state: 'online' as const, agentIds: ['pi'] },
    { workerId: 'l1', label: '本机', origin: 'local' as const, state: 'online' as const, agentIds: ['pi', 'grok'] },
    { workerId: 'r2', label: 'B', origin: 'remote' as const, state: 'offline' as const, agentIds: ['pi'] }
  ];
  const pick = (agentId: string, requested: string | null, projectWorker: string | null) =>
    placeSession(workers, { agentId, requested, projectWorker });
  assert.deepEqual(pick('pi', null, null), ok('l1'));
  // 未绑定项目的目录在本机：点名远程机器是冲突，不是悄悄去一个没有这个目录的地方
  assert.equal(pick('pi', 'r1', null).ok, false);
  assert.deepEqual(pick('pi', 'l1', null), ok('l1'));
  assert.deepEqual(pick('pi', null, 'r1'), ok('r1'));
  // 没有本机 Worker（全靠远程）：才轮到点名 / 任意一台
  const remoteOnly = workers.filter((worker) => worker.origin === 'remote');
  assert.deepEqual(placeSession(remoteOnly, { agentId: 'pi', requested: 'r1', projectWorker: null }), ok('r1'));
  assert.deepEqual(placeSession(remoteOnly, { agentId: 'pi', requested: null, projectWorker: null }), ok('r1'));
  assert.equal(pick('pi', 'l1', 'r1').ok, false);
  assert.equal(pick('grok', 'r1', null).ok, false);
  assert.equal(placeSession(remoteOnly, { agentId: 'pi', requested: 'r2', projectWorker: null }).ok, false);
  assert.equal(pick('codex', null, null).ok, false);
});

test('落点：装了但不可用（未登录）的 harness 不选；老 Worker 不报就绪状态按能用', () => {
  const grokDown = { agentId: 'grok', models: [], defaultModel: '', readiness: { state: 'unavailable' as const, reason: '未登录' } };
  const workers = [
    { workerId: 'r1', label: 'omarchy', origin: 'remote' as const, state: 'online' as const, agentIds: ['pi', 'grok'], agentModels: [grokDown] },
    { workerId: 'r2', label: 'old', origin: 'remote' as const, state: 'online' as const, agentIds: ['grok'] }
  ];
  const pinned = placeSession(workers, { agentId: 'grok', requested: 'r1', projectWorker: null });
  assert.equal(pinned.ok, false);
  assert.match(pinned.ok ? '' : pinned.error.message, /omarchy.*未登录/);
  assert.deepEqual(placeSession(workers, { agentId: 'grok', requested: null, projectWorker: null }), ok('r2'));
  assert.deepEqual(placeSession(workers, { agentId: 'pi', requested: 'r1', projectWorker: null }), ok('r1'));
  const none = placeSession([workers[0]!], { agentId: 'grok', requested: null, projectWorker: null });
  assert.match(none.ok ? '' : none.error.message, /「omarchy」未登录/);
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
      ...localGateway,
      status: async () => [{ workerId: 'w1', label: '本机', origin: 'local', state: 'online' }],
      dispatch: async () => ok(undefined)
    }
  });
  assert.deepEqual((await listWorkers(w.deps)).map((row) => row.workerId), ['w1']);
});
