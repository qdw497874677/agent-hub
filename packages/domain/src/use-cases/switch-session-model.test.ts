import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDescriptor } from '../agent.ts';
import type { RuntimeOption } from '../option.ts';
import type { Delivery } from '../delivery.ts';
import type { SessionQueue } from '../ports/session-queue.ts';
import { asAgentId } from '../ids.ts';
import { available, capabilityMatrix } from '../capability.ts';
import { inMemoryDeliveries, inMemoryDeps } from '../testing/in-memory.ts';
import { createProjectUseCase } from './projects.ts';
import { createTaskUseCase } from './tasks.ts';
import { deriveSessionUseCase, recordEvent, switchSessionModel } from './sessions.ts';
import { ingestWorkerOptions, promptSessionUseCase } from './conversation.ts';

/**
 * 换提供商 = 换模型 + 重启进程。这组测试守住四条：
 * 1. 回合没结束就拒绝（无论 status 写成什么），拒绝时不动进程、不写库；
 * 2. 空闲时不用 interrupt，同 id start_session 会 dispose 旧进程；
 * 3. 切换和 journal 写入 / 其它切换走同一条 per-session 队列；
 * 4. 已入队但还没派发的消息不算「回合在跑」，否则离线排队会把切换永远锁死。
 * 送达侧目前把 `attemptDelivery`（含 claimSend）也放进这条队列，`claimPrompt` 的入队
 * 写入仍在队列外但只产生 queued 行；「切换拿锁期间被认领」那条用外部写入模拟，
 * 守住切换侧的快照判断。
 */

const fake: AgentDescriptor = {
  id: asAgentId('fake'),
  label: 'Fake',
  capabilities: capabilityMatrix({
    prompt: available,
    interrupt: available,
    fork: available,
    resume: available,
    tool_calls: available,
    artifacts: available,
    structured_events: available,
    attachments: available
  }),
  models: ['m1'],
  defaultModel: 'm1',
  options: []
};

/** 真串行版 per-session 队列（测试替身默认的 immediateQueue 不排队，测不出交错）。 */
function serialQueue(): SessionQueue & { maxActive: number } {
  const tails = new Map<string, Promise<unknown>>();
  let active = 0;
  const stats = { maxActive: 0 };
  return {
    get maxActive() {
      return stats.maxActive;
    },
    async run<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
      const previous = tails.get(sessionId) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      tails.set(sessionId, previous.catch(() => undefined).then(() => gate));
      await previous.catch(() => undefined);
      active += 1;
      stats.maxActive = Math.max(stats.maxActive, active);
      try {
        return await work();
      } finally {
        active -= 1;
        release();
      }
    }
  };
}

async function world(overrides: Parameters<typeof inMemoryDeps>[0] = {}) {
  const deliveries = inMemoryDeliveries();
  const w = inMemoryDeps({ deliveries, ...overrides });
  w.agents.push(fake);
  const project = await createProjectUseCase(w.deps, { name: 'demo', rootPath: '/tmp/demo' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: 't' });
  assert.ok(task.ok);
  const session = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  assert.ok(session.ok);
  return { ...w, deliveries, sid: session.value.id };
}

type World = Awaited<ReturnType<typeof world>>;

const modelOption = (current: string): RuntimeOption => ({
  id: 'model',
  label: '模型',
  category: 'model',
  kind: 'select',
  current,
  choices: []
});

/** 一句已经写进 journal、但（还）没有 ended 的提问。返回它的 seq，便于挂送达记录。 */
async function journalPrompt(w: World): Promise<number> {
  const logged = await recordEvent(w.deps, { sessionId: w.sid, event: { kind: 'prompt', text: 'hi' } });
  assert.ok(logged.ok);
  return logged.value.lastSeq;
}

const startModels = (w: World): readonly unknown[] =>
  w.dispatched.filter((command) => command.kind === 'start_session').map((command) => (command.kind === 'start_session' ? command.options['model'] : null));

/** 等后台派发跑完（prompt 回执后 attemptDelivery 是 void 出去的）。 */
async function until(check: () => Promise<boolean>, label: string): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (await check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`等待超时：${label}`);
}

