import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeGlobalNavId, globalNavGroups } from './global-nav.ts';

test('分组顺序固定：工作台 → 消息 → 库 → 运维', () => {
  assert.deepEqual(
    globalNavGroups(true).map((group) => group.id),
    ['workbench', 'messages', 'library', 'ops']
  );
  assert.deepEqual(
    globalNavGroups(true).map((group) => group.label),
    ['工作台', '消息', '库', '运维']
  );
});

test('每组的项与顺序', () => {
  const groups = globalNavGroups(true);
  assert.deepEqual(
    groups.map((group) => group.items.map((item) => item.label)),
    // 「群聊」是导航项名，组标题仍是「消息」（同一页本来就是群列表）。
    // 可观测在库里：它没有角色门禁，不能靠运维组来「收口」。
    [['首页'], ['群聊', 'Bot'], ['记忆', '工作空间', '资产市场', '可观测'], ['运营后台']]
  );
});

test('可观测对所有人可见，运维组只剩管理员那一项', () => {
  const ids = (admin: boolean) =>
    globalNavGroups(admin).flatMap((group) => group.items.map((item) => item.id));

  assert.equal(ids(false).includes('observe'), true, '非管理员也能看到可观测（服务端没有门禁）');
  assert.equal(ids(false).includes('admin'), false);
  assert.equal(ids(true).includes('observe'), true);
  assert.equal(ids(true).includes('admin'), true);

  const ops = (admin: boolean) => globalNavGroups(admin).find((group) => group.id === 'ops');
  assert.equal(ops(false), undefined, '非管理员只少了运维组这一项，整组不出现');
  assert.deepEqual(
    ops(true)?.items.map((item) => item.id),
    ['admin'],
    '运维组里只有运营后台'
  );
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
