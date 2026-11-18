import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asProjectId, asTaskId, createProject, createTask } from '@agent-hub/domain';
import { openSqliteStore } from './store.ts';

test('默认 Agent：写进去 -- 清成 null 要真的落库，不能被 upsert 忽略', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahub-default-agent-'));
  const store = openSqliteStore(join(dir, 'hub.db'));
  try {
    const made = createProject({
      name: 'p',
      now: 1,
      teamId: 't1',
      createdBy: 'u1',
      defaultAgent: { runtime: 'opencode', model: 'm1', options: { effort: 'high' } }
    });
    assert.ok(made.ok, JSON.stringify(made));
    await store.projects.save(made.value);
    assert.deepEqual((await store.projects.byId(asProjectId(made.value.id)))?.defaultAgent, {
      runtime: 'opencode',
      model: 'm1',
      options: { effort: 'high' }
    });

    // 清空：PATCH 走的就是「整个实体重新 save 一遍、defaultAgent 为 null」。
    await store.projects.save({ ...made.value, defaultAgent: null });
    assert.equal((await store.projects.byId(asProjectId(made.value.id)))?.defaultAgent ?? null, null);
    assert.equal((await store.projects.list())[0]?.defaultAgent ?? null, null);

    const task = createTask({ id: asTaskId('k1'), projectId: made.value.id, title: 't', now: 2 });
    assert.ok(task.ok);
    await store.tasks.save({ ...task.value, defaultAgent: { runtime: 'opencode', model: 'm2', options: {} } });
    assert.deepEqual((await store.tasks.byId(asTaskId('k1')))?.defaultAgent, {
      runtime: 'opencode',
      model: 'm2',
      options: {}
    });

    await store.tasks.save({ ...task.value, defaultAgent: null });
    assert.equal((await store.tasks.byId(asTaskId('k1')))?.defaultAgent ?? null, null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
