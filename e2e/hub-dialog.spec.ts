import { test, expect } from '@playwright/test';
import { loginByApi } from './login.ts';
import { chooseHubModel, e2eHubModel } from './hub-model.ts';

/**
 * 没有原生模型、只有 Hub 模型时：目录选好之后「开始」仍是灰的，
 * 用对话框里的真实模型控件选中之后才可点。不替空模型挑默认，也不点「开始」，所以不会打到上游。
 */
test('没有原生模型时要显式选 Hub 模型，「开始」才可用', async ({ page, baseURL }) => {
  test.skip(!e2eHubModel(), '未设置 E2E_HUB_MODEL');
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  const name = `hub-dialog-${Date.now().toString(36)}`;
  const project = (await (await page.request.post('/api/projects', { data: { name }, headers })).json()) as { id: string };
  await page.request.post('/api/tasks', { data: { projectId: project.id, title: '选模型' }, headers });
  await page.goto(`/#/p/${project.id}`);
  await page.locator('.react-flow__node-task').filter({ hasText: '选模型' }).getByRole('button', { name: '＋ 会话' }).click();
  const run = page.getByRole('dialog', { name: '在哪台机器、哪个工作空间干活？' });
  await run.getByRole('radio', { name: /新建持久工作空间/ }).click();
  const picker = page.getByLabel('目录选择器');
  await expect(picker).toBeVisible();
  const folder = `hub-dialog-${Date.now().toString(36)}`;
  await picker.getByRole('button', { name: '新建文件夹' }).click();
  await picker.getByLabel('新文件夹名').fill(folder);
  await picker.getByLabel('新文件夹名').press('Enter');
  await picker.getByRole('button', { name: '使用', exact: true }).click();
  await expect(run).toContainText(folder);
  const start = run.getByRole('button', { name: '开始' });
  await expect(run.locator('#derive-model')).toBeVisible();
  await expect(start).toBeDisabled();
  await chooseHubModel(run);
  await expect(run.locator('#derive-model')).toHaveValue(e2eHubModel());
  await expect(start).toBeEnabled();
});
