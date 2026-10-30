import { test, expect } from '@playwright/test';
import { TEST_EMAIL, loginByApi, mailedLink, testPassword } from './login.ts';
import { currentRun } from './run-id.ts';

const PASSWORD = 'invited pw 12345';

test('团队主人邀请成员 → 点信里的链接设密码加入 → 主人在团队里删掉 TA', async ({ page, browser }) => {
  const email = `invitee-${currentRun()}@example.com`;
  await loginByApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: '账号' }).click();
  await page.getByRole('button', { name: '我的团队' }).click();
  await page.getByLabel('邀请新成员（对方会收到一封邀请信，7 天内有效）').fill(email);
  await page.getByRole('button', { name: '发送邀请' }).click();
  await expect(page.getByText('邀请已发出。')).toBeVisible();
  await expect(page.getByTestId('team-invite').filter({ hasText: email })).toBeVisible();
  await page.screenshot({ path: '/workspace/shots/users/team-invite.png' });

  const guest = await browser.newContext();
  const invitee = await guest.newPage();
  await invitee.goto(await mailedLink(email, 'invite'));
  await expect(invitee.getByText(email)).toBeVisible();
  await invitee.getByLabel('名字（可留空）').fill('受邀者');
  await invitee.getByLabel('密码（至少 10 位）').fill(PASSWORD);
  await invitee.getByLabel('再输一遍').fill(PASSWORD);
  await invitee.screenshot({ path: '/workspace/shots/users/invite-accept.png' });
  await invitee.getByRole('button', { name: '加入并登录' }).click();
  await invitee.getByRole('button', { name: '账号' }).click();
  await expect(invitee.getByText('受邀者').first()).toBeVisible();
  await expect(invitee.getByText('成员', { exact: true })).toBeVisible();

  // 主人刷新团队，删掉 TA：对方掉线、不能再登录
  await page.reload();
  await page.getByRole('button', { name: '账号' }).click();
  await page.getByRole('button', { name: '我的团队' }).click();
  const row = page.getByTestId('team-member').filter({ hasText: email });
  await expect(row).toBeVisible();
  page.once('dialog', (dialog) => void dialog.accept());
  await row.getByRole('button', { name: '删除' }).click();
  await expect(row).toHaveCount(0);
  expect((await invitee.request.get('/api/projects')).status()).toBe(401);
  const relogin = await guest.request.post('/api/auth/login', { data: { email, password: PASSWORD } });
  expect(relogin.status()).toBe(400);
  await guest.close();
});

test('个人设置：改显示名；改密码要原密码，其他设备掉线', async ({ page, browser }) => {
  // 用一个被邀请的临时账号，不动测试账号的密码
  const email = `settings-${currentRun()}@example.com`;
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((c) => c.name === 'hub_csrf')?.value ?? '';
  expect((await page.request.post('/api/team/invites', { headers: { 'x-hub-csrf': csrf }, data: { email, role: 'member' } })).status()).toBe(201);
  const token = new URL((await mailedLink(email, 'invite')).replace('#/invite?', '?')).searchParams.get('token');
  const me = await browser.newContext();
  const other = await browser.newContext();
  expect((await me.request.post('/api/auth/invite/accept', { data: { token, password: PASSWORD } })).ok()).toBe(true);
  expect((await other.request.post('/api/auth/login', { data: { email, password: PASSWORD } })).ok()).toBe(true);

  const tab = await me.newPage();
  await tab.goto('/');
  await tab.getByRole('button', { name: '账号' }).click();
  await tab.getByRole('button', { name: '个人设置' }).click();
  await tab.getByLabel('显示名').fill('新名字');
  await tab.getByRole('button', { name: '保存显示名' }).click();
  await expect(tab.getByText('已保存。')).toBeVisible();

  await tab.getByLabel('原密码').fill('wrong password 1');
  await tab.getByLabel('新密码（至少 10 位）').fill('changed pw 12345');
  await tab.getByLabel('再输一遍').fill('changed pw 12345');
  await tab.getByRole('button', { name: '修改密码' }).click();
  await expect(tab.getByRole('alert')).toBeVisible();
  await tab.getByLabel('原密码').fill(PASSWORD);
  await tab.getByRole('button', { name: '修改密码' }).click();
  await expect(tab.getByText('密码已修改，其他设备已退出。')).toBeVisible();
  await tab.screenshot({ path: '/workspace/shots/users/settings.png' });
  expect((await tab.request.get('/api/projects')).status()).toBe(200);
  expect((await other.request.get('/api/projects')).status()).toBe(401);
  await me.close();
  await other.close();
});

test('登录退避：同一邮箱连错 5 次后 429 + Retry-After；测试账号不受影响', async ({ request }) => {
  const email = `nobody-${currentRun()}@example.com`;
  for (let i = 0; i < 5; i++) expect((await request.post('/api/auth/login', { data: { email, password: 'wrong password' } })).status()).toBe(400);
  const blocked = await request.post('/api/auth/login', { data: { email, password: 'wrong password' } });
  expect(blocked.status()).toBe(429);
  expect(Number(blocked.headers()['retry-after'])).toBeGreaterThan(0);
  expect((await request.post('/api/auth/login', { data: { email: TEST_EMAIL, password: testPassword() } })).ok()).toBe(true);
});

test('审计带 IP，可按动作 / IP 过滤', async ({ page, request }) => {
  const email = `audit-${currentRun()}@example.com`;
  expect((await request.post('/api/auth/login', { data: { email, password: 'wrong password' } })).status()).toBe(400);
  await loginByApi(page);
  const api = (await (await page.request.get('/api/admin/audit?action=auth.login_failed')).json()) as { action: string; ip: string | null }[];
  expect(api.length).toBeGreaterThan(0);
  expect(api.every((entry) => entry.action === 'auth.login_failed')).toBe(true);
  expect(api[0]!.ip).toBeTruthy();

  await page.goto('/#/admin/audit');
  await page.getByLabel('动作').selectOption('auth.login_failed');
  const rows = page.getByTestId('audit-entry');
  await expect(rows.first()).toContainText('登录失败');
  await page.getByLabel('IP').fill('203.0.113.');
  await page.getByRole('button', { name: '筛选' }).click();
  await expect(page.getByText('没有符合条件的记录')).toBeVisible();
  await page.getByRole('button', { name: '清空' }).click();
  await page.getByLabel('动作').selectOption('auth.login_failed');
  await expect(rows.first()).toContainText('登录失败');
  await page.screenshot({ path: '/workspace/shots/users/audit-filter.png', fullPage: true });
});
