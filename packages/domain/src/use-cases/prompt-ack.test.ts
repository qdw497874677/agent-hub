import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryDeps, inMemoryDeliveries } from '../testing/in-memory.ts';
import { available, capabilityMatrix } from '../capability.ts';
import { asAgentId, asSessionId } from '../ids.ts';
import { forbidden, unavailable } from '../errors.ts';
import { err } from '../result.ts';
import type { Deps } from './deps.ts';
import type { JournalEntry, SessionEvent } from '../event.ts';
import type { WorkerCommand } from '../ports/node-gateway.ts';
import { createProjectUseCase } from './projects.ts';
import { createTaskUseCase } from './tasks.ts';
import { deriveSessionUseCase } from './sessions.ts';
import { promptSessionUseCase } from './conversation.ts';

/**
 * 发送回执 + clientMessageId 幂等（design/message-send-feedback.md §5.1 / §5.3），
 * 以及 MS-2：ack 先返回、attemptDelivery 在后台跑。
 */

/** promptSessionUseCase 先回 ack，后台派发是另一段微任务；setImmediate 在微任务清空后触发。 */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function world(failDispatch?: 'unavailable' | 'forbidden') {
  const deliveries = inMemoryDeliveries();
  const w = inMemoryDeps();
  w.agents.push({
    id: asAgentId('fake'),
    label: 'Fake',
    capabilities: capabilityMatrix({ prompt: available, interrupt: available, fork: available, resume: available, tool_calls: available, artifacts: available, structured_events: available, attachments: available }),
    models: ['m1'],
    defaultModel: 'm1',
    options: []
  });
  // 失败注入仍然经过 dispatched 记账，断言「确实尝试过派发」。
  // 只让 prompt 失败：派生会话本身要先 start_session（ensureHosted），那条必须还能成功。
  const baseDispatch = w.deps.gateway.dispatch;
  const gateway = failDispatch
    ? {
        ...w.deps.gateway,
        dispatch: async (command: WorkerCommand) => {
          if (command.kind !== 'prompt') return baseDispatch(command);
          w.dispatched.push(command);
          return err(failDispatch === 'unavailable' ? unavailable('Worker 不在线') : forbidden('没有权限'));
        }
      }
    : w.deps.gateway;
  const deps = { ...w.deps, deliveries, gateway };
  const project = await createProjectUseCase(deps, { name: 'demo', rootPath: '/tmp/demo' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(deps, { projectId: project.value.id, title: 't' });
  assert.ok(task.ok);
  const session = await deriveSessionUseCase(deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  assert.ok(session.ok, JSON.stringify(session));
  return { deps, deliveries, dispatched: w.dispatched, sid: session.value.id };
}

type PromptEntry = JournalEntry & { readonly event: Extract<SessionEvent, { kind: 'prompt' }> };
const isPrompt = (entry: JournalEntry): entry is PromptEntry => entry.event.kind === 'prompt';

const prompts = async (deps: Pick<Deps, 'sessions'>, sid: string): Promise<PromptEntry[]> =>
  (await deps.sessions.eventsAfter(asSessionId(sid), 0 as never)).filter(isPrompt);

test('prompt 返回 ack：seq 是 journal 里这条 prompt 的 seq，state 合法', async () => {
  const w = await world();
  const out = await promptSessionUseCase(w.deps, { sessionId: w.sid, text: '你好' });
  assert.ok(out.ok, JSON.stringify(out));
  const ack = out.value;
  const [logged] = await prompts(w.deps, w.sid);
  assert.ok(logged);
  assert.equal(ack.seq, logged.seq, 'ack.seq 必须等于 journal 的 seq');
  assert.equal(typeof ack.seq, 'number');
  assert.ok(ack.state === 'queued' || ack.state === 'sending');
  const rows = await w.deliveries.recent(w.sid, 10);
  assert.equal(rows.length, 1);
  assert.equal(ack.deliveryId, rows[0]!.id, 'ack.deliveryId 指向这条 prompt 的送达记录');
  assert.equal(ack.state, 'sending', '队首、已尝试派发');
});

test('同一 clientMessageId 发两次：journal 只有一条 prompt，第二次拿到相同 seq', async () => {
  const w = await world();
  const first = await promptSessionUseCase(w.deps, { sessionId: w.sid, text: '重试我', clientMessageId: 'cm-1' });
  assert.ok(first.ok, JSON.stringify(first));
  const second = await promptSessionUseCase(w.deps, { sessionId: w.sid, text: '重试我', clientMessageId: 'cm-1' });
  assert.ok(second.ok, JSON.stringify(second));

  const logged = await prompts(w.deps, w.sid);
  assert.equal(logged.length, 1, '重复 id 不能再写 journal');
  assert.equal(logged[0]!.event.clientMessageId, 'cm-1');
  assert.equal(first.value.seq, logged[0]!.seq);
  assert.equal(second.value.seq, first.value.seq, '第二次返回同一个 seq');
  assert.equal(second.value.deliveryId, first.value.deliveryId, '第二次返回同一条送达记录');
  assert.equal(second.value.state, 'queued');
  assert.equal((await w.deliveries.recent(w.sid, 10)).length, 1, '也不能重复入队');
  assert.equal(w.dispatched.filter((command) => command.kind === 'prompt').length, 1, '不能重复派发');
});

test('不传 clientMessageId 连发两条相同文本：journal 两条（不能误去重）', async () => {
  const w = await world();
  assert.ok((await promptSessionUseCase(w.deps, { sessionId: w.sid, text: '同一句' })).ok);
  assert.ok((await promptSessionUseCase(w.deps, { sessionId: w.sid, text: '同一句' })).ok);
  const logged = await prompts(w.deps, w.sid);
  assert.equal(logged.length, 2);
  assert.ok(logged.every((entry) => entry.event.clientMessageId === undefined));
});

test('MS-2：后台派发失败（unavailable）时仍然返回 ok，delivery 退避重排、这一轮先不收', async () => {
  const w = await world('unavailable');
  const out = await promptSessionUseCase(w.deps, { sessionId: w.sid, text: '离线', clientMessageId: 'cm-offline' });
  assert.ok(out.ok, '派发失败不能再把 HTTP 变成 500');
  assert.equal(out.value.state, 'sending', 'ack 不等派发，先回报「发送中」');
  assert.ok(out.value.deliveryId);

  await settle();
  const row = await w.deliveries.byId(out.value.deliveryId);
  assert.ok(row);
  assert.equal(row.state, 'queued', 'unavailable 是可重试失败，按退避排下一次');
  assert.equal(row.attempt, 1);
  assert.equal(row.lastError, 'Worker 不在线');
  assert.ok(row.nextAt !== null && row.nextAt > 0);

  const events = await w.deps.sessions.eventsAfter(asSessionId(w.sid), 0 as never);
  assert.equal(events.filter((e) => e.event.kind === 'ended').length, 0, '还有重试机会，不能提前把这一轮收掉');
  assert.equal(w.dispatched.filter((command) => command.kind === 'prompt').length, 1, '后台确实尝试过派发');
});

test('MS-2：后台派发失败（不可重试）时仍然返回 ok，delivery 收成 undelivered 并补 ended(failed)', async () => {
  const w = await world('forbidden');
  const out = await promptSessionUseCase(w.deps, { sessionId: w.sid, text: '没权限', clientMessageId: 'cm-denied' });
  assert.ok(out.ok, '失败只能落在 delivery/ended，不能是 HTTP 错误');
  assert.equal(out.value.state, 'sending');
  assert.ok(out.value.deliveryId);

  await settle();
  const row = await w.deliveries.byId(out.value.deliveryId);
  assert.ok(row);
  assert.equal(row.state, 'undelivered');
  assert.equal(row.lastError, '没有权限');
  assert.equal(row.nextAt, null);

  const ended = (await w.deps.sessions.eventsAfter(asSessionId(w.sid), 0 as never)).filter((e) => e.event.kind === 'ended');
  assert.equal(ended.length, 1, 'HTTP 已经 202 了，失败只能补在会话里');
  assert.ok(ended[0]!.event.kind === 'ended' && ended[0]!.event.outcome === 'failed');
  assert.match(ended[0]!.event.kind === 'ended' ? ended[0]!.event.reason ?? '' : '', /未送达：没有权限/);
});
