import { test, expect } from '@playwright/test';
import { TEST_EMAIL, mailedLink, testPassword, verifyByApi } from './login.ts';
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

test('手机宽度上注册新账号 → 先看到「去验证邮箱」→ 点信里的链接后进到主页', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const email = `e2e-${currentRun()}@example.com`;
  await page.goto('/');
  await page.getByRole('tab', { name: '注册' }).click();
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码（至少 10 位）').fill('e2e password 123');
  await page.getByRole('button', { name: '注册并进入' }).click();
  await expect(page.getByText('去验证邮箱')).toBeVisible();
  await expect(page.getByText('去 example.com 邮箱查收', { exact: false })).toBeVisible();
  expect((await page.request.get('/api/projects')).status()).toBe(403);

  await page.getByRole('button', { name: '重新发送验证邮件' }).click();
  await expect(page.getByRole('button', { name: /重新发送（\d+ 秒）/ })).toBeDisabled();

  await page.goto(await mailedLink(email));
  await expect(page.getByText('邮箱已验证')).toBeVisible();
  await page.getByRole('button', { name: '进入 agent-hub' }).click();
  await page.getByRole('button', { name: '账号' }).click();
  await expect(page.getByText('成员')).toBeVisible();
});

test('忘记密码：发重置信 → 点链接设新密码 → 直接登录，旧设备掉线', async ({ page, browser }) => {
  const email = `reset-${currentRun()}@example.com`;
  const other = await browser.newContext();
  expect((await other.request.post('/api/auth/register', { data: { email, password: 'old password 123' } })).ok()).toBe(true);

  await page.goto('/');
  await page.getByRole('button', { name: '忘记密码？' }).click();
  await page.getByLabel('邮箱').fill(email);
  await page.getByRole('button', { name: '发送重置邮件' }).click();
  await expect(page.getByText('去邮箱看看')).toBeVisible();

  await page.goto(await mailedLink(email, 'reset'));
  await page.getByLabel('新密码（至少 10 位）').fill('new password 456');
  await page.getByLabel('再输一遍').fill('new password 456');
  await page.getByRole('button', { name: '保存并登录' }).click();
  await expect(page.getByText('密码已更新')).toBeVisible();
  expect((await other.request.get('/api/auth/state').then((r) => r.json())).user).toBeNull();
  await page.getByRole('button', { name: '进入 agent-hub' }).click();
  await expect(page.getByText('自带机器与 agent 的工作台')).toBeVisible(); // 重置即验证
  await other.close();
});

test('登录设备：看到两台，「登出其他所有设备」把另一台踢掉', async ({ page, browser }) => {
  const email = `devices-${currentRun()}@example.com`;
  const password = 'device password 1';
  const other = await browser.newContext();
  expect((await other.request.post('/api/auth/register', { data: { email, password } })).ok()).toBe(true);
  await verifyByApi(other.request, email);
  await page.goto('/');
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录' }).click();
  await page.getByRole('button', { name: '账号' }).click();
  await page.getByRole('button', { name: '登录设备' }).click();
  const dialog = page.getByRole('dialog', { name: '登录设备' });
  await expect(dialog.getByRole('listitem')).toHaveCount(2);
  await expect(dialog.getByText('这台')).toBeVisible();
  await dialog.getByRole('button', { name: '登出其他所有设备' }).click();
  await expect(dialog.getByRole('listitem')).toHaveCount(1);
  expect((await other.request.get('/api/projects')).status()).toBe(401);
  await other.close();
});
