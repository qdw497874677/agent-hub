import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DelegationAcceptanceInput } from '@agent-hub/domain';
import { createSqliteDelegationAcceptances } from './delegation-acceptance.ts';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function acceptance(over: Partial<DelegationAcceptanceInput> = {}): DelegationAcceptanceInput {
  return {
    delegationId: 'dlg-1',
    requestKey: 'k1',
    sha: SHA_A,
    actorId: 'user-1',
    createdAt: 100,
    note: '看过了',
    ...over
  };
}

/** 故意构造非法输入，绕过编译期类型检查走运行时校验。 */
function invalid(over: Record<string, unknown>): DelegationAcceptanceInput {
  return { ...acceptance(), ...over } as unknown as DelegationAcceptanceInput;
}

test('append：首条 created，字段原样保存，byRequest 精确命中', async () => {
  const store = createSqliteDelegationAcceptances(new DatabaseSync(':memory:'));
  const result = await store.append(acceptance());
  assert.equal(result.outcome, 'created');
  assert.deepEqual(result.record, {
    delegationId: 'dlg-1',
    requestKey: 'k1',
    sha: SHA_A,
    actorId: 'user-1',
    createdAt: 100,
    note: '看过了'
  });
  assert.deepEqual(await store.byRequest('dlg-1', 'k1'), result.record);
  assert.equal(await store.byRequest('dlg-1', 'k2'), null);
  assert.equal(await store.byRequest('dlg-2', 'k1'), null);
});

test('同键同内容重放：返回原记录，不刷新 createdAt，不新增历史', async () => {
  const store = createSqliteDelegationAcceptances(new DatabaseSync(':memory:'));
  const first = await store.append(acceptance());
  assert.equal(first.outcome, 'created');

  const replayed = await store.append(acceptance({ createdAt: 999 }));
  assert.equal(replayed.outcome, 'replayed');
  assert.deepEqual(replayed.record, first.record);
  assert.equal(replayed.record.createdAt, 100);

  // 省略 note 与显式 null 是同一内容（单独一个键，避免与上面的备注比较混淆）。
  const noNote = await store.append(acceptance({ requestKey: 'k-note', note: undefined }));
  const nullNote = await store.append(acceptance({ requestKey: 'k-note', note: null }));
  assert.equal(noNote.outcome, 'created');
  assert.equal(nullNote.outcome, 'replayed');
  assert.equal(nullNote.record.note, null);
  assert.equal((await store.history('dlg-1')).length, 2);
});

test('同键异内容一律 conflict：SHA / 验收人 / 备注任一不同都不覆盖', async () => {
  const store = createSqliteDelegationAcceptances(new DatabaseSync(':memory:'));
  const first = await store.append(acceptance());

  const shaConflict = await store.append(acceptance({ sha: SHA_B }));
  assert.equal(shaConflict.outcome, 'conflict');
  assert.deepEqual(shaConflict.record, first.record);

  const actorConflict = await store.append(acceptance({ actorId: 'user-2' }));
  assert.equal(actorConflict.outcome, 'conflict');
  assert.deepEqual(actorConflict.record, first.record);

  const noteConflict = await store.append(acceptance({ note: '换个备注' }));
  assert.equal(noteConflict.outcome, 'conflict');
  assert.deepEqual(noteConflict.record, first.record);

  const emptyNote = await store.append(acceptance({ note: '' }));
  assert.equal(emptyNote.outcome, 'conflict');
  assert.deepEqual(emptyNote.record, first.record);

  assert.equal((await store.history('dlg-1')).length, 1);
  assert.deepEqual(await store.byRequest('dlg-1', 'k1'), first.record);
});

test('null 备注与空字符串备注是不同内容', async () => {
  const store = createSqliteDelegationAcceptances(new DatabaseSync(':memory:'));
  const nullNote = await store.append(acceptance({ requestKey: 'k-null', note: null }));
  assert.equal(nullNote.outcome, 'created');
  assert.equal(nullNote.record.note, null);

  const emptyNote = await store.append(acceptance({ requestKey: 'k-null', note: '' }));
  assert.equal(emptyNote.outcome, 'conflict');
  assert.equal(emptyNote.record.note, null);
});

