import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { loginByApi } from './login.ts';
import { currentRun } from './run-id.ts';

/** 假模型网关：/v1/models 要 Bearer fake-key。 */
let upstream: Server;
let port = 0;
test.beforeAll(async () => {
  upstream = createServer((request, response) => {
    const ok = request.headers.authorization === 'Bearer fake-key';
    response.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
    response.end(JSON.stringify(ok ? { data: [{ id: 'm-1' }] } : { error: 'bad key' }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  port = (upstream.address() as { port: number }).port;
});
test.afterAll(() => {
  upstream.closeAllConnections();
  upstream.close();
});

test('模型提供商：添加 → 直连测试 → 改成经 hub 中转再测 → 删除', async ({ page }) => {
  const slug = `gw${currentRun().replace(/[^a-z0-9]/gi, '').slice(-6).toLowerCase()}`;
  await loginByApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: '账号' }).click();
  await page.getByRole('button', { name: '模型提供商' }).click();
  await page.getByRole('button', { name: '添加模型提供商' }).click();
  await page.getByLabel('名称').fill('测试网关');
  await page.getByLabel(/^标识/).fill(slug);
  await page.getByLabel('Base URL').fill(`http://127.0.0.1:${port}/v1`);
  await page.getByLabel(/^API Key/).fill('fake-key');
  await page.getByLabel(/^模型 id/).fill('m-1');
  await page.screenshot({ path: '/workspace/shots/providers/form.png' });
  await page.getByRole('button', { name: /^(保存|添加|创建)/ }).click();
  const row = page.getByTestId(`provider-${slug}`);
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: '测试连接' }).click();
  await expect(row.getByTestId('provider-check')).toContainText('✓');
  await expect(row.getByTestId('provider-check')).toContainText('worker→提供商');
  await page.screenshot({ path: '/workspace/shots/providers/direct-check.png' });

  await row.getByRole('button', { name: '编辑' }).click();
  await page.getByLabel('请求怎么走').selectOption('hub');
  await page.getByRole('button', { name: /^(保存|添加|创建)/ }).click();
  await row.getByRole('button', { name: '测试连接' }).click();
  await expect(row.getByTestId('provider-check')).toContainText('worker→hub→提供商');
  await expect(row.getByTestId('provider-check')).toContainText('✓');
  await page.screenshot({ path: '/workspace/shots/providers/hub-check.png' });

  page.once('dialog', (dialog) => void dialog.accept());
  await row.getByRole('button', { name: '删除' }).click();
  await expect(row).toHaveCount(0);
});
