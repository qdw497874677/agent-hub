import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toolView } from './tool-format.ts';
import {
  MAX_PARAM_VALUE,
  continuesRun,
  runLength,
  startsRun,
  toolRowKind,
  toolRowLine,
  toolRowTitle,
  toolRunChip,
  type ToolRowProbe
} from './tool-rows.ts';

const probe = (kind: ToolRowProbe['kind'], ok: ToolRowProbe['ok'] = true): ToolRowProbe => ({ kind, ok });

test('聚合键：按「在干什么」分类，不同工具名归一', () => {
  const kind = (name: string, input: string) => toolRowKind(name, toolView(name, input));
  assert.equal(kind('bash', '{"command":"ls -la"}'), 'shell');
  assert.equal(kind('shell', '{"command":"ls"}'), 'shell');
  assert.equal(kind('read', '{"path":"a.ts"}'), 'read');
  assert.equal(kind('read_file', '{"path":"a.ts"}'), 'read');
  assert.equal(kind('edit', '{"path":"a.ts","oldString":"x","newString":"y"}'), 'edit');
  assert.equal(kind('write', '{"path":"a.ts","content":"x"}'), 'edit');
  assert.equal(kind('grep', '{"pattern":"needle","path":"src"}'), 'grep');
  assert.equal(kind('glob', '{"pattern":"*.ts","path":"src"}'), 'list');
  assert.equal(kind('webfetch', '{"url":"https://example.com"}'), 'fetch');
  assert.equal(kind('task', '{"agent":"explorer","description":"看目录"}'), 'agent');
  assert.equal(kind('plan', '{"plan":"先读代码"}'), 'plan');
  assert.equal(kind('create_worktree', '{"path":".worktrees/a"}'), 'other');
});

test('行内参数：最多 3 个 key=value，多的算 +N，title 保留全文', () => {
  const input = JSON.stringify({ path: 'src/app.ts', offset: 80, limit: 10, encoding: 'utf8', cache: false });
  const view = toolView('read', input);
  const line = toolRowLine(view, input);
  assert.deepEqual(
    line.pairs.map((param) => `${param.key}=${param.value}`),
    ['path=src/app.ts', 'offset=80', 'limit=10']
  );
  assert.equal(line.hidden, 2);
  // 全文一个都不能少
  for (const key of ['path', 'offset', 'limit', 'encoding', 'cache']) assert.match(line.title, new RegExp(`${key}=`));
  assert.match(toolRowTitle('read', line), /^read path=src\/app\.ts /);
});

test('行内参数：值截断成单行，title 留原样（含换行）', () => {
  const long = 'x'.repeat(MAX_PARAM_VALUE * 2);
  const input = JSON.stringify({ path: 'a.ts', newString: `第一行\n${long}` });
  const line = toolRowLine(toolView('edit', input), input);
  const param = line.pairs.find((item) => item.key === 'newString');
  assert.ok(param);
  assert.equal(param.value.includes('\n'), false);
  assert.ok(param.value.length <= MAX_PARAM_VALUE);
  assert.ok(param.value.endsWith('…'));
  assert.equal(param.title, `newString=第一行\n${long}`);
});

test('shell：命令放第一位、不带 key；其它参数跟在后面', () => {
  const input = JSON.stringify({ command: 'ls -la\nhead -3', cwd: '/tmp', timeout: 5000 });
  const line = toolRowLine(toolView('bash', input), input);
  assert.deepEqual(line.pairs[0], { key: '', value: 'ls -la head -3', title: 'ls -la\nhead -3' });
  assert.deepEqual(
    line.pairs.slice(1).map((param) => `${param.key}=${param.value}`),
    ['cwd=/tmp', 'timeout=5000']
  );
  assert.equal(line.hidden, 0);
  assert.match(line.title, /^ls -la\nhead -3 cwd=\/tmp/);
});

test('认不出的 input：原样露一行，不吞掉', () => {
  const line = toolRowLine(toolView('weird', 'not json'), 'not json');
  assert.deepEqual(line.pairs, [{ key: '', value: 'not json', title: 'not json' }]);
  assert.equal(line.hidden, 0);
  assert.equal(toolRowTitle('weird', line), 'weird not json');
});

test('聚合：连续同类才聚，换类打断', () => {
  const reads = [probe('read'), probe('read'), probe('read')];
  assert.equal(startsRun(null, reads[0]!), true);
  assert.equal(continuesRun(reads[0]!, reads[1]!), true);
  assert.equal(runLength(reads[0]!, reads.slice(1)), 3);
  assert.equal(continuesRun(reads[1]!, probe('grep')), false);
  assert.equal(runLength(reads[0]!, [probe('read'), probe('grep'), probe('read')]), 2);
});

test('聚合：文字 / 非工具行（null 探针）也打断', () => {
  assert.equal(runLength(probe('shell'), [probe('shell'), null, probe('shell')]), 2);
  assert.equal(continuesRun(null, probe('read')), false);
});

test('聚合：失败不聚，也不把前后两段接起来', () => {
  assert.equal(continuesRun(probe('read', true), probe('read', false)), false);
  assert.equal(continuesRun(probe('read', false), probe('read', true)), false);
  assert.equal(runLength(probe('read', true), [probe('read'), probe('read', false), probe('read')]), 2);
  assert.equal(runLength(probe('read', false), [probe('read'), probe('read')]), 1);
});

test('聚合：还在跑的（ok=null）算没失败', () => {
  assert.equal(continuesRun(probe('read'), probe('read', null)), true);
  assert.equal(runLength(probe('read', null), [probe('read', null), probe('read')]), 3);
});

test('组头文案：只有多行时才有', () => {
  assert.equal(toolRunChip('read', 1), '');
  assert.equal(toolRunChip('read', 2), 'read ×2');
  assert.equal(toolRunChip('grep', 12), 'grep ×12');
});
