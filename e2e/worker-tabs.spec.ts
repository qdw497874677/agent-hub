import { test, expect } from '@playwright/test';
import { loginByApi } from './login.ts';

/**
 * 机器详情页签（WAI-ARIA tabs）：
 * - ←/→/Home/End 在页签间移动并同时激活，焦点跟着走，roving tabindex 只留一个 0；
 * - 详情是弹层里的视图，没有独立路由，所以页签记在 sessionStorage（每台机器一份）：
 *   退出去再点进来，还停在刚才那一页。
 */
test('机器详情页签：方向键切换，再进来还停在原页签', async ({ page }) => {
  await loginByApi(page);
  // 内嵌 worker 起来要几秒，等它先报到。
  let workers: { label: string }[] = [];
  for (let i = 0; i < 80; i += 1) {
    workers = (await (await page.request.get('/api/workers')).json()) as { label: string }[];
    if (workers.length > 0) break;
    await page.waitForTimeout(500);
  }
  expect(workers.length, '40 秒内至少要有一台机器').toBeGreaterThan(0);
  const label = workers[0]!.label;

  await page.goto('/');
  // 侧栏与窄屏抽屉各渲染一份，只有一份可见。
  await page.locator('button[aria-label^="机器"]:visible').click();
  const row = page.locator('li button').filter({ hasText: label });
  await row.first().click();
  await expect(page.getByTestId('worker-detail')).toBeVisible();

  const overview = page.getByTestId('worker-tab-overview');
  await overview.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('worker-tab-agent')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('worker-tab-agent')).toBeFocused();
  await expect(page.getByTestId('worker-tab-overview')).toHaveAttribute('tabindex', '-1');

  await page.keyboard.press('End');
  await expect(page.getByTestId('worker-tab-settings')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Home');
  await expect(page.getByTestId('worker-tab-overview')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('worker-tab-settings')).toHaveAttribute('aria-selected', 'true');

  // 退回列表再点进来：读 sessionStorage，还是「设置」。
  await page.getByLabel('返回机器列表').click();
  await row.first().click();
  await expect(page.getByTestId('worker-tab-settings')).toHaveAttribute('aria-selected', 'true');
});
