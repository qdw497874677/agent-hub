import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asProjectId, asSessionId, canonicalLink } from '@agent-hub/domain';
import { openSqliteStore } from './store.ts';

test('会话连线存储：无向规范化、按项目和会话查、删除、按项目清理', async () => {
  const store = openSqliteStore(':memory:');
  const project = asProjectId('p1');
  const other = asProjectId('p2');
  const a = asSessionId('s-a');
  const b = asSessionId('s-b');
  const c = asSessionId('s-c');

  // 正反存两次：规范化后只有一行
  await store.links.save(canonicalLink(project, a, b, 'alice', 10));
  await store.links.save(canonicalLink(project, b, a, 'bob', 11));
  assert.equal((await store.links.listByProject(project)).length, 1);
  assert.equal(await store.links.areLinked(a, b), true);
  assert.equal(await store.links.areLinked(b, a), true);
  assert.equal(await store.links.areLinked(a, c), false);
  assert.deepEqual((await store.links.forSession(b)).map((link) => link.aSessionId), [a]);

  // 另一个项目、另一条关系
  await store.links.save(canonicalLink(other, a, c, null, 12));
  assert.equal((await store.links.listByProject(other)).length, 1);
  assert.equal((await store.links.forSession(a)).length, 2);

  await store.links.remove(project, b, a);
  assert.equal(await store.links.areLinked(a, b), false);
  assert.equal((await store.links.listByProject(other)).length, 1);

  await store.links.removeByProject(other);
  assert.equal((await store.links.listByProject(other)).length, 0);
  assert.equal((await store.links.forSession(a)).length, 0);
  store.close();
});
