import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asAgentId, asSessionId, createProject, createTask, deriveSession, recordEvent } from '@agent-hub/domain';
import { inMemoryDeps } from '@agent-hub/domain/testing';
import { createTurnFinisher, endStalledTurn, type TurnFinishDeps } from './turn-finish.ts';

function world(overrides: Partial<TurnFinishDeps> = {}) {
  const calls: string[] = [];
  const logged: string[] = [];
  let lastSeq = 3;
  const deps: TurnFinishDeps = {
    sessions: { byId: async () => ({ lastSeq }) },
    log: (message) => logged.push(message),
    inbox: { end: async (sessionId, outcome, reason) => void calls.push(`inbox:${sessionId}:${outcome}:${reason ?? ''}`) },
    files: { endTurn: async (sessionId) => void calls.push(`files:${sessionId}`) },
    fakeReplies: { finish: async (sessionId) => (calls.push(`fake:${sessionId}`), null) },
    feishuReplies: { finish: async (sessionId) => (calls.push(`feishu:${sessionId}`), null) },
    ...overrides
  };
  return { deps, calls, logged, advance: (seq: number) => (lastSeq = seq) };
}

const sid = asSessionId('s1');

test('同一回合的 ended 事件与 idle 状态：钩子只跑一次', async () => {
  const w = world();
  const finisher = createTurnFinisher(w.deps);
  assert.equal(await finisher.finish(sid, 'done'), true);
  assert.equal(await finisher.finish(sid, 'done'), false, '同一 lastSeq 再来一次就跳过');
  assert.deepEqual(w.calls, [`inbox:${sid}:done:`, `files:${sid}`, `fake:${sid}`, `feishu:${sid}`]);
});

test('下一回合（journal 前进）照常收尾', async () => {
  const w = world();
  const finisher = createTurnFinisher(w.deps);
  await finisher.finish(sid, 'done');
  w.advance(9);
  assert.equal(await finisher.finish(sid, 'done'), true);
  assert.equal(w.calls.filter((call) => call.startsWith('inbox:')).length, 2);
});

test('一个钩子失败不影响其它钩子，只记日志', async () => {
  const w = world({
    inbox: { end: async () => { throw new Error('db down'); } }
  });
  const finisher = createTurnFinisher(w.deps);
  assert.equal(await finisher.finish(sid, 'failed', 'boom'), true);
  assert.ok(w.calls.some((call) => call.startsWith('files:')));
  assert.ok(w.calls.some((call) => call.startsWith('feishu:')));
  assert.equal(w.logged.length, 1);
  assert.match(w.logged[0]!, /回合收尾失败：Error: db down/);
});

test('独立的一次 idle 与事件帧并发到达：只跑一次', async () => {
  const w = world();
  const finisher = createTurnFinisher(w.deps);
  const [a, b] = await Promise.all([finisher.finish(sid, 'done'), finisher.finish(sid, 'done')]);
  assert.deepEqual([a, b].sort(), [false, true]);
  assert.equal(w.calls.filter((call) => call.startsWith('inbox:')).length, 1);
});

test('进程消失的会话没有 journal 末尾：同一条也只收一次', async () => {
  const w = world({ sessions: { byId: async () => null } });
  const finisher = createTurnFinisher(w.deps);
  assert.equal(await finisher.finish(sid, 'failed'), true);
  assert.equal(await finisher.finish(sid, 'failed'), false);
});

test('卡顿收尾：补一条 ended{interrupted} 才放行，且只收一次', async () => {
  const { deps, frames } = inMemoryDeps();
  const project = createProject({ name: 'demo', now: 1 });
  assert.ok(project.ok);
  const task = createTask({ projectId: project.value.id, title: 't', now: 1 });
  assert.ok(task.ok);
  const created = deriveSession({ task: task.value, agentId: asAgentId('pi'), model: 'm', now: 1 });
  assert.ok(created.ok);
  await deps.projects.save(project.value);
  await deps.tasks.save(task.value);
  await deps.sessions.save(created.value);
  const sessionId = created.value.id;

  const calls: string[] = [];
  const finisher = createTurnFinisher({
    sessions: deps.sessions,
    log: () => undefined,
    inbox: { end: async (id, outcome) => void calls.push(`inbox:${id}:${outcome}`) },
    files: { endTurn: async () => undefined }
  });

  // 卡住的那一轮：journal 末尾还是 prompt，状态 running。
  await recordEvent(deps, { sessionId, event: { kind: 'prompt', text: '卡住了' } });
  assert.equal((await deps.sessions.byId(sessionId))!.status, 'running');

  assert.equal(await endStalledTurn(deps, finisher, sessionId, '太久没动'), true);
  const session = await deps.sessions.byId(sessionId);
  assert.equal(session!.status, 'interrupted');
  const tail = await deps.sessions.tail(sessionId, 1);
  assert.ok(tail[0]!.event.kind === 'ended' && tail[0]!.event.outcome === 'interrupted');
  assert.deepEqual(calls, [`inbox:${sessionId}:interrupted`]);
  assert.ok(frames.some((frame) => frame.event?.kind === 'ended'), '界面收到结束帧');

  assert.equal(await endStalledTurn(deps, finisher, sessionId, '太久没动'), false, '已经结束的不再补');
  assert.equal((await deps.sessions.tail(sessionId, 20)).filter((e) => e.event.kind === 'ended').length, 1);
});
