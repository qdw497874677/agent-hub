import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';

/**
 * 画布怎么动：卡片里的对话区只管滚动（nowheel/nopan/nodrag），
 * 移动卡片按住顶栏拖；拖空白处平移画布；空白处滚轮缩放。鼠标和单指触摸都要行。
 */
const SHOTS = process.env['E2E_SCREENSHOTS'];
const transform = (page: Page) => page.locator('.react-flow__viewport').evaluate((node) => (node as HTMLElement).style.transform);
const nodeTransform = (page: Page) => page.locator('.react-flow__node-session').evaluate((node) => (node as HTMLElement).style.transform);

async function canvasWithSession(page: Page, baseURL: string) {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL, 'x-hub-csrf': csrf };
  let agentId: string | undefined;
  for (let i = 0; i < 40 && !agentId; i++) {
    const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ agentIds: string[]; state: string }>;
    agentId = workers.find((worker) => worker.state === 'online')?.agentIds[0];
    if (!agentId) await page.waitForTimeout(500);
  }
  test.skip(!agentId, '这台机器上没有可用的 agent');
  const dir = mkdtempSync(join(tmpdir(), 'e2e-move-'));
  const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 移动 ${Date.now().toString(36)}`, rootPath: dir }, headers })).json()) as { id: string };
  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '移动' }, headers })).json()) as { id: string };
  await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId, model: '' }, headers });
  await page.goto(`/#/p/${project.id}/canvas`);
  await expect(page.locator('.react-flow__node-session')).toHaveCount(1);
}

async function touchDrag(page: Page, from: { x: number; y: number }, dx: number, dy: number) {
  const cdp = await page.context().newCDPSession(page);
  const p = (k: number) => [{ x: Math.round(from.x + (dx * k) / 10), y: Math.round(from.y + (dy * k) / 10) }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: p(0) });
  for (let k = 1; k <= 10; k++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: p(k) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function mouseDrag(page: Page, from: { x: number; y: number }, dx: number, dy: number) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let k = 1; k <= 10; k++) await page.mouse.move(from.x + (dx * k) / 10, from.y + (dy * k) / 10);
  await page.mouse.up();
}

/** 画布上一块确实空着的地方（不压卡片、不压控件）。 */
async function emptySpot(page: Page) {
  return page.evaluate(() => {
    const pane = document.querySelector('.react-flow__pane')!.getBoundingClientRect();
    for (let y = pane.bottom - 120; y > pane.top + 20; y -= 20) {
      for (let x = pane.left + 60; x < pane.right - 80; x += 20) {
        const el = document.elementFromPoint(x, y);
        if (el?.classList.contains('react-flow__pane')) return { x, y };
      }
    }
    return null;
  });
}

test.describe('画布移动', () => {
  test.use({ hasTouch: true });
  for (const width of [1280, 390]) {
    test(`${width}px：按住顶栏拖卡片、拖空白平移、滚轮缩放；鼠标和单指都行`, async ({ page, baseURL }) => {
      await page.setViewportSize({ width, height: 844 });
      await canvasWithSession(page, baseURL!);
      const header = page.locator('.react-flow__node-session header');
      await expect(page.getByTestId('card-drag-handle')).toBeVisible();

      // 鼠标按住顶栏（把手）拖卡片
      let before = await nodeTransform(page);
      const handle = (await page.getByTestId('card-drag-handle').boundingBox())!;
      await mouseDrag(page, { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }, 40, 30);
      await expect.poll(() => nodeTransform(page), { message: '鼠标拖顶栏移动了卡片' }).not.toBe(before);

      // 单指按住顶栏拖卡片
      before = await nodeTransform(page);
      const box = (await header.boundingBox())!;
      await touchDrag(page, { x: box.x + 30, y: box.y + box.height / 2 }, -30, 40);
      await expect.poll(() => nodeTransform(page), { message: '手指拖顶栏移动了卡片' }).not.toBe(before);

      // 鼠标拖空白处平移
      let spot = await emptySpot(page);
      expect(spot, '画布上有空白').not.toBeNull();
      let view = await transform(page);
      await mouseDrag(page, spot!, 50, -40);
      await expect.poll(() => transform(page), { message: '鼠标拖空白平移了画布' }).not.toBe(view);

      // 单指拖空白处平移
      spot = await emptySpot(page);
      view = await transform(page);
      await touchDrag(page, spot!, -40, -30);
      await expect.poll(() => transform(page), { message: '手指拖空白平移了画布' }).not.toBe(view);

      // 空白处滚轮缩放
      spot = await emptySpot(page);
      view = await transform(page);
      await page.mouse.move(spot!.x, spot!.y);
      await page.mouse.wheel(0, 200);
      await expect.poll(() => transform(page), { message: '空白处滚轮缩放了画布' }).not.toBe(view);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/canvas-move-${width}.png` });
    });
  }
});
