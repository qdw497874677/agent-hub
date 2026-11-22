import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asProjectId, asTaskId } from './ids.ts';
import { createTask } from './task.ts';

const now = 1_700_000_000_000;
const projectId = asProjectId('p1');

const parent = () => {
  const created = createTask({ projectId, title: '父任务', now });
  assert.ok(created.ok);
  return created.value;
};

test('没有父任务时 parentTaskId 写 null（旧任务读回时可以省略）', () => {
  const task = createTask({ projectId, title: '单干', now });
  assert.ok(task.ok);
  assert.equal(task.value.parentTaskId, null);
});

test('同项目父任务：关系落在子任务上，父任务本身不变', () => {
  const p = parent();
  const child = createTask({ projectId, title: '子任务', parent: p, parentTaskId: p.id, now });
  assert.ok(child.ok);
  assert.equal(child.value.parentTaskId, p.id);
  // 创建是纯函数：父任务对象不被修改。
  assert.equal(p.parentTaskId, null);
  assert.equal(p.title, '父任务');
});

test('父任务必须同项目', () => {
  const other = createTask({ projectId: asProjectId('p2'), title: '别项目', now });
  assert.ok(other.ok);
  const child = createTask({ projectId, title: '子任务', parent: other.value, parentTaskId: other.value.id, now });
  assert.ok(!child.ok);
  assert.equal(child.error.code, 'invalid');
  assert.equal(child.error.message, '父任务必须与子任务同项目');
});

test('只给 parentTaskId 不给父任务快照：拒绝，不默认放行', () => {
  const child = createTask({ projectId, title: '子任务', parentTaskId: asTaskId('ghost'), now });
  assert.ok(!child.ok);
  assert.equal(child.error.message, '父任务不存在');
});

test('快照与 parentTaskId 不一致：拒绝', () => {
  const p = parent();
  const child = createTask({ projectId, title: '子任务', parent: p, parentTaskId: asTaskId('other'), now });
  assert.ok(!child.ok);
  assert.equal(child.error.message, '父任务与 parentTaskId 不一致');
});
