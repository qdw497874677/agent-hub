import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryDeps, inMemoryDeliveries } from '../testing/in-memory.ts';
import { available, capabilityMatrix } from '../capability.ts';
import { asAgentId, asSessionId } from '../ids.ts';
import type { Deps } from './deps.ts';
import type { JournalEntry, SessionEvent } from '../event.ts';
import { createProjectUseCase } from './projects.ts';
import { createTaskUseCase } from './tasks.ts';
import { deriveSessionUseCase } from './sessions.ts';
import { promptSessionUseCase } from './conversation.ts';

/**
 * 发送回执 + clientMessageId 幂等（design/message-send-feedback.md §5.1 / §5.3）。
 * 这里只证明协议形状和「重复 id 不重复落库」，不改派发时序。
 */

async function world() {
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
  const deps = { ...w.deps, deliveries };
  const project = await createProjectUseCase(deps, { name: 'demo', rootPath: '/tmp/demo' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(deps, { projectId: project.value.id, title: 't' });
  assert.ok(task.ok);
  const session = await deriveSessionUseCase(deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  assert.ok(session.ok);
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
