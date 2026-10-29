import { test } from 'node:test';
import assert from 'node:assert/strict';
import { breadcrumbs, visibleEntries } from './directory-path.ts';

test('面包屑从包含当前路径的 root 开始', () => {
  assert.deepEqual(breadcrumbs('/home/u/agent-hub/app', ['/home/u']), [
    { label: '~', path: '/home/u' },
    { label: 'agent-hub', path: '/home/u/agent-hub' },
    { label: 'app', path: '/home/u/agent-hub/app' }
  ]);
  assert.deepEqual(breadcrumbs('/srv/data/', ['/home/u', '/srv/data']), [{ label: 'data', path: '/srv/data' }]);
});

test('不被路径前缀骗；不在 roots 里就从 / 开始', () => {
  assert.deepEqual(breadcrumbs('/home/u2/x', ['/home/u']).map((c) => c.path), ['/', '/home', '/home/u2', '/home/u2/x']);
  assert.deepEqual(breadcrumbs('/', []), [{ label: '/', path: '/' }]);
  assert.deepEqual(breadcrumbs('/tmp/a', ['/tmp']).map((c) => c.label), ['tmp', 'a']);
});

import { filterEntries, fuzzyScore, splitInput, withSlash } from './directory-path.ts';

test('输入拆成目录 + 筛选片段', () => {
  assert.deepEqual(splitInput('/home/u/pro'), { dir: '/home/u', filter: 'pro' });
  assert.deepEqual(splitInput('/home/u/'), { dir: '/home/u', filter: '' });
  assert.deepEqual(splitInput('/tm'), { dir: '/', filter: 'tm' });
  assert.equal(withSlash('/a'), '/a/');
  assert.equal(withSlash('/'), '/');
});

test('模糊筛选：前缀优先，子序列也能命中，不匹配的去掉', () => {
  assert.ok((fuzzyScore('agent-hub', 'age') ?? 0) > (fuzzyScore('my-agent', 'age') ?? 0));
  assert.notEqual(fuzzyScore('agent-hub', 'ahb'), null);
  assert.equal(fuzzyScore('docs', 'xyz'), null);
  const names = filterEntries([{ name: 'my-agent' }, { name: 'docs' }, { name: 'agent-hub' }], 'agent').map((e) => e.name);
  assert.deepEqual(names, ['agent-hub', 'my-agent']);
  assert.deepEqual(filterEntries([{ name: 'b' }, { name: 'a' }], '').map((e) => e.name), ['b', 'a']);
});

test('隐藏目录默认收起，显示隐藏时全给', () => {
  const entries = [{ name: 'app' }, { name: '.config', hidden: true }];
  assert.deepEqual(visibleEntries(entries, false).map((e) => e.name), ['app']);
  assert.deepEqual(visibleEntries(entries, true).map((e) => e.name), ['app', '.config']);
});
