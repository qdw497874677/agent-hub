import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asProjectId, asSessionId, type AgentMessage } from '@agent-hub/domain';
import { openSqliteStore } from './store.ts';

const base = (over: Partial<AgentMessage>): AgentMessage => ({
  id: 'm1', traceId: 't1', depth: 1, projectId: asProjectId('p'), kind: 'ask',
  fromSessionId: asSessionId('a'), onBehalfOf: 'alice', to: 'session:b', targetSessionId: asSessionId('b'),
  role: null, replyTo: null, body: 'q', status: 'queued', failure: null, failureDetail: null,
  replyBody: null, replySource: null, idempotencyKey: 'k', createdAt: 1, updatedAt: 1, deliveredAt: null, deadlineAt: 10,
  ...over
} as AgentMessage);

test('消息存储往返：排队 / 投递 / trace / 幂等 / 超时 / 配置 / 派生 / 审计，重开库还在', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-msg-'));
  try {
    const path = join(dir, 'hub.db');
    const store = openSqliteStore(path);
    await store.messages.save(base({}));
    await store.messages.save(base({ id: 'm2', kind: 'send', idempotencyKey: null, createdAt: 2, deadlineAt: null }));
    assert.deepEqual((await store.messages.queuedFor(asSessionId('b'))).map((m) => m.id), ['m1', 'm2']);
    await store.messages.save(base({ status: 'delivered', deliveredAt: 3, updatedAt: 3 }));
    assert.deepEqual((await store.messages.deliveredTo(asSessionId('b'))).map((m) => m.id), ['m1']);
    assert.equal((await store.messages.byIdempotencyKey(asSessionId('a'), 'k'))?.id, 'm1');
    assert.deepEqual((await store.messages.overdue(10)).map((m) => m.id), ['m1']);
    assert.deepEqual((await store.messages.overdue(9)).map((m) => m.id), []);
    assert.equal((await store.messages.byTrace('t1')).length, 2);
    assert.equal((await store.messages.forSession(asSessionId('a'), 10))[0]?.id, 'm2');
    await store.messages.saveConfig({ projectId: asProjectId('p'), roles: [{ name: 'qa', description: '', agentId: 'pi', model: '', reuse: 'sticky' }], limits: { maxDepth: 6 }, updatedAt: 1 });
    await store.messages.saveSpawn({ sessionId: asSessionId('c'), projectId: asProjectId('p'), role: 'qa', spawnerSessionId: asSessionId('a'), traceId: 't1', createdAt: 1 });
    await store.messages.audit({ id: 'e1', traceId: 't1', messageId: 'm1', projectId: asProjectId('p'), action: 'accepted', actor: 'a', onBehalfOf: 'alice', detail: 'x', at: 1 });
    const reopened = openSqliteStore(path);
    assert.equal((await reopened.messages.byId('m1'))?.status, 'delivered');
    assert.equal((await reopened.messages.config(asProjectId('p')))?.limits.maxDepth, 6);
    assert.equal((await reopened.messages.spawnOf(asSessionId('c')))?.spawnerSessionId, 'a');
    assert.equal((await reopened.messages.spawnsForRole(asProjectId('p'), 'qa')).length, 1);
    assert.equal((await reopened.messages.auditByTrace('t1'))[0]?.action, 'accepted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
