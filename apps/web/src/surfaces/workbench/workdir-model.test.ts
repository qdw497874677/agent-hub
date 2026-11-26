import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseRoute, formatRoute } from '../../shell/route.ts';
import { eligibleWorkdir, terminalErrorText, terminalPollInterval, workdirLabels, workdirSessionLabel } from './workdir-model.ts';

test('workdir route round trips without changing legacy session deep links', () => {
  const route = { page: 'project', projectId: 'p/1', view: 'workdir', sessionId: 'w/1' } as const;
  assert.equal(formatRoute(route), '#/p/p%2F1/workdir/w%2F1');
  assert.deepEqual(parseRoute(formatRoute(route)), route);
  assert.deepEqual(parseRoute('#/p/p/focus/s'), { page: 'project', projectId: 'p', view: 'focus', sessionId: 's' });
  assert.equal(parseRoute('#/p/p/workdir')?.page, 'project');
  assert.deepEqual(parseRoute('#/p/p/workdir'), { page: 'project', projectId: 'p', view: 'list', sessionId: null });
});

test('workdir labels only add context to duplicates or missing sessions', () => {
  assert.deepEqual(workdirLabels([
    { id: 'session-1111', title: '测试任务' },
    { id: 'session-2222', title: '明确标题' },
    { id: 'session-3333', title: '测试任务' },
    { id: 'session-4444', title: '会话', needsContext: true }
  ]), ['测试任务 · 1111', '明确标题', '测试任务 · 3333', '会话 · 4444']);
  assert.deepEqual(workdirLabels([{ id: 's-1111', title: '测试任务' }]), ['测试任务']);
});

test('session labels follow focus title precedence', () => {
  assert.equal(workdirSessionLabel('s', { title: '会话标题' }, { title: '任务标题' }, true).title, '会话标题');
  assert.equal(workdirSessionLabel('s', { title: null }, { title: '任务标题' }, false).title, '任务标题');
  assert.equal(workdirSessionLabel('s', {}, undefined, true).title, '主会话');
  assert.deepEqual(workdirSessionLabel('s-1234', {}, undefined, false), { id: 's-1234', title: '没有任务的会话', needsContext: true });
  assert.deepEqual(workdirSessionLabel('s-1234', undefined, undefined, false), { id: 's-1234', title: '会话', needsContext: true });
});

test('terminal access errors do not expose server details and stop permanent-error polling', () => {
  assert.equal(terminalPollInterval(403), false);
  assert.equal(terminalPollInterval(404), false);
  assert.equal(terminalPollInterval(503), 3000);
  assert.equal(terminalPollInterval(undefined), 3000);
  assert.equal(terminalErrorText(403), '无权访问独立终端');
  assert.equal(terminalErrorText(404), '独立终端不可用');
  assert.equal(terminalErrorText(503), '独立终端状态暂时无法读取');
});

test('disabled terminal inventory pauses only after all terminal work is settled', () => {
  const disabled = { available: false, reason: '工作目录终端未启用', terminals: [] };
  assert.equal(terminalPollInterval(undefined, disabled), false);
  assert.equal(terminalPollInterval(undefined, { ...disabled, terminals: [{ state: 'ended' }] }), false);
  for (const state of ['pending', 'running', 'closing']) {
    assert.equal(terminalPollInterval(undefined, { ...disabled, terminals: [{ state }] }), 3000);
  }
  assert.equal(terminalPollInterval(undefined, disabled, true), 3000);
  assert.equal(terminalPollInterval(undefined, disabled, false, true), 3000);
  assert.equal(terminalPollInterval(503, disabled), 3000);
  assert.equal(terminalPollInterval(undefined, { ...disabled, reason: '机器暂时不可用' }), 3000);
  assert.equal(terminalPollInterval(undefined, { ...disabled, available: true }), 3000);
});

test('only ready or kept single workdirs with proven project ownership are eligible', () => {
  const workspace = { state: 'ready', groupId: null };
  assert.equal(eligibleWorkdir(workspace, 'p', 'p'), true);
  assert.equal(eligibleWorkdir({ ...workspace, state: 'kept' }, 'p', 'p'), true);
  assert.equal(eligibleWorkdir({ ...workspace, groupId: 'g' }, 'p', 'p'), false);
  assert.equal(eligibleWorkdir({ ...workspace, state: 'preparing' }, 'p', 'p'), false);
  assert.equal(eligibleWorkdir(workspace, null, 'p'), false);
  assert.equal(eligibleWorkdir(workspace, 'other', 'p'), false);
});
