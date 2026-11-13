import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeGlobalNavId, globalNavGroups } from './global-nav.ts';

test('分组顺序固定：工作 → 我的 → 团队 → 管理', () => {
  assert.deepEqual(
    globalNavGroups(true).map((group) => group.id),
    ['work', 'mine', 'team', 'manage']
  );
  assert.deepEqual(
    globalNavGroups(true).map((group) => group.label),
    ['工作', '我的', '团队', '管理']
  );
});

test('每组的项与顺序', () => {
  const groups = globalNavGroups(true);
  assert.deepEqual(
    groups.map((group) => group.items.map((item) => item.label)),
    [['首页'], ['记忆', '消息', 'Bot'], ['工作空间', '资产市场', '可观测'], ['运营后台']]
  );
});

test('非管理员看不到运营后台（管理组整组消失），可观测仍在团队组', () => {
  const member = globalNavGroups(false);
  const ids = member.flatMap((group) => group.items.map((item) => item.id));
  assert.equal(ids.includes('admin'), false);
  assert.equal(ids.includes('observe'), true, '可观测对所有人可见');
  assert.deepEqual(
    member.map((group) => group.id),
    ['work', 'mine', 'team'],
    '管理组只剩运营后台，非管理员时整组不出现'
  );

  const admin = globalNavGroups(true);
  const adminIds = admin.flatMap((group) => group.items.map((item) => item.id));
  assert.equal(adminIds.includes('admin'), true);
});

test('每个路由只高亮自己那一项', () => {
  const cases: Array<[string, string | null]> = [
    ['home', 'home'],
    ['memory', 'memory'],
    ['messages', 'messages'],
    ['bots', 'bots'],
    ['workspaces', 'workspaces'],
    ['assets', 'market'],
    ['observe', 'observe'],
    ['admin', 'admin'],
    ['project', null],
    ['nope', null]
  ];
  for (const [page, expected] of cases) {
    assert.equal(activeGlobalNavId(page), expected, page);
  }
  assert.equal(activeGlobalNavId(null), null);
  assert.equal(activeGlobalNavId(undefined), null);
});

test('链接都是仓里真实存在的路由', () => {
  assert.deepEqual(
    globalNavGroups(true)
      .flatMap((group) => group.items.map((item) => item.href))
      .sort(),
    ['#/admin/overview', '#/assets/catalog', '#/bots', '#/home', '#/memory', '#/messages', '#/observe', '#/workspaces'].sort()
  );
});
