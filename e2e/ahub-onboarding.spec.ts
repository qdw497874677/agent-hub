import { expect, test, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';

// 用隔离的测试 Hub 提供真实页面和登录态，仅替换浏览器所见的地址，覆盖代理前缀与公网 HTTP。
async function openAt(page: Page, baseURL: string, origin: string, path = '/') {
  await page.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    const serverPath = url.pathname.replace(/^\/proxy(?=\/|$)/, '') || '/';
    const response = await page.request.fetch(`${baseURL}${serverPath}${url.search}`, {
      method: route.request().method(),
      data: route.request().postData() ?? undefined
    });
    await route.fulfill({ response });
  });
  await page.goto(`${origin}${path}#/access`);
  await expect(page.getByRole('heading', { name: '外部接入（MCP）' })).toBeVisible();
  await page.getByTestId('cli-guide').locator('summary').click();
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`CLI 引导：安全地址、失败时手动复制、公网 HTTP（${viewport.width}px）`, async ({ page, baseURL }) => {
    await page.setViewportSize(viewport);
    await loginByApi(page);
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied')) } });
    });

    await openAt(page, baseURL!, 'https://hub.example.test', '/proxy/');
    const guide = page.getByTestId('cli-guide');
    await expect(guide).toContainText('只给指定项目');
    await expect(guide).toContainText('Node.js 26');
    await expect(guide).toContainText('没有独立安装包');
    await expect(page.getByTestId('cli-guide-link')).toHaveAttribute('href', 'https://github.com/qdw497874677/agent-hub/blob/master/docs/design/external-access/cli-quickstart.md');
    const command = "node scripts/ahub.ts auth login --hub 'https://hub.example.test/proxy' --profile work";
    await expect(page.getByTestId('cli-guide-command')).toHaveText(command);
    await page.getByTestId('cli-guide-copy').click();
    await expect(page.getByTestId('cli-guide-copy')).toHaveAttribute('data-state', 'manual');
    await expect(page.getByTestId('cli-guide-manual-text')).toHaveValue(command);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

    await openAt(page, baseURL!, 'http://public.example.test');
    await expect(page.getByTestId('cli-guide-insecure')).toContainText('HTTPS');
    await expect(page.getByTestId('cli-guide-insecure')).toContainText('本机回环隧道');
    await expect(page.getByTestId('cli-guide-command')).toHaveCount(0);
    await expect(page.getByTestId('cli-guide-copy')).toHaveCount(0);
    await expect(page.getByTestId('token-limit-projects')).toBeVisible();

    await page.goto('/#/access');
    await page.getByTestId('cli-guide').locator('summary').click();
    await expect(page.getByTestId('cli-guide-command')).toHaveText(`node scripts/ahub.ts auth login --hub '${baseURL}' --profile work --allow-http`);
  });
}
