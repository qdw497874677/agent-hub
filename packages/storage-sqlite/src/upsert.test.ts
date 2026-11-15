import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { upsertSql } from './upsert.ts';

test('upsertSql：重复写同一 id 只覆盖列出的列，后来加上的列保持原值', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE demo (id TEXT PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL)');
  db.exec("INSERT INTO demo (id, name, state) VALUES ('a', 'old', 'queued')");
  // 模拟一次迁移：表上后来加了列，老代码的写点还不知道它
  db.exec("ALTER TABLE demo ADD COLUMN note TEXT DEFAULT ''");
  db.exec("UPDATE demo SET note = '不要被清掉' WHERE id = 'a'");

  db.prepare(upsertSql('demo', ['id', 'name', 'state'])).run('a', 'new', 'done');

  const row = db.prepare('SELECT name, state, note FROM demo WHERE id = ?').get('a') as {
    name: string;
    state: string;
    note: string;
  };
  assert.equal(row.name, 'new');
  assert.equal(row.state, 'done');
  assert.equal(row.note, '不要被清掉', 'INSERT OR REPLACE 会先删整行，这里必须是按列更新');
  db.close();
});

test('upsertSql：不存在的行照常插入', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE demo (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
  db.prepare(upsertSql('demo', ['id', 'name'])).run('b', 'first');
  assert.deepEqual(
    (db.prepare('SELECT id, name FROM demo').all() as unknown[]).map((row) => ({ ...(row as object) })),
    [{ id: 'b', name: 'first' }]
  );
  db.close();
});

test('upsertSql：复合主键按 key 里列出的列匹配', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE demo (a TEXT NOT NULL, b INTEGER NOT NULL, body TEXT, PRIMARY KEY (a, b))');
  db.prepare(upsertSql('demo', ['a', 'b', 'body'], 'a, b')).run('x', 1, 'one');
  db.exec("ALTER TABLE demo ADD COLUMN extra TEXT DEFAULT 'keep'");
  db.prepare(upsertSql('demo', ['a', 'b', 'body'], 'a, b')).run('x', 1, 'two');
  const row = db.prepare('SELECT body, extra FROM demo WHERE a = ? AND b = ?').get('x', 1) as {
    body: string;
    extra: string;
  };
  assert.equal(row.body, 'two');
  assert.equal(row.extra, 'keep');
  db.close();
});
