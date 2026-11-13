import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_PAGE_TABS, resolveAdminTab } from './tabs.ts';

test('后台分页：六项、顺序固定、组件写作运行时组件', () => {
  assert.deepEqual(
    ADMIN_PAGE_TABS.map((tab) => tab.id),
    ['overview', 'users', 'workers', 'assets', 'components', 'audit']
  );
  assert.deepEqual(
    ADMIN_PAGE_TABS.map((tab) => tab.label),
    ['概览', '用户', '机器', '资产', '运行时组件', '审计']
  );
});

test('后台分页：设置不再是分页，旧地址落到概览', () => {
  assert.equal(ADMIN_PAGE_TABS.some((tab) => tab.id === 'settings'), false);
  assert.equal(resolveAdminTab('settings'), 'overview');
  for (const tab of ADMIN_PAGE_TABS.map((item) => item.id)) assert.equal(resolveAdminTab(tab), tab);
});
