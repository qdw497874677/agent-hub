import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { asProjectId, asSessionId, requestFingerprint, requestReplayKey } from '@agent-hub/domain';
import {
  createSqliteOperationReceipts,
  migrateOperationReceiptSchema
} from './operation-receipts.ts';

/**
 * 中立操作回执的精确范围测试：
 * - 单赢家占位 / 同键同参 pending；
 * - 不同指纹一律 conflict；
 * - complete / release 的 per-reservation CAS；
 * - pending 不因时间被接管；
 * - 关库重开后 pending / completed / token 仍可用；
 * - 自定义表注册幂等，且不碰已有的 request_receipts。
 */

const OPERATION = 'asset.candidate.import';
const SCOPE = {
  actorId: 'u1',
  sourceSessionId: asSessionId('s1'),
  projectId: asProjectId('p1'),
  operation: OPERATION
} as const;

function keyFor(requestKey: string, operation: string = OPERATION): string {
  return requestReplayKey({ ...SCOPE, operation }, requestKey);
}

function fingerprintFor(candidate: string): string {
  return requestFingerprint([`${OPERATION}.v1`, candidate, null]);
}

function intent(key: string, fingerprint: string) {
  return {
    key,
    fingerprint,
    actorId: SCOPE.actorId,
    sourceSessionId: SCOPE.sourceSessionId,
    projectId: SCOPE.projectId,
    operation: SCOPE.operation
  };
}

function tempWorld(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ahub-operation-receipts-'));
  return { dir, file: join(dir, 'hub.db') };
}

function open(file: string, clock?: Parameters<typeof createSqliteOperationReceipts>[1]) {
  const db = new DatabaseSync(file);
  const receipts = createSqliteOperationReceipts(db, clock);
  return { db, receipts };
}

type Receipts = ReturnType<typeof createSqliteOperationReceipts>;

async function reserveToken(receipts: Receipts, key: string, fingerprint: string): Promise<string> {
  const outcome = await receipts.reserve(intent(key, fingerprint));
  assert.equal(outcome.status, 'reserved');
  return outcome.status === 'reserved' ? outcome.reservationId : '';
}

