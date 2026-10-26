import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { createTask } from '../task.ts';
import { deriveSession } from '../session.ts';
import { asAgentId } from '../ids.ts';
import type { SessionEvent } from '../event.ts';
import { recordEvent } from './sessions.ts';
import { flagStalledSessions } from './stall.ts';

const policy = { idleMs: 60_000, marker: '长时间无输出' };

async function world(last: SessionEvent) {
  let clock = 1_000;
  const { deps } = inMemoryDeps({ now: () => clock });
  const task = createTask({ projectId: 'p' as never, title: 't', goal: '', now: 1, id: undefined });
  assert.ok(task.ok);
  const session = deriveSession({ task: task.value, agentId: asAgentId('pi'), model: 'm', now: 1 });
  assert.ok(session.ok);
  await deps.tasks.save(task.value);
  await deps.sessions.save({ ...session.value, status: 'running' });
  await recordEvent(deps, { sessionId: session.value.id, event: last });
  return { deps, id: session.value.id, advance: (ms: number) => (clock += ms) };
}

test('一轮没结束又超时没动静：记一条 warn 诊断，且只记一次', async () => {
  const w = await world({ kind: 'prompt', text: '你好' });
  assert.deepEqual(await flagStalledSessions(w.deps, policy), [], '没超时不提醒');
  w.advance(120_000);
  assert.deepEqual(await flagStalledSessions(w.deps, policy), [w.id]);
  const last = (await w.deps.sessions.tail(w.id, 1))[0]?.event;
  assert.equal(last?.kind, 'diagnostic');
  assert.ok(last?.kind === 'diagnostic' && last.level === 'warn' && last.text.startsWith(policy.marker));
  w.advance(600_000);
  assert.deepEqual(await flagStalledSessions(w.deps, policy), [], '同一次卡顿不重复提醒');
});

test('上一轮已经结束（在等用户）不算卡住', async () => {
  const w = await world({ kind: 'ended', outcome: 'done' });
  w.advance(600_000);
  assert.deepEqual(await flagStalledSessions(w.deps, policy), []);
});
