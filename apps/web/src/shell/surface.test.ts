import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SURFACES, formatRoute, parseRoute } from './route.ts';
import { GLOBAL_NAV_ITEMS } from './global-nav.ts';

test('每个形态只认领自己的路由', () => {
  const im = SURFACES.find((surface) => surface.id === 'im');
  const workbench = SURFACES.find((surface) => surface.id === 'workbench');
  assert.ok(im && workbench);

  assert.deepEqual(im.parse(['bots']), { page: 'bots', projectId: null });
  assert.equal(im.parse(['p', 'proj', 'canvas']), null);
  assert.equal(workbench.parse(['bots']), null);
  assert.equal(workbench.parse(['messages']), null);
  assert.deepEqual(workbench.parse(['p', 'proj', 'focus', 'sess']), {
    page: 'project',
    projectId: 'proj',
    view: 'focus',
    sessionId: 'sess'
  });
  assert.deepEqual(im.parse(['messages', 'proj', 'g1']), { page: 'messages', projectId: 'proj', groupId: 'g1' });
});

test('导航项都能被路由解析并原样还原', () => {
  for (const item of GLOBAL_NAV_ITEMS) {
    const route = parseRoute(item.href);
    assert.ok(route, `${item.id} 的链接 ${item.href} 解析不出来`);
    assert.equal(route.page, item.page, `${item.id} 的 page 与链接不一致`);
    assert.equal(formatRoute(route), item.href, `${item.id} 的链接不能原样还原`);
  }
});

test('只有工作台认领首页', () => {
  const claimants = SURFACES.filter((surface) => surface.parse(['home']) !== null).map((surface) => surface.id);
  assert.deepEqual(claimants, ['workbench']);
});
