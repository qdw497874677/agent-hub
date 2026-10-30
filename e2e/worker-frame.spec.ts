import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';

/**
 * 同一台 worker 的会话在画布上一个框：标题是机器名 + 在线状态；拖框标题栏，框里的卡一起走；
 * 会话拖进别的 worker 的框会弹回；框的位置（由卡的位置推出）刷新后还在；框身不挡平移。
 * 测试环境只有一台 worker：把第二条会话的 workerId 在画布响应里改成一台不存在的机器，造出第二个框。
 */
const SHOTS = process.env['E2E_SCREENSHOTS'];
const GHOST = 'ghost-worker-e2e';

const nodePos = (page: Page, id: string) =>
  page.locator(`.react-flow__node[data-id="${id}"]`).evaluate((node) => {
    const match = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec((node as HTMLElement).style.transform);
    return match ? { x: Math.round(Number(match[1])), y: Math.round(Number(match[2])) } : null;
  });
const viewport = (page: Page) => page.locator('.react-flow__viewport').evaluate((node) => (node as HTMLElement).style.transform);

async function setup(page: Page, baseURL: string) {
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
  const dir = mkdtempSync(join(tmpdir(), 'e2e-frame-'));
  const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 框 ${Date.now().toString(36)}`, rootPath: dir }, headers })).json()) as { id: string };
  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '分框' }, headers })).json()) as { id: string };
  const derive = async () => ((await (await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId, model: '' }, headers })).json()) as { id: string }).id;
  const a = await derive();
  const b = await derive();
  await page.route(`**/api/projects/${project.id}/canvas`, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { sessions: Array<{ id: string; workerId: string | null }> };
    for (const session of body.sessions) if (session.id === b) session.workerId = GHOST;
    await route.fulfill({ response, json: body });
  });
  await page.goto(`/#/p/${project.id}/canvas`);
  await expect(page.locator('.react-flow__node-session')).toHaveCount(2);
  return { a, b };
}

async function drag(page: Page, touch: boolean, from: { x: number; y: number }, to: { x: number; y: number }) {
  const at = (k: number) => ({ x: Math.round(from.x + ((to.x - from.x) * k) / 12), y: Math.round(from.y + ((to.y - from.y) * k) / 12) });
  if (touch) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at(0)] });
    for (let k = 1; k <= 12; k++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [at(k)] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let k = 1; k <= 12; k++) await page.mouse.move(at(k).x, at(k).y);
    await page.mouse.up();
  }
}
const center = (box: { x: number; y: number; width: number; height: number }) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

test.describe('worker 框', () => {
  test.use({ hasTouch: true });
  for (const width of [1280, 390]) {
    test(`${width}px：同 worker 同框、拖框带卡、拖不进别的框、刷新后位置还在`, async ({ page, baseURL }) => {
      await page.setViewportSize({ width, height: 844 });
      const { a, b } = await setup(page, baseURL!);
      const frameA = page.locator('.react-flow__node[data-id^="frame:"]').filter({ hasNot: page.getByText('未知机器') });
      const frameB = page.locator('.react-flow__node[data-id="frame:' + GHOST + '"]');
      await expect(page.getByTestId('worker-frame')).toHaveCount(2);
      await expect(frameA.getByTestId('worker-frame-state')).toHaveText('在线');
      await expect(frameB.getByText('未知机器')).toBeVisible();
      await page.getByRole('button', { name: '整理布局' }).click();
      await page.waitForTimeout(500);

      // 卡在自己的框里
      const inside = async (frame: typeof frameA, id: string) => {
        const f = (await frame.boundingBox())!;
        const c = center((await page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox())!);
        return c.x > f.x && c.x < f.x + f.width && c.y > f.y && c.y < f.y + f.height;
      };
      expect(await inside(frameA, a)).toBe(true);
      expect(await inside(frameB, b)).toBe(true);
      expect(await inside(frameA, b)).toBe(false);

      // 框身不挡平移：在框的空白处（底部内边距）单指拖，画布平移
      const fb = (await frameA.boundingBox())!;
      const view = await viewport(page);
      // 框里一块没压着卡片的地方：点下去命中的是画布（框身 pointer-events: none）
      const spot = await page.evaluate((f) => {
        // 整数坐标（触摸会取整），且四周 8px 也都是空白，免得落在卡片边上
        const pane = (x: number, y: number) => document.elementFromPoint(x, y)?.classList.contains('react-flow__pane') ?? false;
        for (let y = Math.floor(f.y + f.height) - 2; y > f.y + 40; y -= 2)
          for (let x = Math.ceil(f.x) + 2; x < f.x + f.width - 2; x += 4)
            if ([[0, 0], [8, 0], [-8, 0], [0, 8], [0, -8]].every(([dx, dy]) => pane(x + dx!, y + dy!))) return { x, y };
        return null;
      }, fb);
      expect(spot, '框里有空白').not.toBeNull();
      await drag(page, true, spot!, { x: spot!.x - 40, y: spot!.y - 40 });
      await expect.poll(() => viewport(page), { message: '框身上拖平移画布' }).not.toBe(view);

      // 鼠标 / 手指拖框标题栏：框里的卡一起走，另一个框的卡不动
      for (const touch of [false, true]) {
        const beforeA = (await nodePos(page, a))!;
        const beforeB = await nodePos(page, b);
        const handle = (await frameA.getByTestId('worker-frame-handle').boundingBox())!;
        const from = { x: handle.x + 40, y: handle.y + handle.height / 2 };
        await drag(page, touch, from, { x: from.x + 30, y: from.y + 50 });
        await expect.poll(() => nodePos(page, a), { message: `${touch ? '手指' : '鼠标'}拖框带着卡走` }).not.toEqual(beforeA);
        expect(await nodePos(page, b)).toEqual(beforeB);
        expect(await inside(frameA, a)).toBe(true);
      }
      const moved = (await nodePos(page, a))!;

      // 会话拖进别的 worker 的框：弹回
      await page.locator('.react-flow__controls-fitview').click();
      await page.waitForTimeout(400);
      const header = (await page.locator(`.react-flow__node[data-id="${a}"] header`).boundingBox())!;
      const target = center((await frameB.boundingBox())!);
      await drag(page, false, { x: header.x + 20, y: header.y + header.height / 2 }, { x: target.x, y: target.y });
      await expect.poll(() => nodePos(page, a), { message: '拖进别的框会弹回' }).toEqual(moved);

      if (SHOTS) await page.screenshot({ path: `${SHOTS}/worker-frame-${width}.png` });

      // 刷新后框（由卡的位置推出）还在原地
      await page.reload();
      await expect(page.locator('.react-flow__node-session')).toHaveCount(2);
      await expect.poll(() => nodePos(page, a)).toEqual(moved);
    });
  }
});
