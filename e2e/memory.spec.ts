import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { loginByApi } from './login.ts';

/** 记忆页（ADR 0019 · P1）：手机宽度下能看、能记、能忘；密钥样的内容写不进去；项目写入模式能切。 */
test.use({ viewport: { width: 390, height: 844 } });

test('记忆页：记一条、看得到、忘掉；密钥被拒', async ({ page }) => {
  await loginByApi(page);
  await page.goto('/#/memory');
  await expect(page.getByRole('heading', { name: '记忆' })).toBeVisible();
  await expect(page.getByTestId('memory-scope').first()).toHaveText('我的');

  const title = `e2e 记忆 ${Date.now().toString(36)}`;
  await page.getByTestId('memory-title').fill(title);
  await page.getByTestId('memory-body').fill('部署前先做数据库快照');
  await page.getByTestId('memory-save').click();
  const row = page.getByTestId('memory-entry').filter({ hasText: title });
  await expect(row).toBeVisible();
  await expect(row).toContainText('生效');
  // 不横向溢出
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await page.getByTestId('memory-title').fill('带密钥');
  await page.getByTestId('memory-body').fill('token: ghp_' + 'a'.repeat(36));
  await page.getByTestId('memory-save').click();
  await expect(page.getByText(/密钥|secret/i).last()).toBeVisible();
  await expect(page.getByTestId('memory-entry').filter({ hasText: '带密钥' })).toHaveCount(0);

  page.once('dialog', (dialog) => void dialog.accept('过时了'));
  await row.getByTestId('memory-forget').click();
  await expect(row).toHaveCount(0);

  // 搜索 API：忘掉的搜不到
  const found = (await (await page.request.get(`/api/memory/search?q=${encodeURIComponent(title)}`)).json()) as { results: unknown[] };
  expect(found.results.filter((r) => JSON.stringify(r).includes(title))).toHaveLength(0);
});

test('项目写入模式默认只追加，可以切成审核', async ({ page, baseURL }) => {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  const created = await page.request.post('/api/projects', { data: { name: `e2e 记忆模式 ${Date.now().toString(36)}`, rootPath: mkdtempSync(join(tmpdir(), 'e2e-mem-')) }, headers });
  expect(created.ok(), await created.text()).toBe(true);
  const project = (await created.json()) as { id: string };
  const mode = await page.request.get(`/api/projects/${project.id}/memory`);
  expect(mode.ok(), await mode.text()).toBe(true);
  expect((await mode.json()).mode).toBe('append-only');
  const put = await page.request.put(`/api/projects/${project.id}/memory`, { data: { mode: 'review' }, headers });
  expect(put.ok()).toBe(true);
  expect((await (await page.request.get(`/api/projects/${project.id}/memory`)).json()).mode).toBe('review');
  const reindex = await page.request.post(`/api/projects/${project.id}/memory/reindex`, { data: {}, headers });
  expect(reindex.ok()).toBe(true);
  await page.goto('/#/memory');
  await expect(page.getByTestId('memory-scope').filter({ hasText: '记忆模式' }).first()).toBeVisible();
});

test('会话第一轮注入一次静态记忆引导（审计可见），第二轮不再注入', async ({ page, baseURL }) => {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((c) => c.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  let agentId: string | undefined;
  for (let i = 0; i < 40 && !agentId; i++) {
    const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ agentIds: string[]; state: string }>;
    agentId = workers.find((w) => w.state === 'online')?.agentIds[0];
    if (!agentId) await page.waitForTimeout(500);
  }
  test.skip(!agentId, '这台机器上没有可用的 agent');
  const made = await page.request.post('/api/projects', { data: { name: `e2e 引导 ${Date.now().toString(36)}`, rootPath: mkdtempSync(join(tmpdir(), 'e2e-guide-')) }, headers });
  expect(made.ok()).toBe(true);
  const project = (await made.json()) as { id: string };
  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '引导' }, headers })).json()) as { id: string };
  const session = (await (await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId, model: '' }, headers })).json()) as { id: string };
  const guided = async () => {
    const rows = (await (await page.request.get('/api/admin/audit?action=memory.guidance')).json()) as Array<Record<string, unknown>>;
    return rows.filter((r) => JSON.stringify(r).includes(session.id));
  };
  expect(await guided()).toHaveLength(0);
  expect((await page.request.post(`/api/sessions/${session.id}/prompt`, { data: { text: '第一轮' }, headers })).ok()).toBe(true);
  await expect.poll(async () => (await guided()).length, { message: '第一轮注入引导并记审计' }).toBe(1);
  expect(JSON.stringify((await guided())[0])).toMatch(/v\d+/);
  // 等第一轮跑完再发第二轮
  await page.goto(`/#/p/${project.id}/canvas`);
  await expect(page.locator('.react-flow__node-session').first().getByTestId('session-card-log')).toContainText('第一轮', { timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.request.post(`/api/sessions/${session.id}/prompt`, { data: { text: '第二轮' }, headers });
  await expect(page.locator('.react-flow__node-session').first().getByTestId('session-card-log')).toContainText('第二轮', { timeout: 30000 });
  expect(await guided(), '第二轮不再注入').toHaveLength(1);
});