test('不同派工的同一请求键互不占键', async () => {
  const store = createSqliteDelegationAcceptances(new DatabaseSync(':memory:'));
  await store.append(acceptance());
  const other = await store.append(acceptance({ delegationId: 'dlg-2', sha: SHA_B, actorId: 'user-2' }));
  assert.equal(other.outcome, 'created');
  assert.equal(other.record.delegationId, 'dlg-2');
  assert.equal((await store.history('dlg-1')).length, 1);
  assert.equal((await store.history('dlg-2')).length, 1);
});

test('非法输入直接抛错且不落行：完整小写 40 位 SHA、非空标识、合法时间与备注', async () => {
  const store = createSqliteDelegationAcceptances(new DatabaseSync(':memory:'));

  const cases: DelegationAcceptanceInput[] = [
    invalid({ sha: 'A'.repeat(40) }),
    invalid({ sha: 'a'.repeat(39) }),
    invalid({ sha: 'a'.repeat(41) }),
    invalid({ sha: `${'a'.repeat(39)}g` }),
    invalid({ sha: 'a'.repeat(64) }),
    invalid({ sha: 'HEAD' }),
    invalid({ sha: '' }),
    invalid({ delegationId: '' }),
    invalid({ requestKey: '' }),
    invalid({ actorId: '' }),
    invalid({ createdAt: -1 }),
    invalid({ createdAt: 1.5 }),
    invalid({ createdAt: Number.NaN }),
    invalid({ note: 7 })
  ];
  for (const input of cases) {
    await assert.rejects(store.append(input), TypeError);
  }
  assert.equal((await store.history('dlg-1')).length, 0);
  assert.equal(await store.byRequest('dlg-1', 'k1'), null);

  // 同一键的合法重试仍可正常建立，说明失败调用没有留下占位。
  const ok = await store.append(acceptance());
  assert.equal(ok.outcome, 'created');
});

test('history：按追加顺序返回最近 N 条，不受 createdAt 大小影响，并有硬上限', async () => {
  const store = createSqliteDelegationAcceptances(new DatabaseSync(':memory:'));

  // createdAt 故意倒序，证明稳定顺序来自插入顺序（seq），不是时间字段。
  await store.append(acceptance({ requestKey: 'k1', createdAt: 500 }));
  await store.append(acceptance({ requestKey: 'k2', createdAt: 400 }));
  await store.append(acceptance({ requestKey: 'k3', createdAt: 300 }));
  await store.append(acceptance({ requestKey: 'k4', createdAt: 200 }));
  await store.append(acceptance({ requestKey: 'k5', createdAt: 100 }));

  const recent = await store.history('dlg-1', 3);
  assert.deepEqual(recent.map((record) => record.requestKey), ['k3', 'k4', 'k5']);
  assert.deepEqual(recent.map((record) => record.createdAt), [300, 200, 100]);

  assert.equal((await store.history('dlg-1')).length, 5);
  assert.deepEqual((await store.history('dlg-missing')), []);

  for (const limit of [0, -1, 1.5, Number.NaN]) {
    await assert.rejects(store.history('dlg-1', limit), TypeError);
  }

  // 硬上限 200：多写也不会一次拉走全部历史。
  const bulk = createSqliteDelegationAcceptances(new DatabaseSync(':memory:'));
  for (let i = 0; i < 205; i += 1) {
    const outcome = await bulk.append(acceptance({ requestKey: `h${i}`, createdAt: i }));
    assert.equal(outcome.outcome, 'created');
  }
  const capped = await bulk.history('dlg-1', 5000);
  assert.equal(capped.length, 200);
  assert.equal(capped[0]?.requestKey, 'h5');
  assert.equal(capped.at(-1)?.requestKey, 'h204');
});

