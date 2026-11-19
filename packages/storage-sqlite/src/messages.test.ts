import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asProjectId, asSessionId, type AgentMessage } from '@agent-hub/domain';
import { DatabaseSync } from 'node:sqlite';
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
    await store.messages.saveConfig({ projectId: asProjectId('p'), roles: [{ id: 'bot_qa', teamId: 'T', name: 'qa', description: '', ref: { runtime: 'pi', model: '', options: {} }, reuse: 'sticky', createdAt: 1, updatedAt: 1 }], limits: { maxDepth: 6 }, updatedAt: 1 });
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

test('会话通信 P1a：parts / wake / reply status / 已读 / 拦下原因往返；短名任务内唯一；老库补列', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-msg-'));
  try {
    const path = join(dir, 'hub.db');
    const store = openSqliteStore(path);
    await store.messages.save(base({ id: 'old', idempotencyKey: null }));
    // 模拟升级前的老库：把新列删掉，重开时要自动补回
    const raw = new DatabaseSync(path);
    for (const column of ['parts', 'wake', 'reply_status', 'reply_parts', 'read_at', 'hold_reason']) raw.exec(`ALTER TABLE agent_messages DROP COLUMN ${column}`);
    raw.close();
    const reopened = openSqliteStore(path);
    const old = await reopened.messages.byId('old');
    assert.equal(old?.wake, true);
    assert.deepEqual(old?.parts, []);
    await reopened.messages.save(base({
      id: 'n1', idempotencyKey: null, kind: 'send', status: 'held', holdReason: 'pingpong', wake: false,
      parts: [{ type: 'ref', repo: 'web', branch: 'feat/x' }]
    }));
    await reopened.messages.save(base({ id: 'r1', idempotencyKey: null, kind: 'reply', replyStatus: 'refused', replyParts: [{ type: 'link', url: 'https://x.test' }], readAt: 5 }));
    const n1 = await reopened.messages.byId('n1');
    assert.equal(n1?.status, 'held');
    assert.equal(n1?.holdReason, 'pingpong');
    assert.equal(n1?.wake, false);
    assert.deepEqual(n1?.parts, [{ type: 'ref', repo: 'web', branch: 'feat/x' }]);
    const r1 = await reopened.messages.byId('r1');
    assert.equal(r1?.replyStatus, 'refused');
    assert.equal(r1?.readAt, 5);
    assert.equal(r1?.replyParts?.[0]?.type, 'link');
    assert.deepEqual(await reopened.messages.pendingTargets(), [asSessionId('b')]);

    assert.equal(await reopened.messages.setHandle({ sessionId: asSessionId('a'), taskId: 't', handle: 'builder', updatedAt: 1 }), true);
    assert.equal(await reopened.messages.setHandle({ sessionId: asSessionId('b'), taskId: 't', handle: 'builder', updatedAt: 1 }), false);
    assert.equal(await reopened.messages.setHandle({ sessionId: asSessionId('b'), taskId: 'other', handle: 'builder', updatedAt: 1 }), true);
    assert.equal(await reopened.messages.setHandle({ sessionId: asSessionId('a'), taskId: 't', handle: 'maker', updatedAt: 2 }), true);
    assert.equal(await reopened.messages.handleOf(asSessionId('a')), 'maker');
    assert.equal(await reopened.messages.sessionByHandle('t', 'maker'), 'a');
    assert.equal(await reopened.messages.sessionByHandle('t', 'builder'), null);

    // LOW7：两个会话同时抢同一个短名，不靠先查再写——撞 (task_id, handle) 唯一索引的那个返回 false，表里只留一行
    const [first, second] = await Promise.all([
      reopened.messages.setHandle({ sessionId: asSessionId('s1'), taskId: 'race', handle: 'builder', updatedAt: 1 }),
      reopened.messages.setHandle({ sessionId: asSessionId('s2'), taskId: 'race', handle: 'builder', updatedAt: 1 })
    ]);
    assert.deepEqual([first, second].sort(), [false, true], '一个 true、一个 false');
    const winner = await reopened.messages.sessionByHandle('race', 'builder');
    assert.ok(winner === 's1' || winner === 's2');
    const counted = new DatabaseSync(path).prepare("SELECT COUNT(*) AS n FROM agent_session_handles WHERE task_id = 'race'").get() as { n: number };
    assert.equal(counted.n, 1, '表里只留一行：赢家拿短名，输家什么都没有');
    const loser = winner === 's1' ? 's2' : 's1';
    assert.equal(await reopened.messages.handleOf(asSessionId(loser)), null);

    // P1d：外部署名与外部收件箱
    await reopened.messages.save(base({ id: 'x1', idempotencyKey: null, kind: 'send', fromSessionId: asSessionId('external:tok_1'), fromLabel: '外部 · ci', createdAt: 20 }));
    await reopened.messages.save(base({ id: 'x2', idempotencyKey: null, kind: 'reply', to: 'external:tok_1', targetSessionId: null, status: 'done', createdAt: 21 }));
    assert.equal((await reopened.messages.byId('x1'))?.fromLabel, '外部 · ci');
    assert.deepEqual((await reopened.messages.toAddress('external:tok_1', 0, 10)).map((m) => m.id), ['x2']);
    assert.deepEqual(await reopened.messages.toAddress('external:tok_1', 21, 10), []);

    // P1f：trustPeers 落库；老配置行默认 false
    await reopened.messages.saveConfig({ projectId: asProjectId('p'), roles: [], limits: {}, updatedAt: 1 });
    assert.equal((await reopened.messages.config(asProjectId('p')))?.trustPeers, false);
    await reopened.messages.saveConfig({ projectId: asProjectId('p'), roles: [], limits: {}, trustPeers: true, updatedAt: 2 });
    assert.equal((await openSqliteStore(path).messages.config(asProjectId('p')))?.trustPeers, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
