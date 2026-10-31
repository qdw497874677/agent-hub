import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asProjectId, asSessionId, type Group, type GroupDelivery } from '@agent-hub/domain';
import { openSqliteStore } from './store.ts';

const group: Group = {
  id: 'g1', projectId: asProjectId('p'), name: '群', members: ['coder'], hostRole: null, speakingStrategy: 'host',
  limits: { maxRounds: 3, maxMessages: 10 }, held: [], needsUser: false, createdBy: 'alice', createdAt: 1, updatedAt: 1
};
const delivery = (over: Partial<GroupDelivery>): GroupDelivery => ({
  id: 'd1', groupId: 'g1', threadId: 't1', round: 1, purpose: 'member', role: 'coder', sessionId: asSessionId('s1'),
  status: 'queued', result: null, score: null, prompt: 'p', note: '', createdAt: 5, deliveredAt: null, updatedAt: 5, ...over
});

test('群聊存储往返：群 / 消息 seq / 对话 / 投递队列 / 常驻会话，重开库还在', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-grp-'));
  try {
    const path = join(dir, 'hub.db');
    {
      const store = openSqliteStore(path);
      await store.groups.saveGroup(group);
      await store.groups.saveGroup({ ...group, name: '改名' });
      const a = await store.groups.appendPost({ id: 'p1', groupId: 'g1', threadId: null, round: 0, author: { kind: 'system' }, body: 'a', mentions: [], needsUser: false, createdAt: 1 });
      const b = await store.groups.appendPost({ id: 'p2', groupId: 'g1', threadId: 't1', round: 0, author: { kind: 'user', id: 'alice', name: 'alice' }, body: 'b', mentions: [], needsUser: false, createdAt: 2 });
      assert.deepEqual([a.seq, b.seq], [1, 2]);
      await store.groups.saveThread({ id: 't1', groupId: 'g1', rootPostId: 'p2', status: 'running', round: 1, messages: 0, createdAt: 2, updatedAt: 2 });
      await store.groups.saveDelivery(delivery({}));
      await store.groups.saveDelivery(delivery({ id: 'd2', status: 'delivered', createdAt: 6 }));
      await store.groups.setSession('g1', 'coder', asSessionId('s1'));
      store.close?.();
    }
    const store = openSqliteStore(path);
    assert.equal((await store.groups.group('g1'))?.name, '改名');
    assert.equal((await store.groups.groupsOf(asProjectId('p'))).length, 1);
    assert.deepEqual((await store.groups.posts('g1', null, 1)).map((p) => p.id), ['p2']);
    assert.deepEqual((await store.groups.posts('g1', 0, 10)).map((p) => p.seq), [1, 2]);
    assert.equal((await store.groups.runningThreads('g1')).length, 1);
    assert.deepEqual((await store.groups.queuedFor(asSessionId('s1'))).map((d) => d.id), ['d1']);
    assert.deepEqual((await store.groups.deliveredTo(asSessionId('s1'))).map((d) => d.id), ['d2']);
    assert.equal((await store.groups.openBefore(6)).length, 1);
    assert.equal(await store.groups.sessionFor('g1', 'coder'), 's1');
    assert.deepEqual(await store.groups.memberOfSession(asSessionId('s1')), { groupId: 'g1', role: 'coder' });
    assert.equal(await store.groups.memberOfSession(asSessionId('zz')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
