import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from './project.ts';
import { createTask, setTaskStatus } from './task.ts';
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
  assert.equal(task.value.status, 'open');

  const done = setTaskStatus(task.value, 'done', now);
  assert.ok(done.ok);

  const back = setTaskStatus(done.value, 'open', now);
  assert.ok(back.ok);

  const abandoned = setTaskStatus(back.value, 'abandoned', now);
  assert.ok(abandoned.ok);
  assert.equal(abandoned.value.status, 'abandoned');
});

test('标题不能为空', () => {
  const task = createTask({ projectId: asProjectId('p1'), title: '  ', now });
  assert.ok(!task.ok);
  assert.equal(task.error.code, 'invalid');
});