test('空闲切换：不发 interrupt，按新模型重启并 resume 到 lastSeq', async () => {
  const w = await world();
  await journalPrompt(w);
  const ended = await recordEvent(w.deps, { sessionId: w.sid, event: { kind: 'ended', outcome: 'done' } });
  assert.ok(ended.ok);
  const cursor = ended.value.lastSeq;
  w.deps.hosting.clear();
  w.dispatched.length = 0;

  const switched = await switchSessionModel(w.deps, { sessionId: w.sid, model: 'hub-gw/glm-5' });
  assert.ok(switched.ok, JSON.stringify(switched));
  assert.equal(switched.value.model, 'hub-gw/glm-5');
  assert.equal(switched.value.options['model'], 'hub-gw/glm-5');

  const kinds = w.dispatched.map((command) => command.kind);
  assert.ok(!kinds.includes('interrupt'), '空闲切换不需要打断谁');
  assert.deepEqual(startModels(w), ['hub-gw/glm-5']);
  const start = w.dispatched.find((command) => command.kind === 'start_session');
  assert.deepEqual(
    start?.kind === 'start_session' ? start.resume : null,
    { agentSessionRef: null, cursor },
    '重启要接着 lastSeq，历史才接得回来'
  );
});

test('status 已是 interrupted，但送达队列里还有 sending：拒绝切换且零副作用', async () => {
  const w = await world();
  await w.deps.sessions.save({ ...(await w.deps.sessions.byId(w.sid))!, status: 'interrupted' });
  await w.deliveries.save({
    id: 'delivery-1',
    sessionId: w.sid,
    seq: 1,
    kind: 'prompt',
    payload: {},
    state: 'sending',
    attempt: 0,
    nextAt: null,
    lastError: null,
    createdAt: 1,
    updatedAt: 1
  });
  w.deps.hosting.add(w.sid, 'local');
  w.dispatched.length = 0;

  const switched = await switchSessionModel(w.deps, { sessionId: w.sid, model: 'hub-gw/glm-5' });
  assert.ok(!switched.ok);
  assert.equal(switched.error.code, 'conflict');
  assert.match(switched.error.message, /中断|等/, '冲突要给出可执行的出路');

  assert.deepEqual(w.dispatched, [], '拒绝时不能重启 / 打断 / 发 start_session');
  assert.equal(w.deps.hosting.has(w.sid), true, '拒绝时不能丢托管记录');
  const after = await w.deps.sessions.byId(w.sid);
  assert.equal(after?.model, 'm1', '拒绝时不能改写模型');
  assert.equal(after?.options['model'], undefined);
  assert.equal(after?.status, 'interrupted');
  assert.equal((await w.deliveries.byId('delivery-1'))?.state, 'sending', '在途送达不该被切换取消');
});

test('status 是 done 但送达队列里还有 sending：同样拒绝', async () => {
  const w = await world();
  await w.deps.sessions.save({ ...(await w.deps.sessions.byId(w.sid))!, status: 'done' });
  await w.deliveries.save({
    id: 'delivery-2', sessionId: w.sid, seq: 1, kind: 'prompt', payload: {}, state: 'sending',
    attempt: 0, nextAt: null, lastError: null, createdAt: 1, updatedAt: 1
  });
  w.dispatched.length = 0;

  const switched = await switchSessionModel(w.deps, { sessionId: w.sid, model: 'hub-gw/glm-5' });
  assert.ok(!switched.ok && switched.error.code === 'conflict');
  assert.deepEqual(w.dispatched, []);
});

test('status 是 running 且 journal 尾部有未结束的 prompt：保守拒绝（老会话没有送达记录）', async () => {
  const w = await world();
  await journalPrompt(w);
  w.dispatched.length = 0;

  const switched = await switchSessionModel(w.deps, { sessionId: w.sid, model: 'hub-gw/glm-5' });
  assert.ok(!switched.ok && switched.error.code === 'conflict', '没有 ended 证据时不能重启');
  assert.deepEqual(w.dispatched, []);
  const after = await w.deps.sessions.byId(w.sid);
  assert.equal(after?.model, 'm1');
});

/** 挂一条送达记录；用来模拟「已入队 / 已放弃 / 已撤回」或并发的 sending。 */
async function recordDelivery(
  w: World,
  seq: number,
  state: Delivery['state'],
  id = `delivery-${state}`
): Promise<void> {
  await w.deliveries.save({
    id,
    sessionId: w.sid,
    seq,
    kind: 'prompt',
    payload: {},
    state,
    attempt: 0,
    nextAt: null,
    lastError: null,
    createdAt: 1,
    updatedAt: 1
  });
}

test('已入队但还没派发：queued 的 prompt 不算回合在跑，切换照常进行', async () => {
  const w = await world();
  const seq = await journalPrompt(w);
  await recordDelivery(w, seq, 'queued', 'delivery-queued');
  w.dispatched.length = 0;

  const switched = await switchSessionModel(w.deps, { sessionId: w.sid, model: 'hub-gw/glm-5' });
  assert.ok(switched.ok, JSON.stringify(switched));
  assert.deepEqual(startModels(w), ['hub-gw/glm-5'], '没派发的消息可以留给新进程');
  assert.ok(!w.dispatched.some((command) => command.kind === 'interrupt'), '没有回合可打断');
  assert.equal((await w.deliveries.byId('delivery-queued'))?.state, 'queued', '切换不能丢掉还没送出去的消息');
});

