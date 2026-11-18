import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createAgentDefaultsStore } from './agent-defaults.ts';

const open = () => createAgentDefaultsStore(new DatabaseSync(':memory:'));

test('团队默认模型：按团队独立存，空表读成 {}', async () => {
  const store = open();
  assert.deepEqual(await store.forTeam('t1'), {});
  await store.save('t1', { opencode: 'go-deepseek-v4.1-flash', codex: 'gpt-5.5' });
  await store.save('t2', { opencode: 'other' });
  assert.deepEqual(await store.forTeam('t1'), { opencode: 'go-deepseek-v4.1-flash', codex: 'gpt-5.5' });
  assert.deepEqual(await store.forTeam('t2'), { opencode: 'other' });
  // 再存是覆盖，不是追加
  await store.save('t1', { codex: 'gpt-5.5' });
  assert.deepEqual(await store.forTeam('t1'), { codex: 'gpt-5.5' });
  await store.save('t1', {});
  assert.deepEqual(await store.forTeam('t1'), {});
});

test('坏 JSON / 非对象：当没有默认，不让开会话失败', async () => {
  const db = new DatabaseSync(':memory:');
  const store = createAgentDefaultsStore(db);
  db.prepare('INSERT INTO agent_defaults (team_id, models) VALUES (?, ?)').run('bad', 'not json');
  db.prepare('INSERT INTO agent_defaults (team_id, models) VALUES (?, ?)').run('arr', '[1,2]');
  assert.deepEqual(await store.forTeam('bad'), {});
  assert.deepEqual(await store.forTeam('arr'), {});
});
