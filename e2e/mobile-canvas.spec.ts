import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { loginByApi } from './login.ts';

const SHOTS = process.env['E2E_SCREENSHOTS'];

/** 手机上打开画布：卡片要在视口里，不能一打开就偏到屏幕外。 */
test('手机打开画布：视图适配，卡片在屏幕内', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  const dir = mkdtempSync(join(tmpdir(), 'e2e-mobile-'));
  const name = `e2e 手机画布 ${Date.now().toString(36)}`;
  const made = await page.request.post('/api/projects', { data: { name, rootPath: dir }, headers });
  expect(made.status(), await made.text()).toBe(201);
  const project = (await made.json()) as { id: string };
  const positions: Record<string, { x: number; y: number }> = {};
  for (const [index, title] of ['第一张卡', '第二张卡', '第三张卡'].entries()) {
    const task = await page.request.post('/api/tasks', { data: { projectId: project.id, title }, headers });
    expect(task.ok(), await task.text()).toBe(true);
    // 桌面上排开的宽布局：横向 2000px，手机上原来按 minZoom 0.55 适配不下，卡片会偏出屏幕
    positions[((await task.json()) as { id: string }).id] = { x: index * 1000, y: index * 120 };
  }
  const saved = await page.request.put(`/api/projects/${project.id}/layout`, { data: { positions }, headers });
  expect(saved.ok(), await saved.text()).toBe(true);

  await page.goto(`/#/p/${project.id}`);
  const cards = page.locator('.react-flow__node-task');
  await expect(cards).toHaveCount(3);
  await page.waitForTimeout(600);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'mobile-canvas-open.png') });
  const pane = (await page.locator('.react-flow').boundingBox())!;
  // 放不下时左上对齐：树的开头（第一张卡）整张在屏幕里，其余的往右排，没有一张偏到左边或上边外面
  const first = (await cards.filter({ hasText: '第一张卡' }).boundingBox())!;
  expect(first.x + first.width, '第一张卡右边不出屏').toBeLessThanOrEqual(pane.x + pane.width + 1);
  for (const card of await cards.all()) {
    const box = (await card.boundingBox())!;
    expect(box.x, '左边不出屏').toBeGreaterThanOrEqual(pane.x - 1);
    expect(box.y, '上边不出屏').toBeGreaterThanOrEqual(pane.y - 1);
  }

  await page.request.delete(`/api/projects/${project.id}`, { data: { confirmName: name }, headers });
  rmSync(dir, { recursive: true, force: true });
});
