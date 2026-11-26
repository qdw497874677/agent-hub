import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asProjectId, asSessionId, HANDOFF_BUS_ORIGIN, type AgentMessage } from '@agent-hub/domain';
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
    for (const column of ['parts', 'wake', 'reply_status', 'reply_parts', 'read_at', 'hold_reason', 'handoff_origin', 'initiator']) raw.exec(`ALTER TABLE agent_messages DROP COLUMN ${column}`);
    raw.close();
    const reopened = openSqliteStore(path);
    const old = await reopened.messages.byId('old');
    assert.equal(old?.wake, true);
    assert.deepEqual(old?.parts, []);
    assert.equal(old?.handoffOrigin, undefined, '老库补列后仍是来源未知');
    assert.equal(old?.initiator, undefined);
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

test('initiator is insert-only, persists across reopen and malformed historical values are unknown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-msg-'));
  try {
    const path = join(dir, 'hub.db');
    const store = openSqliteStore(path);
    await store.messages.save(base({ id: 'person', initiator: { kind: 'account', accountId: 'bob' } }));
    await store.messages.save(base({ id: 'person', initiator: { kind: 'session_tool' }, status: 'done' }));
    await store.messages.save(base({ id: 'legacy', idempotencyKey: null }));
    await store.messages.save(base({ id: 'legacy', idempotencyKey: null, initiator: { kind: 'system' }, status: 'done' }));
    assert.equal((await store.messages.byId('legacy'))?.initiator, undefined);
    for (const kind of ['session_tool', 'automatic_reply', 'external_token', 'system'] as const) {
      await store.messages.save(base({ id: kind, idempotencyKey: null, initiator: { kind } }));
    }
    const raw = new DatabaseSync(path);
    raw.prepare('UPDATE agent_messages SET initiator = ? WHERE id = ?').run('{"kind":"account"}', 'legacy');
    raw.close();
    const reopened = openSqliteStore(path);
    assert.deepEqual((await reopened.messages.byIdempotencyKey(asSessionId('a'), 'k'))?.initiator, { kind: 'account', accountId: 'bob' });
    assert.equal((await reopened.messages.byId('person'))?.status, 'done');
    assert.equal((await reopened.messages.byId('legacy'))?.initiator, undefined);
    for (const kind of ['session_tool', 'automatic_reply', 'external_token', 'system'] as const) {
      assert.deepEqual((await reopened.messages.byId(kind))?.initiator, { kind });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('VibeX P2：交接来源标记只认 Hub 写入的值；老行 / 未知值保持未知；状态重写不清标记', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-msg-'));
  try {
    const path = join(dir, 'hub.db');
    const store = openSqliteStore(path);

    // 普通发送：即使 data.schema 和交接消息一样，也没有来源标记
    await store.messages.save(base({
      id: 'ordinary', idempotencyKey: null, kind: 'send',
      parts: [{ type: 'data', schema: 'handoff/v1', data: { note: '看起来像交接' } }]
    }));
    const ordinary = await store.messages.byId('ordinary');
    assert.equal(ordinary?.handoffOrigin, undefined, '普通发送不推断来源');
    assert.equal(ordinary?.parts?.[0]?.type, 'data');

    // 交接入口写的标记能落库、重开库后还在
    await store.messages.save(base({ id: 'handed', idempotencyKey: null, kind: 'send', handoffOrigin: HANDOFF_BUS_ORIGIN }));
    assert.equal((await store.messages.byId('handed'))?.handoffOrigin, 'handoff_bus');

    // 后续状态重写（旧代码不会带这个字段）不能把已有标记清掉
    const marked = await store.messages.byId('handed');
    assert.ok(marked);
    await store.messages.save({ ...marked, status: 'done', handoffOrigin: undefined, updatedAt: 2 });
    const rewritten = await openSqliteStore(path).messages.byId('handed');
    assert.equal(rewritten?.status, 'done');
    assert.equal(rewritten?.handoffOrigin, 'handoff_bus', '重写保留交接标记');

    // 老库行（NULL）和伪造值都读成来源未知
    const raw = new DatabaseSync(path);
    const insert = raw.prepare(`INSERT INTO agent_messages
      (id, trace_id, depth, project_id, kind, from_session_id, on_behalf_of, to_address, body, status, created_at, updated_at, handoff_origin)
      VALUES (?, 't1', 1, 'p', 'send', 'a', 'alice', 'session:b', 'x', 'done', 1, 1, ?)`);
    insert.run('legacy', null);
    insert.run('forged', 'forged');
    raw.close();

    const reopened = openSqliteStore(path);
    assert.equal((await reopened.messages.byId('legacy'))?.handoffOrigin, undefined, '老行不猜来源');
    assert.equal((await reopened.messages.byId('forged'))?.handoffOrigin, undefined, '非 Hub 值不认');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('claimDelivered：只有 queued 能被认领一次，第二次返回 false', async () => {
  const store = openSqliteStore(join(mkdtempSync(join(tmpdir(), 'hub-msg-')), 'hub.db'));
  await store.messages.save(base({ id: 'once' }));
  assert.equal(await store.messages.claimDelivered!('once', 7), true);
  assert.equal(await store.messages.claimDelivered!('once', 8), false);
  const row = await store.messages.byId('once');
  assert.equal(row?.status, 'delivered');
  assert.equal(row?.deliveredAt, 7);
  assert.equal(row?.readAt, 7);
  assert.equal(await store.messages.claimDelivered!('missing', 9), false);
});

test('byCandidateSource：项目 + Hub 来源 + 候选 part 粗筛；坏 / 非数组 / 非对象元素不毒化查询', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-msg-'));
  try {
    const path = join(dir, 'hub.db');
    const store = openSqliteStore(path);
    const candidate = (source = 'exec') => [
      { type: 'data' as const, schema: 'project-candidate/v1', data: { sourceSessionId: source } }
    ];
    await store.messages.save(base({
      id: 'good', projectId: asProjectId('p'), kind: 'send', handoffOrigin: HANDOFF_BUS_ORIGIN,
      parts: candidate(), status: 'done', idempotencyKey: null
    }));
    await store.messages.save(base({
      id: 'other-project', projectId: asProjectId('q'), kind: 'send', handoffOrigin: HANDOFF_BUS_ORIGIN,
      parts: candidate(), idempotencyKey: null
    }));
    await store.messages.save(base({
      id: 'other-source', projectId: asProjectId('p'), kind: 'send', handoffOrigin: HANDOFF_BUS_ORIGIN,
      parts: candidate('someone-else'), idempotencyKey: null
    }));

    const raw = new DatabaseSync(path);
    const poison: Array<[string, string]> = [
      ['bad-json', 'not json'],
      ['array-of-strings', '["x", "{bad"]'],
      ['array-of-numbers', '[5, null, true]'],
      ['top-level-object', JSON.stringify({ type: 'data', schema: 'project-candidate/v1', data: { sourceSessionId: 'exec' } })],
      ['top-level-string', JSON.stringify('exec')],
      ['top-level-null', 'null']
    ];
    for (const [id, parts] of poison) {
      await store.messages.save(base({
        id, projectId: asProjectId('p'), kind: 'send', handoffOrigin: HANDOFF_BUS_ORIGIN,
        parts: candidate(), idempotencyKey: null
      }));
      raw.prepare('UPDATE agent_messages SET parts = ? WHERE id = ?').run(parts, id);
    }
    raw.close();

    const reopened = openSqliteStore(path);
    const rows = await reopened.messages.byCandidateSource(asProjectId('p'), asSessionId('exec'), 10);
    assert.deepEqual(rows.map((row) => row.id), ['good']);
    // 查询本身不因坏 parts 抛错；项目 / 来源 / 会话都对不上也不返回。
    assert.deepEqual(
      (await reopened.messages.byCandidateSource(asProjectId('q'), asSessionId('exec'), 10)).map((row) => row.id),
      ['other-project']
    );
    assert.deepEqual(
      (await reopened.messages.byCandidateSource(asProjectId('p'), asSessionId('missing'), 10)).map((row) => row.id),
      []
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
