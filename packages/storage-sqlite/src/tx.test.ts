import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { inTransaction } from './tx.ts';

function demo() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER NOT NULL)');
  return db;
}

test('inTransaction：成功才提交，抛错整批回滚', () => {
  const db = demo();
  inTransaction(db, () => {
    db.prepare('INSERT INTO t VALUES (?, ?)').run('a', 1);
  });
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n, 1);

  assert.throws(() =>
    inTransaction(db, () => {
      db.prepare('INSERT INTO t VALUES (?, ?)').run('b', 2);
      throw new Error('boom');
    })
  );
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n, 1, '失败的那条不该留下');
  db.close();
});

test('inTransaction：事务体返回 Promise 直接回滚报错，避免 await 把提交拖出事务', () => {
  const db = demo();
  assert.throws(
    () =>
      inTransaction(db, (() => {
        db.prepare('INSERT INTO t VALUES (?, ?)').run('c', 3);
        return Promise.resolve('late');
      }) as unknown as () => string),
    /事务体不能是异步的/
  );
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n, 0);
  db.close();
});

test('inTransaction：嵌套调用会报 SQLite 的「事务里不能开事务」，不会悄悄提交外层', () => {
  const db = demo();
  assert.throws(() => {
    inTransaction(db, () => {
      inTransaction(db, () => {
        db.prepare('INSERT INTO t VALUES (?, ?)').run('d', 4);
      });
    });
  }, /transaction/i);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n, 0, '外层也要回滚干净');
  db.close();
});
