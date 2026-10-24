import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, deriveSession, forkSession, markInterrupted } from './session.ts';
import { createTask } from './task.ts';
import { asAgentId, asProjectId, newTaskId } from './ids.ts';

const agentId = asAgentId('pi');
const now = 1_700_000_000_000;

function openTask() {
  const task = createTask({ projectId: asProjectId('p1'), title: '重构会话层', now });
  assert.ok(task.ok);
  return task.value;
}

test('派生会话必须挂在任务上，并带上 derive 起源', () => {
  const created = deriveSession({ task: openTask(), agentId, model: 'claude-sonnet-4', now });
  assert.ok(created.ok);
  assert.equal(created.value.origin.kind, 'derive');
  assert.equal(created.value.status, 'running');
  assert.equal(created.value.lastSeq, 0);
  assert.equal(created.value.agentSessionRef, null);
});

test('放弃的任务不能派生新会话——死路不该再长出分支', () => {
  const task = { ...openTask(), status: 'abandoned' as const };
  const created = deriveSession({ task, agentId, model: 'm', now });
  assert.ok(!created.ok);
  assert.equal(created.error.code, 'conflict');
});

/** 造一个已经有 n 条事件的会话：fork 切点是"第 N 条之后"，所以来源得先有历史。 */
function sessionWith(n: number) {
  const created = deriveSession({ task: openTask(), agentId, model: 'm', now });
  assert.ok(created.ok);
  let session = created.value;
  for (let i = 0; i < n; i += 1) {
    session = applyEvent(session, { kind: 'text', delta: `第 ${i + 1} 段` }, now);
  }
  return session;
}

test('fork 记录来源会话与切点', () => {
  const source = sessionWith(3);
  const forked = forkSession({ source, atSeq: 3, agentId, model: 'm', now });
  assert.ok(forked.ok);
  assert.deepEqual(forked.value.origin, {
    kind: 'fork',
    fromSessionId: source.id,
    atSeq: 3
  });
  assert.equal(forked.value.status, 'running');
  assert.equal(forked.value.lastSeq, 0, '新会话自己的 seq 从 0 起，血缘靠 origin 记');
});

test('fork 切点超过已有事件数则拒绝', () => {
  const source = sessionWith(2);
  const forked = forkSession({ source, atSeq: 9, agentId, model: 'm', now });
  assert.ok(!forked.ok);
  assert.equal(forked.error.code, 'conflict');
});

test('fork 切点必须为正整数——0 等于派生，不该走 fork', () => {
  const source = sessionWith(2);
  const forked = forkSession({ source, atSeq: 0, agentId, model: 'm', now });
  assert.ok(!forked.ok);
  assert.equal(forked.error.code, 'invalid');
});

test('每个事件推进一次 seq，只有 ended 改状态', () => {
  const source = deriveSession({ task: openTask(), agentId, model: 'm', now });
  assert.ok(source.ok);
  let session = source.value;

  session = applyEvent(session, { kind: 'text', delta: '看一下' }, now);
  session = applyEvent(session, { kind: 'tool_call', name: 'read', input: 'a.ts' }, now);
  assert.equal(session.lastSeq, 2);
  assert.equal(session.status, 'running');

  session = applyEvent(session, { kind: 'ended', outcome: 'stopped' }, now);
  assert.equal(session.lastSeq, 3);
  assert.equal(session.status, 'stopped');
});

test('中断与人按停止是两个状态', () => {
  const source = deriveSession({ task: openTask(), agentId, model: 'm', now });
  assert.ok(source.ok);
  const stopped = applyEvent(source.value, { kind: 'ended', outcome: 'stopped' }, now);
  const interrupted = markInterrupted(source.value, now);
  assert.equal(stopped.status, 'stopped');
  assert.equal(interrupted.status, 'interrupted');
  assert.notEqual(stopped.status, interrupted.status);
});

test('taskId 由任务带来，不是外部传入', () => {
  const task = { ...openTask(), id: newTaskId() };
  const created = deriveSession({ task, agentId, model: 'm', now });
  assert.ok(created.ok);
  assert.equal(created.value.taskId, task.id);
});
