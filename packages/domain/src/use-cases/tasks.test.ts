import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { createProjectUseCase } from './projects.ts';
import { createTaskUseCase, setTaskSummaryUseCase } from './tasks.ts';

test('createTaskUseCase 把 baseBranch 透传进任务；不传就是 null', async () => {
  const w = inMemoryDeps();
  const project = await createProjectUseCase(w.deps, { name: 'Demo' });
  assert.ok(project.ok);

  const plain = await createTaskUseCase(w.deps, { projectId: project.value.id, title: '普通任务' });
  assert.ok(plain.ok);
  assert.equal(plain.value.baseBranch, null);

  const bound = await createTaskUseCase(w.deps, {
    projectId: project.value.id,
    title: '从 release 开工',
    baseBranch: 'release'
  });
  assert.ok(bound.ok);
  assert.equal(bound.value.baseBranch, 'release');

  const stored = await w.deps.tasks.byId(bound.value.id);
  assert.equal(stored?.baseBranch, 'release');
});

test('createTaskUseCase 收到非法 baseBranch 时不建任务', async () => {
  const w = inMemoryDeps();
  const project = await createProjectUseCase(w.deps, { name: 'Demo' });
  assert.ok(project.ok);

  const bad = await createTaskUseCase(w.deps, { projectId: project.value.id, title: 't', baseBranch: 'bad branch' });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.error.code, 'invalid');
  assert.equal((await w.deps.tasks.listByProject(project.value.id)).length, 0);
});

test('改摘要不会动 baseBranch', async () => {
  const w = inMemoryDeps();
  const project = await createProjectUseCase(w.deps, { name: 'Demo' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: 't', baseBranch: 'develop' });
  assert.ok(task.ok);

  const changed = await setTaskSummaryUseCase(w.deps, task.value.id, '进展');
  assert.ok(changed.ok);
  assert.equal(changed.value.baseBranch, 'develop');
});