test('已放弃 / 用户撤回的 prompt 不阻塞切换', async () => {
  for (const state of ['undelivered', 'cancelled'] as const) {
    const w = await world();
    const seq = await journalPrompt(w);
    await recordDelivery(w, seq, state, `delivery-${state}`);
    w.dispatched.length = 0;

    const switched = await switchSessionModel(w.deps, { sessionId: w.sid, model: 'hub-gw/glm-5' });
    assert.ok(switched.ok, `${state}: ${JSON.stringify(switched)}`);
    assert.equal((await w.deliveries.byId(`delivery-${state}`))?.state, state);
  }
});

test('status 已 interrupted 且 journal 留着半截 prompt：允许切换（状态是已停止的证据）', async () => {
  const w = await world();
  await journalPrompt(w);
  const session = await w.deps.sessions.byId(w.sid);
  assert.ok(session);
  await w.deps.sessions.save({ ...session, status: 'interrupted' });
  w.dispatched.length = 0;

  const switched = await switchSessionModel(w.deps, { sessionId: w.sid, model: 'hub-gw/glm-5' });
  assert.ok(switched.ok, JSON.stringify(switched));
  assert.deepEqual(startModels(w), ['hub-gw/glm-5']);
  assert.ok(!w.dispatched.some((command) => command.kind === 'interrupt'), '切的是已停止的会话，不该再补一枪');
});

test('切换在队列里等待时，送达入口把消息认领成 sending：切换必须让路', async () => {
  // 这个队列只在 hold 打开后挡住工作，模拟切换已经排到队列、但还没拿到锁。
  let hold = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const queue: SessionQueue = {
    run: async <T>(_sessionId: string, work: () => Promise<T>): Promise<T> => {
      if (hold) await gate;
      return work();
    }
  };
  const w = await world({ queue });
  w.deps.hosting.add(w.sid, 'local');
  w.dispatched.length = 0;

  hold = true;
  const switching = switchSessionModel(w.deps, { sessionId: w.sid, model: 'hub-gw/glm-5' });
  // 模拟送达入口在队列外把这条消息翻成 sending（当前实现里 claimSend 也走队列，
  // 这里守住切换侧的快照判断，防止将来串行化退化）。
  await recordDelivery(w, 1, 'sending', 'delivery-race');
  release();
  const switched = await switching;

  assert.ok(!switched.ok && switched.error.code === 'conflict', '认领发生在检查之后也不能硬切');
  assert.deepEqual(w.dispatched, [], '让路时不能重启 / 打断 / 发 start_session');
  assert.equal((await w.deps.sessions.byId(w.sid))?.model, 'm1');
  assert.equal(w.deps.hosting.has(w.sid), true);
  assert.equal((await w.deliveries.byId('delivery-race'))?.state, 'sending');
});

test('真实并发：切换先入队时 prompt 落在新进程；prompt 已送出时切换让路', async () => {
  // A：用户切换后马上发消息。切换先拿到队列，消息必须等新进程起来再送。
  {
    const queue = serialQueue();
    const w = await world({ queue });
    w.deps.hosting.clear();
    w.dispatched.length = 0;

    const switching = switchSessionModel(w.deps, { sessionId: w.sid, model: 'hub-gw/new' });
    const prompting = promptSessionUseCase(w.deps, { sessionId: w.sid, text: 'hi' });
    const [switched, prompted] = await Promise.all([switching, prompting]);
    assert.ok(switched.ok, JSON.stringify(switched));
    assert.ok(prompted.ok, JSON.stringify(prompted));
    await until(async () => w.dispatched.some((command) => command.kind === 'prompt'), 'prompt 派发');

    const kinds = w.dispatched.map((command) => command.kind);
    const startAt = kinds.indexOf('start_session');
    const promptAt = kinds.indexOf('prompt');
    assert.ok(startAt >= 0, '切换必须先重启进程');
    assert.ok(promptAt > startAt, `消息不能先落到旧进程：${kinds.join(',')}`);
    assert.deepEqual(startModels(w), ['hub-gw/new']);
  }

  // B：用户发完消息、运行中立刻切换。消息已经认领成 sending，切换必须让路。
  {
    const queue = serialQueue();
    const w = await world({ queue });
    w.deps.hosting.add(w.sid, 'local');
    w.dispatched.length = 0;

    const prompted = await promptSessionUseCase(w.deps, { sessionId: w.sid, text: 'hi' });
    assert.ok(prompted.ok, JSON.stringify(prompted));
    await until(async () => w.dispatched.some((command) => command.kind === 'prompt'), 'prompt 派发');

    const switched = await switchSessionModel(w.deps, { sessionId: w.sid, model: 'hub-gw/new' });
    assert.ok(!switched.ok && switched.error.code === 'conflict', '这一轮已经送到运行时，不能硬切');
    assert.deepEqual(
      w.dispatched.filter((command) => command.kind === 'start_session' || command.kind === 'interrupt'),
      [],
      '让路时不能重启也不能打断'
    );
    assert.equal((await w.deps.sessions.byId(w.sid))?.model, 'm1');
  }
});