test('latestForSha：精确 SHA 查询独立于 history 窗口，并取该 SHA 的最后一条', async () => {
  const store = createSqliteDelegationAcceptances(new DatabaseSync(':memory:'));

  // A 是最早的一条，随后写入 205 条 B；history 的 200 条窗口里已经没有 A。
  await store.append(acceptance({ requestKey: 'k-a1', sha: SHA_A, createdAt: 999 }));
  for (let i = 0; i < 205; i += 1) {
    await store.append(acceptance({ requestKey: `b${i}`, sha: SHA_B, createdAt: i }));
  }
  const window = await store.history('dlg-1', 5000);
  assert.equal(window.length, 200);
  assert.equal(window.some((record) => record.sha === SHA_A), false);

  const old = await store.latestForSha('dlg-1', SHA_A);
  assert.equal(old?.requestKey, 'k-a1');
  assert.equal(old?.sha, SHA_A);

  // 同一 SHA 的更新记录按 seq 取最后一条，不按 createdAt（这里故意更小）。
  await store.append(acceptance({ requestKey: 'k-a2', sha: SHA_A, createdAt: 0 }));
  const latest = await store.latestForSha('dlg-1', SHA_A);
  assert.equal(latest?.requestKey, 'k-a2');
  assert.equal(latest?.createdAt, 0);

  assert.equal(await store.latestForSha('dlg-2', SHA_A), null);
  assert.equal(await store.latestForSha('dlg-1', 'c'.repeat(40)), null);
});

test('latestForSha：建立 (delegation_id, sha, seq) 索引', () => {
  const db = new DatabaseSync(':memory:');
  createSqliteDelegationAcceptances(db);
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'delegation_acceptance'")
    .all() as unknown as { name: string }[];
  assert.ok(names.some((row) => row.name === 'delegation_acceptance_sha'));
  const columns = db
    .prepare("SELECT name FROM pragma_index_info('delegation_acceptance_sha') ORDER BY seqno")
    .all() as unknown as { name: string }[];
  assert.deepEqual(columns.map((row) => row.name), ['delegation_id', 'sha', 'seq']);
});

test('跨连接：唯一约束串行化同键写入，后来者只能重放或 conflict', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-acceptance-'));
  const file = join(dir, 'acceptance.db');
  try {
    const a = new DatabaseSync(file);
    const b = new DatabaseSync(file);
    const storeA = createSqliteDelegationAcceptances(a);
    const storeB = createSqliteDelegationAcceptances(b);

    assert.equal((await storeA.append(acceptance())).outcome, 'created');
    // 第二个连接看到的是已提交的那条：同内容重放、异内容 conflict，都不会再建一行。
    const replayed = await storeB.append(acceptance({ createdAt: 777 }));
    assert.equal(replayed.outcome, 'replayed');
    assert.equal(replayed.record.createdAt, 100);

    const conflicted = await storeB.append(acceptance({ sha: SHA_B }));
    assert.equal(conflicted.outcome, 'conflict');
    assert.deepEqual(conflicted.record, replayed.record);
    assert.equal((await storeA.history('dlg-1')).length, 1);

    // 关闭并重开：记录仍在，迁移可重复执行，不改写已有行。
    a.close();
    const reopened = new DatabaseSync(file);
    const storeC = createSqliteDelegationAcceptances(reopened);
    const afterReopen = await storeC.byRequest('dlg-1', 'k1');
    assert.deepEqual(afterReopen, replayed.record);
    assert.equal((await storeC.append(acceptance({ createdAt: 555 }))).outcome, 'replayed');
    assert.equal((await storeC.history('dlg-1')).length, 1);
    reopened.close();
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('只增表：重复建存储不丢记录，也不改任务等其它表', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE task (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
  db.exec("INSERT INTO task (id, state) VALUES ('t1', 'pending')");

  const first = createSqliteDelegationAcceptances(db);
  await first.append(acceptance());

  // 再次注册 schema（例如服务重启 / 按需打开）必须幂等，不重建、不清空。
  const second = createSqliteDelegationAcceptances(db);
  assert.deepEqual(await second.byRequest('dlg-1', 'k1'), (await first.byRequest('dlg-1', 'k1')));
  assert.equal((await second.append(acceptance())).outcome, 'replayed');

  const task = db.prepare('SELECT id, state FROM task').get() as { id: string; state: string };
  assert.equal(task.id, 't1');
  assert.equal(task.state, 'pending');

  // 没有旧记录可推断：只建新表，不存在的历史就是空，不从别的表猜。
  assert.deepEqual(await second.history('dlg-legacy'), []);
});
