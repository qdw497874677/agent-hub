import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from './project.ts';
import { createTask, markStarted, setTaskStatus } from './task.ts';
import { asProjectId } from './ids.ts';

const now = 1_700_000_000_000;

test('项目必须绑一个存在的绝对路径', () => {
  const missing = createProject({
    name: 'agent-hub',
    rootPath: '/nope',
    directoryExists: false,
    now
  });
  assert.ok(!missing.ok);
  assert.equal(missing.error.code, 'invalid');

  const relative = createProject({
    name: 'agent-hub',
    rootPath: 'agent-hub',
    directoryExists: true,
    now
  });
  assert.ok(!relative.ok);
});

test('任务状态机只允许登记过的迁移', () => {
  const task = createTask({ projectId: asProjectId('p1'), title: '接通 Pi', now });
  assert.ok(task.ok);
  assert.equal(task.value.status, 'todo');
  assert.equal(task.value.logSeq, 0);

  const started = markStarted(task.value, now);
  assert.equal(started.status, 'in_progress');
  const review = setTaskStatus(started, 'in_review', now);
  assert.ok(review.ok);
  const done = setTaskStatus(review.value, 'done', now);
  assert.ok(done.ok);
  const back = setTaskStatus(done.value, 'in_progress', now);
  assert.ok(back.ok);
  const abandoned = setTaskStatus(back.value, 'abandoned', now);
  assert.ok(abandoned.ok);
  assert.ok(!setTaskStatus(abandoned.value, 'done', now).ok);
});

test('agent 最多把任务推到 in_review，不能设 done / abandoned', () => {
  const task = createTask({ projectId: asProjectId('p1'), title: 't', now });
  assert.ok(task.ok);
  const started = markStarted(task.value, now);
  assert.ok(setTaskStatus(started, 'blocked', now, 'agent').ok);
  assert.ok(setTaskStatus(started, 'in_review', now, 'agent').ok);
  const done = setTaskStatus(started, 'done', now, 'agent');
  assert.ok(!done.ok);
  assert.equal(done.error.code, 'conflict');
});

test('标题不能为空', () => {
  const task = createTask({ projectId: asProjectId('p1'), title: '  ', now });
  assert.ok(!task.ok);
  assert.equal(task.error.code, 'invalid');
});
