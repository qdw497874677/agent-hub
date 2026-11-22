import { test, expect } from '@playwright/test';
import { loginByApi } from './login.ts';

/**
 * 机器详情页签（WAI-ARIA tabs）与深链：
 * - ←/→/Home/End 在页签间移动并同时激活，焦点跟着走，roving tabindex 只留一个 0；
 * - 页签进 URL（`#/machines/<id>/<tab>`）：刷新、分享、浏览器后退都还在同一页；
 * - 不带页签进来时读 sessionStorage（每台机器一份），退回列表再点进来还停在刚才那一页。
 */
test('机器详情页签：方向键切换、页签进地址、再进来还停在原页签', async ({ page }) => {
  await loginByApi(page);
  // 手机宽：列表和详情是前后两屏，「返回机器列表」这一步才在界面上
  await page.setViewportSize({ width: 390, height: 844 });
  // 内嵌 worker 起来要几秒，等它先报到。
  let workers: { workerId: string; label: string }[] = [];
  for (let i = 0; i < 80; i += 1) {
    workers = (await (await page.request.get('/api/workers')).json()) as { workerId: string; label: string }[];
    if (workers.length > 0) break;
    await page.waitForTimeout(500);
  }
  expect(workers.length, '40 秒内至少要有一台机器').toBeGreaterThan(0);
  const label = workers[0]!.label;

  await page.goto('/');
  await page.getByRole('link', { name: /^机器：/ }).first().click();
  const row = page.getByTestId('machine-row').filter({ hasText: label }).getByRole('link');
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

  // 页签在地址里：刷新之后还是「设置」。
  await expect(page).toHaveURL(/#\/machines\/[^/]+\/settings$/);
  await page.reload();
  await expect(page.getByTestId('worker-tab-settings')).toHaveAttribute('aria-selected', 'true');

  // 退回列表（地址不带页签），再点进来：读 sessionStorage，还是「设置」。
  await page.getByLabel('返回机器列表').click();
  await expect(page.getByTestId('machine-row').first()).toBeVisible();
  await row.first().click();
  await expect(page.getByTestId('worker-tab-settings')).toHaveAttribute('aria-selected', 'true');
});
