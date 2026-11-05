import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planDispatch, dispatchOrder, type DispatchCandidate } from './dispatch.ts';

const c = (id: string, over: Partial<DispatchCandidate> = {}): DispatchCandidate => ({ id, projectId: 'p1', human: false, createdAt: Number(id.replace(/\D/g, '')) || 0, workerId: 'w1', workerOnline: true, ...over });

test('调度：每个项目 1、每台机器 1、全局 2', () => {
  const plan = planDispatch([c('a1'), c('a2'), c('a3', { projectId: 'p2' }), c('a4', { projectId: 'p3', workerId: 'w2' }), c('a5', { projectId: 'p4', workerId: 'w3' })], []);
  assert.deepEqual(plan.start, ['a1', 'a4']);
  assert.equal(plan.waiting.get('a2'), '等机器空位');
  assert.equal(plan.waiting.get('a3'), '等机器空位');
  assert.equal(plan.waiting.get('a5'), '并发已满');
});

test('调度：每项目 1 独立于机器', () => {
  const plan = planDispatch([c('a1', { workerId: 'w1' }), c('a2', { workerId: 'w2' })], []);
  assert.deepEqual(plan.start, ['a1']);
  assert.equal(plan.waiting.get('a2'), '等项目空位');
});

test('调度：人发起的只受全局 + 人工槽（3），不受每机器 / 每项目，且排在自动的前面', () => {
  const running = [{ projectId: 'p1', workerId: 'w1', human: false }, { projectId: 'p2', workerId: 'w2', human: false }];
  const plan = planDispatch([c('a1', { projectId: 'p9', workerId: 'w9' }), c('h2', { human: true }), c('h3', { human: true })], running);
  assert.deepEqual(plan.start, ['h2']);
  assert.equal(plan.waiting.get('a1'), '并发已满');
  assert.equal(plan.waiting.get('h3'), '并发已满');
  // 空闲时三个人发起的同项目同机器：前三个都能开
  assert.deepEqual(planDispatch([c('h1', { human: true }), c('h2', { human: true }), c('h3', { human: true }), c('h4', { human: true })], []).start, ['h1', 'h2', 'h3']);
});

test('调度：自动任务不能占用人工预留槽', () => {
  const running = [{ projectId: 'p1', workerId: 'w1', human: true }, { projectId: 'p2', workerId: 'w2', human: true }];
  assert.deepEqual(planDispatch([c('a1', { projectId: 'p3', workerId: 'w3' })], running).start, []);
});

test('调度：机器离线就等，不占位；同优先级先进先出', () => {
  const plan = planDispatch([c('a2', { workerOnline: false }), c('a3', { projectId: 'p2', workerId: 'w2' })], []);
  assert.deepEqual(plan.start, ['a3']);
  assert.equal(plan.waiting.get('a2'), '等机器上线');
  assert.deepEqual(dispatchOrder([c('a9'), c('h7', { human: true }), c('a1'), c('h3', { human: true })]).map((x) => x.id), ['h3', 'h7', 'a1', 'a9']);
});