test('连续快速切换：按队列顺序落库和下发，最后一次生效', async () => {
  const queue = serialQueue();
  const w = await world({ queue });
  w.deps.hosting.clear();
  w.dispatched.length = 0;

  const [first, second] = await Promise.all([
    switchSessionModel(w.deps, { sessionId: w.sid, model: 'hub-gw/first' }),
    switchSessionModel(w.deps, { sessionId: w.sid, model: 'hub-gw/second' })
  ]);
  assert.ok(first.ok, JSON.stringify(first));
  assert.ok(second.ok, JSON.stringify(second));
  assert.equal(queue.maxActive, 1, '切换不能并行，否则最后落库的模型和最后下发的不一致');

  const saved = await w.deps.sessions.byId(w.sid);
  assert.equal(saved?.model, 'hub-gw/second');
  assert.deepEqual(startModels(w), ['hub-gw/first', 'hub-gw/second'], '下发顺序要和切换顺序一致');
});

test('同一提供商运行中换模型：agent 回报 A→B 要落库（model / options / optionSpec）', async () => {
  const w = await world();
  const current = await w.deps.sessions.byId(w.sid);
  assert.ok(current);
  await w.deps.sessions.save({
    ...current,
    status: 'running',
    model: 'm1',
    options: { ...current.options, model: 'm1' },
    optionSpec: [modelOption('m1')]
  });

  const reported = await ingestWorkerOptions(w.deps, w.sid, [modelOption('m2')]);
  assert.ok(reported.ok, JSON.stringify(reported));
  assert.equal(reported.value.model, 'm2', 'model 字段才是准的，不能停在旧模型');
  assert.equal(reported.value.options['model'], 'm2');
  assert.equal(reported.value.optionSpec.find((option) => option.id === 'model')?.current, 'm2');

  const saved = await w.deps.sessions.byId(w.sid);
  assert.equal(saved?.model, 'm2', '回报必须真的落库');
});

test('同一提供商的其它选项回报照常同步，不会连带改模型', async () => {
  const w = await world();
  const current = await w.deps.sessions.byId(w.sid);
  assert.ok(current);
  await w.deps.sessions.save({
    ...current,
    status: 'running',
    model: 'm1',
    options: { ...current.options, model: 'm1' },
    optionSpec: [modelOption('m1')]
  });

  const reported = await ingestWorkerOptions(w.deps, w.sid, [
    modelOption('m1'),
    { id: 'effort', label: '思考档位', category: 'thought_level', kind: 'select', current: 'high', choices: [] }
  ]);
  assert.ok(reported.ok, JSON.stringify(reported));
  assert.equal(reported.value.model, 'm1');
  assert.equal(reported.value.options['effort'], 'high');
});

test('跨提供商切换后，旧进程的整份选项回报不能覆盖新选择', async () => {
  const w = await world();
  const current = await w.deps.sessions.byId(w.sid);
  assert.ok(current);
  await w.deps.sessions.save({ ...current, status: 'stopped', model: 'hub-old/a' });
  const switched = await switchSessionModel(w.deps, { sessionId: w.sid, model: 'hub-gw/b' });
  assert.ok(switched.ok, JSON.stringify(switched));
  const before = await w.deps.sessions.byId(w.sid);
  const late = await ingestWorkerOptions(w.deps, w.sid, [
    modelOption('hub-old/a'),
    { id: 'effort', label: '思考档位', category: 'thought_level', kind: 'select', current: 'high', choices: [] }
  ]);
  assert.ok(late.ok);
  assert.deepEqual(await w.deps.sessions.byId(w.sid), before);
  const sameProvider = await ingestWorkerOptions(w.deps, w.sid, [modelOption('hub-gw/c')]);
  assert.ok(sameProvider.ok);
  assert.equal((await w.deps.sessions.byId(w.sid))?.model, 'hub-gw/c');
});
