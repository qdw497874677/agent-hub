import { test } from 'node:test';
import assert from 'node:assert/strict';
import { breadcrumbs } from './directory-path.ts';

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
