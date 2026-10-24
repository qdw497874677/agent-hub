import { chromium } from '@playwright/test';
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium' });
const page = await browser.newPage();
page.on('console', (m) => console.log('[console]', m.type(), m.text()));
page.on('response', async (r) => {
  if (r.url().includes('/api/search')) console.log('[search]', r.status(), (await r.text()).slice(0, 300));
});
await page.goto('http://127.0.0.1:7896/');
await page.getByRole('button', { name: /e2e-/ }).first().click().catch(() => {});
await page.waitForTimeout(1500);
await page.getByRole('button', { name: /搜索/ }).click();
const input = page.getByPlaceholder('搜任务标题，或者你记得的那句话');
await input.fill('E2E-OK');
await page.waitForTimeout(2000);
console.log('--- palette html ---');
console.log((await page.locator('.fixed.inset-0').innerHTML()).slice(0, 1200));
await browser.close();
