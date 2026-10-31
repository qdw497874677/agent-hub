import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRoute, parseRoute, type Route } from './route.ts';

test('空 hash 表示「没指定」，交给调用方决定（记住的上次项目 / 首页）', () => {
  assert.equal(parseRoute(''), null);
  assert.equal(parseRoute('#/'), null);
});

test('各种路由 format → parse 往返一致', () => {
  const routes: Route[] = [
    { page: 'home' },
    { page: 'admin', tab: 'users' },
    { page: 'assets', tab: 'mine', reviewId: null },
    { page: 'assets', tab: 'pending', reviewId: 's1' },
    { page: 'project', projectId: 'p1', view: 'canvas', sessionId: null },
    { page: 'project', projectId: 'p1', view: 'list', sessionId: 's9' },
    { page: 'project', projectId: 'p 中文', view: 'focus', sessionId: 's/1' }
  ];
  for (const route of routes) {
    const hash = formatRoute(route);
    assert.deepEqual(parseRoute(hash), route);
  }
});

test('不认识的视图回退画布；没有会话的 focus 也回退画布', () => {
  assert.deepEqual(parseRoute('#/p/p1/zzz'), { page: 'project', projectId: 'p1', view: 'canvas', sessionId: null });
  assert.deepEqual(parseRoute('#/p/p1/focus'), { page: 'project', projectId: 'p1', view: 'canvas', sessionId: null });
  assert.deepEqual(parseRoute('#/whatever'), { page: 'home' });
});

test('后台：#/admin 默认概览，不认识的分页也回概览', () => {
  assert.deepEqual(parseRoute('#/admin'), { page: 'admin', tab: 'overview' });
  assert.deepEqual(parseRoute('#/admin/zzz'), { page: 'admin', tab: 'overview' });
  assert.deepEqual(parseRoute('#/admin/audit'), { page: 'admin', tab: 'audit' });
});