test('reserve：单赢家拿到 token；同键同参第二次返回 pending，不接管', async () => {
  const { dir, file } = tempWorld();
  const { db, receipts } = open(file);
  try {
    const key = keyFor('req-1');
    const fp = fingerprintFor('candidate-1');
    const token = await reserveToken(receipts, key, fp);
    assert.ok(token);

    const second = await receipts.reserve(intent(key, fp));
    assert.equal(second.status, 'pending');

    const row = db
      .prepare('SELECT status, reservation_id FROM operation_receipts WHERE key = ?')
      .get(key) as { status: string; reservation_id: string } | undefined;
    assert.ok(row);
    assert.equal(row.status, 'pending');
    assert.equal(row.reservation_id, token);
    const count = db.prepare('SELECT COUNT(*) AS n FROM operation_receipts').get() as { n: number };
    assert.equal(count.n, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('同键异指纹：reserve / complete / release 全部 conflict，且不覆盖原占位', async () => {
  const { dir, file } = tempWorld();
  const { db, receipts } = open(file);
  try {
    const key = keyFor('req-1');
    const fp = fingerprintFor('candidate-1');
    const token = await reserveToken(receipts, key, fp);
    const otherFp = fingerprintFor('candidate-2');

    assert.equal((await receipts.reserve(intent(key, otherFp))).status, 'conflict');
    assert.equal(
      (await receipts.complete({ key, fingerprint: otherFp, reservationId: token, payload: { ok: true } })).status,
      'conflict'
    );
    assert.equal(
      (await receipts.release({ key, fingerprint: otherFp, reservationId: token })).status,
      'conflict'
    );

    // 原占位仍归第一个指纹 / token。
    const row = db
      .prepare('SELECT status, fingerprint, reservation_id FROM operation_receipts WHERE key = ?')
      .get(key) as { status: string; fingerprint: string; reservation_id: string };
    assert.equal(row.status, 'pending');
    assert.equal(row.fingerprint, fp);
    assert.equal(row.reservation_id, token);

    // 操作名进键：换操作不会串结果。
    const otherKey = keyFor('req-1', 'asset.write');
    assert.equal((await receipts.reserve(intent(otherKey, fp))).status, 'reserved');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('complete CAS：错 token / 错指纹不改状态；成功后幂等回放原 payload', async () => {
  const { dir, file } = tempWorld();
  const { db, receipts } = open(file);
  try {
    const key = keyFor('req-1');
    const fp = fingerprintFor('candidate-1');
    const token = await reserveToken(receipts, key, fp);
    const payload = { candidateId: 'cand-1', imported: 2, tags: ['a', 'b'], nested: { ok: true } };

    assert.equal(
      (await receipts.complete({ key, fingerprint: fp, reservationId: 'not-mine', payload })).status,
      'conflict'
    );
    assert.equal(
      (
        await receipts.complete({
          key,
          fingerprint: fingerprintFor('candidate-2'),
          reservationId: token,
          payload
        })
      ).status,
      'conflict'
    );
    const stillPending = db
      .prepare('SELECT status, payload FROM operation_receipts WHERE key = ?')
      .get(key) as { status: string; payload: string | null };
    assert.equal(stillPending.status, 'pending');
    assert.equal(stillPending.payload, null);

    const completed = await receipts.complete({ key, fingerprint: fp, reservationId: token, payload });
    assert.equal(completed.status, 'completed');

    const replay = await receipts.complete({ key, fingerprint: fp, reservationId: token, payload: { other: 1 } });
    assert.equal(replay.status, 'replayed');
    if (replay.status === 'replayed') assert.deepEqual(replay.payload, payload);

    const afterComplete = await receipts.reserve(intent(key, fp));
    assert.equal(afterComplete.status, 'completed');
    if (afterComplete.status === 'completed') assert.deepEqual(afterComplete.payload, payload);

    // 已完成行不能被换参数覆盖。
    assert.equal(
      (await receipts.complete({ key, fingerprint: fingerprintFor('candidate-2'), reservationId: token, payload }))
        .status,
      'conflict'
    );
    const row = db
      .prepare('SELECT status, payload FROM operation_receipts WHERE key = ?')
      .get(key) as { status: string; payload: string };
    assert.equal(row.status, 'completed');
    assert.deepEqual(JSON.parse(row.payload), payload);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pending 不设 TTL：时间大幅前进后仍是 pending，绝不被后来者接管', async () => {
  const { dir, file } = tempWorld();
  let clock = 1_000;
  let seq = 0;
  const { db, receipts } = open(file, {
    now: () => clock,
    newReservationId: () => `r${++seq}`
  });
  try {
    const key = keyFor('req-1');
    const fp = fingerprintFor('candidate-1');
    const token = await reserveToken(receipts, key, fp);
    assert.equal(token, 'r1');

    // 10 年后重试同一个请求：仍必须看到 pending，而不是接管。
    clock += 10 * 365 * 24 * 60 * 60 * 1_000;
    assert.equal((await receipts.reserve(intent(key, fp))).status, 'pending');
    const row = db
      .prepare('SELECT status, reservation_id, created_at FROM operation_receipts WHERE key = ?')
      .get(key) as { status: string; reservation_id: string; created_at: number };
    assert.equal(row.status, 'pending');
    assert.equal(row.reservation_id, 'r1');
    assert.equal(row.created_at, 1_000);

    // 只有原 token 能在任意晚的时间完成。
    assert.equal(
      (await receipts.complete({ key, fingerprint: fp, reservationId: token, payload: { done: true } })).status,
      'completed'
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('release CAS：错 token / 错指纹不删；命中后同键可重新 reserve，旧 token 失效', async () => {
  const { dir, file } = tempWorld();
  const { db, receipts } = open(file);
  try {
    const key = keyFor('req-1');
    const fp = fingerprintFor('candidate-1');
    const firstToken = await reserveToken(receipts, key, fp);

    assert.equal((await receipts.release({ key, fingerprint: fp, reservationId: 'not-mine' })).status, 'conflict');
    assert.equal(
      (await receipts.release({ key, fingerprint: fingerprintFor('candidate-2'), reservationId: firstToken })).status,
      'conflict'
    );
    assert.ok(db.prepare('SELECT 1 FROM operation_receipts WHERE key = ?').get(key));

    assert.equal((await receipts.release({ key, fingerprint: fp, reservationId: firstToken })).status, 'released');
    assert.equal(db.prepare('SELECT 1 FROM operation_receipts WHERE key = ?').get(key), undefined);
    assert.equal((await receipts.release({ key, fingerprint: fp, reservationId: firstToken })).status, 'conflict');

    // 明确无副作用后允许重试；这是新的 per-reservation 占位。
    const secondToken = await reserveToken(receipts, key, fp);
    assert.notEqual(secondToken, firstToken);
    assert.equal(
      (await receipts.complete({ key, fingerprint: fp, reservationId: firstToken, payload: { stale: true } })).status,
      'conflict'
    );
    assert.equal(
      (await receipts.complete({ key, fingerprint: fp, reservationId: secondToken, payload: { fresh: true } })).status,
      'completed'
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('已完成的行不可 release：release 返回 conflict，原结果保留', async () => {
  const { dir, file } = tempWorld();
  const { db, receipts } = open(file);
  try {
    const key = keyFor('req-1');
    const fp = fingerprintFor('candidate-1');
    const token = await reserveToken(receipts, key, fp);
    assert.equal(
      (await receipts.complete({ key, fingerprint: fp, reservationId: token, payload: { ok: true } })).status,
      'completed'
    );
    assert.equal((await receipts.release({ key, fingerprint: fp, reservationId: token })).status, 'conflict');

    const replay = await receipts.reserve(intent(key, fp));
    assert.equal(replay.status, 'completed');
    if (replay.status === 'completed') assert.deepEqual(replay.payload, { ok: true });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('关库重开：pending 仍是 pending，completed 原样回放，原 token 仍可完成', async () => {
  const { dir, file } = tempWorld();
  const pendingKey = keyFor('req-pending');
  const doneKey = keyFor('req-done');
  const pendingFp = fingerprintFor('candidate-pending');
  const doneFp = fingerprintFor('candidate-done');
  const donePayload = { assetId: 'asset-1', revision: 'rev-1' };
  let pendingToken = '';

  const first = open(file);
  try {
    pendingToken = await reserveToken(first.receipts, pendingKey, pendingFp);
    const doneToken = await reserveToken(first.receipts, doneKey, doneFp);
    assert.equal(
      (
        await first.receipts.complete({
          key: doneKey,
          fingerprint: doneFp,
          reservationId: doneToken,
          payload: donePayload
        })
      ).status,
      'completed'
    );
  } finally {
    first.db.close();
  }

  const second = open(file);
  try {
    assert.equal((await second.receipts.reserve(intent(pendingKey, pendingFp))).status, 'pending');
    const done = await second.receipts.reserve(intent(doneKey, doneFp));
    assert.equal(done.status, 'completed');
    if (done.status === 'completed') assert.deepEqual(done.payload, donePayload);

    assert.equal(
      (
        await second.receipts.reserve(intent(doneKey, fingerprintFor('candidate-other')))
      ).status,
      'conflict'
    );

    // 重开后原 reservation token 仍只属于这一次占位。
    assert.equal(
      (
        await second.receipts.complete({
          key: pendingKey,
          fingerprint: pendingFp,
          reservationId: pendingToken,
          payload: { imported: 1 }
        })
      ).status,
      'completed'
    );
    const replayed = await second.receipts.reserve(intent(pendingKey, pendingFp));
    assert.equal(replayed.status, 'completed');
    if (replayed.status === 'completed') assert.deepEqual(replayed.payload, { imported: 1 });
  } finally {
    second.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('schema 注册幂等：只建自己的表，不碰 request_receipts', async () => {
  const { dir, file } = tempWorld();
  const db = new DatabaseSync(file);
  try {
    migrateOperationReceiptSchema(db);
    migrateOperationReceiptSchema(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('operation_receipts', 'request_receipts')")
      .all() as { name: string }[];
    assert.deepEqual(tables.map((table) => table.name), ['operation_receipts']);

    const columns = db.prepare('PRAGMA table_info(operation_receipts)').all() as { name: string }[];
    const names = columns.map((column) => column.name);
    assert.ok(names.includes('reservation_id'));
    assert.ok(names.includes('payload'));
    assert.ok(names.includes('status'));

    // 空表可正常 reserve，证明注册后的 DDL 与适配器一致。
    const receipts = createSqliteOperationReceipts(db);
    const outcome = await receipts.reserve(intent(keyFor('req-1'), fingerprintFor('candidate-1')));
    assert.equal(outcome.status, 'reserved');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('payload 运行时校验：非普通对象被拒绝，占位保持 pending', async () => {
  const { dir, file } = tempWorld();
  const { db, receipts } = open(file);
  try {
    const key = keyFor('req-1');
    const fp = fingerprintFor('candidate-1');
    const token = await reserveToken(receipts, key, fp);

    await assert.rejects(
      receipts.complete({
        key,
        fingerprint: fp,
        reservationId: token,
        payload: [] as never
      }),
      TypeError
    );
    const row = db
      .prepare('SELECT status, payload FROM operation_receipts WHERE key = ?')
      .get(key) as { status: string; payload: string | null };
    assert.equal(row.status, 'pending');
    assert.equal(row.payload, null);

    assert.equal(
      (await receipts.complete({ key, fingerprint: fp, reservationId: token, payload: { ok: true } })).status,
      'completed'
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
