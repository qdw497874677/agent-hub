import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createDispatcher, ok, type AgentTaskRequest, type DispatcherDeps } from '@agent-hub/domain';
import { createSqliteTaskDispatch } from './task-dispatch.ts';

const req = (i: number, over: Partial<AgentTaskRequest> = {}): AgentTaskRequest => ({
  id: `r${i}`, taskId: `t${i}`, accountId: 'u1', agent: 'boss', sessionId: 'bot', projectId: 'p1', title: `任务${i}`, goal: 'g',
  originConnector: null, originExternalId: null, wakeKey: 'run1', counted: true, approval: 'none', createdAt: i, updatedAt: i, ...over
});

function world(db = new DatabaseSync(':memory:')) {
  const store = createSqliteTaskDispatch(db);
  let clock = 1000;
  const sessions = new Map<string, { running: boolean; outcome: 'done' | 'failed' | null; reply: string }>();
  const started: string[] = [];
  const notified: { sid: string; text: string }[] = [];
  let botBusy = false;
  const deps: DispatcherDeps = {
    now: () => ++clock, store,
    placement: async (p) => ({ workerId: p === 'p3' ? 'w2' : 'w1', online: true }),
    start: async (d) => { await new Promise((r) => setTimeout(r, 5)); const sid = `s-${d.taskId}`; started.push(d.taskId); sessions.set(sid, { running: true, outcome: null, reply: '' }); return ok({ sessionId: sid, workerId: d.projectId === 'p3' ? 'w2' : 'w1' }); },
    sessionState: async (sid) => sessions.get(sid) ?? null,
    busy: async () => botBusy,
    notify: async (sid, text) => { notified.push({ sid, text }); return ok(undefined); },
    abandonTask: async () => undefined
  };
  return { db, store, deps, sessions, started, notified, setBusy: (b: boolean) => { botBusy = b; }, d: createDispatcher(deps) };
}

test('调度器：并发 tick 不重复派发；完成后通知建它的 bot（忙就等）', async () => {
  const w = world();
  await w.d.enqueue(req(1), { agentId: 'pi', model: 'm' });
  await w.d.enqueue(req(1), { agentId: 'pi', model: 'm' }); // 同一任务只入队一次
  await w.d.enqueue(req(2), { agentId: 'pi', model: 'm' });
  await w.d.enqueue(req(3, { projectId: 'p3' }), { agentId: 'pi', model: 'm' });
  await Promise.all([w.d.tick(), w.d.tick(), w.d.tick()]);
  assert.deepEqual(w.started, ['t1', 't3']);
  const v = await w.d.list('u1');
  assert.equal(v.queued.length, 1);
  assert.equal(v.queued[0]!.waitReason, '等机器空位');
  w.setBusy(true);
  w.sessions.set('s-t1', { running: false, outcome: 'done', reply: '改好了' });
  await w.d.sessionEnded('s-t1');
  assert.deepEqual(w.started, ['t1', 't3', 't2']);
  assert.equal(w.notified.length, 0);
  w.setBusy(false);
  await w.d.tick();
  assert.equal(w.notified.length, 1);
  assert.match(w.notified[0]!.text, /任务完成.*任务1[\s\S]*改好了/);
  await w.d.tick();
  assert.equal(w.notified.length, 1);
});

test('调度器：重启后从库里重建 running 计数，已结束的补对账', async () => {
  const db = new DatabaseSync(':memory:');
  const a = world(db);
  await a.d.enqueue(req(1), { agentId: 'pi', model: 'm' });
  await a.d.enqueue(req(2, { projectId: 'p3' }), { agentId: 'pi', model: 'm' });
  await a.d.enqueue(req(3, { projectId: 'p4' }), { agentId: 'pi', model: 'm' });
  await a.d.tick();
  assert.deepEqual(a.started, ['t1', 't2']);
  // 「重启」：新调度器、同一个库；t1 的会话在停机期间结束了
  const b = world(db);
  b.sessions.set('s-t1', { running: false, outcome: 'failed', reply: '' });
  b.sessions.set('s-t2', { running: true, outcome: null, reply: '' });
  await b.d.tick();
  assert.deepEqual(b.started, ['t3']);
  const v = await b.d.list('u1');
  assert.equal(v.running.length, 2);
  assert.equal(v.recent[0]!.state, 'failed');
  assert.match(b.notified[0]!.text, /任务失败/);
});

test('调度器：取消排队的任务；开始了就不能取消', async () => {
  const w = world();
  const q1 = (await w.d.enqueue(req(1), { agentId: 'pi', model: 'm' }))!;
  const q2 = (await w.d.enqueue(req(2), { agentId: 'pi', model: 'm' }))!;
  await w.d.tick();
  assert.equal((await w.d.cancel('u1', q1.id)).ok, false);
  assert.equal((await w.d.cancel('u2', q2.id)).ok, false);
  assert.equal((await w.d.cancel('u1', q2.id)).ok, true);
  w.sessions.set('s-t1', { running: false, outcome: 'done', reply: 'x' });
  await w.d.sessionEnded('s-t1');
  assert.deepEqual(w.started, ['t1']);
});
