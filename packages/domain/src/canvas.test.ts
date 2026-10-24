import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLineage } from './canvas.ts';
import { applyEvent, deriveSession, forkSession } from './session.ts';
import { createTask } from './task.ts';
import { asAgentId, asProjectId } from './ids.ts';

const agentId = asAgentId('pi');
const now = 1_700_000_000_000;

test('血缘图包含 derive 与 fork 两种边', () => {
  const task = createTask({ projectId: asProjectId('p1'), title: '画布', now });
  assert.ok(task.ok);

  const derived = deriveSession({ task: task.value, agentId, model: 'm', now });
  assert.ok(derived.ok);
  const a = applyEvent(
    applyEvent(derived.value, { kind: 'text', delta: '一' }, now),
    { kind: 'text', delta: '二' },
    now
  );
  const b = deriveSession({ task: task.value, agentId, model: 'm', now });
  assert.ok(b.ok);
  const forked = forkSession({ source: a, atSeq: 2, agentId, model: 'm', now });
  assert.ok(forked.ok);

  const edges = buildLineage([task.value], [a, b.value, forked.value]);
  const derives = edges.filter((edge) => edge.kind === 'derive');
  const forks = edges.filter((edge) => edge.kind === 'fork');

  assert.equal(derives.length, 3, '三条会话各有一条 derive 边连到任务');
  assert.equal(forks.length, 1);
  assert.deepEqual(forks[0], {
    kind: 'fork',
    fromSessionId: a.id,
    toSessionId: forked.value.id,
    atSeq: 2
  });
});
