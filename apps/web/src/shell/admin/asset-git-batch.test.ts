import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_BATCH_ITEMS, combineGitBatch, parseGitBatch } from './asset-git-batch.ts';

test('批量拆分：一行一条，地址后面可选路径；空行跳过但行号照算', () => {
  const parsed = parseGitBatch(
    ['  https://github.com/o/r.git skills/foo ', '', 'git@github.com:o/other.git', '\t\n', 'https://github.com/o/three.git  '].join('\n')
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(
    parsed.items.map((item) => [item.line, item.url, item.path]),
    [
      [1, 'https://github.com/o/r.git', 'skills/foo'],
      [3, 'git@github.com:o/other.git', ''],
      [6, 'https://github.com/o/three.git', '']
    ]
  );
  assert.equal(parsed.items[0]?.raw, 'https://github.com/o/r.git skills/foo');
});

test('批量校验：路径里带空格（三段以上）报那一行', () => {
  const parsed = parseGitBatch('https://github.com/o/r.git skills/foo bar');
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.deepEqual(parsed.errors, ['第 1 行：一行只写「仓库地址 路径」，路径里不能有空格']);
});

test('批量校验：空输入、超过 20 条都拒绝，且不会丢掉不合法的行号', () => {
  const empty = parseGitBatch(' \n\n\t ');
  assert.deepEqual(empty, { ok: false, errors: ['至少填一行仓库地址'] });

  const many = Array.from({ length: MAX_BATCH_ITEMS + 2 }, (_, index) => `https://example.com/r${index}.git`).join('\n');
  const over = parseGitBatch(many);
  assert.equal(over.ok, false);
  if (over.ok) return;
  assert.deepEqual(over.errors, [`最多 ${MAX_BATCH_ITEMS} 条，现在有 ${MAX_BATCH_ITEMS + 2} 条`]);

  const mixed = parseGitBatch(`https://a.example/r.git\nhttps://b.example/r.git p q\nhttps://c.example/r.git`);
  assert.equal(mixed.ok, false);
  if (mixed.ok) return;
  assert.equal(mixed.errors.length, 1);
  assert.match(mixed.errors[0] ?? '', /^第 2 行：/);
});

test('批量结果配对：逐条成败、计数，失败的行原样留着重试', () => {
  const parsed = parseGitBatch('https://a.example/r.git x\nhttps://b.example/r.git y\nhttps://c.example/r.git');
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const combined = combineGitBatch(parsed.items, [
    { ok: true, id: 'a1', name: 'alpha' },
    { ok: false, error: '仓库是空的' }
    // 少一条：不能静默当成成功
  ]);
  assert.equal(combined.succeeded, 1);
  assert.equal(combined.failed, 2);
  assert.deepEqual(
    combined.outcomes.map((outcome) => [outcome.ok, outcome.url, outcome.name, outcome.error]),
    [
      [true, 'https://a.example/r.git', 'alpha', null],
      [false, 'https://b.example/r.git', null, '仓库是空的'],
      [false, 'https://c.example/r.git', null, '服务端没有返回这一条，再试一次']
    ]
  );
  assert.equal(combined.retryText, 'https://b.example/r.git y\nhttps://c.example/r.git');
});

test('批量结果配对：全成功时重试框是空的', () => {
  const parsed = parseGitBatch('https://a.example/r.git');
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const combined = combineGitBatch(parsed.items, [{ ok: true, name: 'alpha' }]);
  assert.equal(combined.succeeded, 1);
  assert.equal(combined.failed, 0);
  assert.equal(combined.retryText, '');
  assert.equal(combined.outcomes[0]?.name, 'alpha');
});
