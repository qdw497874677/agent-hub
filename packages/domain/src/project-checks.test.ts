import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECK_COMMANDS_MAX, CHECK_COMMAND_MAX, createProject, normalizeChecks } from './project.ts';
import { inMemoryDeps } from './testing/in-memory.ts';
import { createProjectUseCase, setProjectChecksUseCase } from './use-cases/projects.ts';

test('normalizeChecks：trim、丢空串、顺序保留', () => {
  const result = normalizeChecks(['  npm run typecheck ', '', '   ', 'npm test']);
  assert.ok(result.ok);
  assert.deepEqual(result.value, ['npm run typecheck', 'npm test']);
});

test('normalizeChecks：空数组 = 没配', () => {
  const result = normalizeChecks([]);
  assert.ok(result.ok);
  assert.deepEqual(result.value, []);
});

test('normalizeChecks：非数组 / 换行 / 超长 / 超条数都拒绝', () => {
  const notArray = normalizeChecks('npm test');
  assert.equal(notArray.ok, false);
  assert.equal(notArray.ok ? '' : notArray.error.message, '检查命令要给一个字符串数组');

  const newline = normalizeChecks(['npm test\nnpm run build']);
  assert.equal(newline.ok, false);
  assert.equal(newline.ok ? '' : newline.error.message, '检查命令不能换行：一条命令占一行');

  const carriage = normalizeChecks(['npm test\r']);
  assert.equal(carriage.ok, false);

  const tooLong = normalizeChecks(['x'.repeat(CHECK_COMMAND_MAX + 1)]);
  assert.equal(tooLong.ok, false);

  const tooMany = normalizeChecks(Array.from({ length: CHECK_COMMANDS_MAX + 1 }, (_, i) => `cmd-${i}`));
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.ok ? '' : tooMany.error.message, `检查命令最多 ${CHECK_COMMANDS_MAX} 条`);

  // 空串不算一条：5 条 + 一堆空串仍然合法
  const padded = normalizeChecks(['', ' ', ...Array.from({ length: CHECK_COMMANDS_MAX }, (_, i) => `cmd-${i}`), '']);
  assert.ok(padded.ok);
  assert.equal(padded.value.length, CHECK_COMMANDS_MAX);
});

test('createProject：检查命令默认是 []', () => {
  const created = createProject({ name: 'demo', now: 1 });
  assert.ok(created.ok);
  assert.deepEqual(created.value.checks, []);
});

test('createProjectUseCase：新建项目 checks = []；setProjectChecksUseCase 能写回并读回', async () => {
  const w = inMemoryDeps();
  const created = await createProjectUseCase(w.deps, { name: 'demo' });
  assert.ok(created.ok);
  assert.deepEqual(created.value.checks, []);

  const updated = await setProjectChecksUseCase(w.deps, { projectId: created.value.id, checks: ['npm run typecheck', ' npm test '] });
  assert.ok(updated.ok, updated.ok ? '' : updated.error.message);
  assert.deepEqual(updated.value.checks, ['npm run typecheck', 'npm test']);

  const reloaded = await w.deps.projects.byId(created.value.id);
  assert.deepEqual(reloaded?.checks, ['npm run typecheck', 'npm test']);
  // 其他字段不受影响
  assert.equal(reloaded?.name, 'demo');

  const cleared = await setProjectChecksUseCase(w.deps, { projectId: created.value.id, checks: [] });
  assert.ok(cleared.ok);
  assert.deepEqual(cleared.value.checks, []);
  assert.deepEqual((await w.deps.projects.byId(created.value.id))?.checks, []);

  const missing = await setProjectChecksUseCase(w.deps, { projectId: 'prj_missing', checks: [] });
  assert.equal(missing.ok, false);
});
