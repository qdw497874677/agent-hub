import { test, expect } from '@playwright/test';
import { TEST_EMAIL, testPassword } from './login.ts';
import { currentRun } from './run-id.ts';

test('没登录先看到登录页；测试账号登录后进主页，退出又回到登录页', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('tab', { name: '登录' })).toBeVisible();
  expect((await page.request.get('/api/projects')).status()).toBe(401);

  await page.getByLabel('邮箱').fill(TEST_EMAIL);
  await page.getByLabel('密码').fill('definitely wrong');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('alert')).toHaveText('邮箱或密码不对');

  await page.getByLabel('密码').fill(testPassword());
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByText('自带机器与 agent 的工作台')).toBeVisible();
  await page.getByRole('button', { name: '账号' }).click();
  await expect(page.getByText(TEST_EMAIL)).toBeVisible();
  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page.getByRole('tab', { name: '登录' })).toBeVisible();
});

test('手机宽度上注册一个新账号，直接进到主页', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('tab', { name: '注册' }).click();
  await page.getByLabel('邮箱').fill(`e2e-${currentRun()}@example.com`);
  await page.getByLabel('密码（至少 10 位）').fill('e2e password 123');
  await page.getByRole('button', { name: '注册并进入' }).click();
  await page.getByRole('button', { name: '账号' }).click();
  await expect(page.getByText('成员')).toBeVisible();
});
