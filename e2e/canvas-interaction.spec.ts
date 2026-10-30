import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page, type Locator } from '@playwright/test';
import { loginByApi } from './login.ts';

/**
 * 画布交互分区矩阵（docs/guide.md「画布交互」）：每个区只做一件事，1280 / 390、鼠标 / 滚轮 / 单指 / 双指都过一遍，
 * 卡片都在 worker 框里。
 *   对话区＝只滚动；卡片顶栏＝拖卡；框标题栏＝拖整框；空白＝平移 + 缩放；单击＝选中；双击＝打开；卡内输入区＝正常输入。
 */
type Pt = { x: number; y: number };
const viewport = (page: Page) => page.locator('.react-flow__viewport').evaluate((n) => (n as HTMLElement).style.transform);
const pos = (node: Locator) => node.evaluate((n) => (n as HTMLElement).style.transform);
const center = async (l: Locator, dx = 0): Promise<Pt> => {
  const b = (await l.boundingBox())!;
  return { x: b.x + Math.min(b.width / 2, 24) + dx, y: b.y + b.height / 2 };
};

async function setup(page: Page, baseURL: string) {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((c) => c.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL, 'x-hub-csrf': csrf };
  let agentId: string | undefined;
  for (let i = 0; i < 40 && !agentId; i++) {
    const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ agentIds: string[]; state: string }>;
    agentId = workers.find((w) => w.state === 'online')?.agentIds[0];
    if (!agentId) await page.waitForTimeout(500);
  }
  test.skip(!agentId, '这台机器上没有可用的 agent');
  const dir = mkdtempSync(join(tmpdir(), 'e2e-zones-'));
  const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 分区 ${Date.now().toString(36)}`, rootPath: dir }, headers })).json()) as { id: string };
  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '分区' }, headers })).json()) as { id: string };
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) ids.push(((await (await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId, model: '' }, headers })).json()) as { id: string }).id);
  // 对话区要有内容才谈得上「滚」
  const long = Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 行`).join('\n');
  await page.request.post(`/api/sessions/${ids[0]}/prompt`, { data: { text: long }, headers });
  await page.goto(`/#/p/${project.id}/canvas`);
  await expect(page.locator('.react-flow__node-session')).toHaveCount(2);
  await expect(page.getByTestId('worker-frame')).toHaveCount(1);
  await expect(page.locator('.react-flow__node-session').first().getByTestId('session-card-log')).toContainText('第 30 行', { timeout: 30000 });
  await page.waitForTimeout(1200); // 等开场 fitView 动画停下
}

async function mouseDrag(page: Page, from: Pt, dx: number, dy: number) {
  await page.waitForTimeout(700); // 两次操作之间像人一样停一下，别被当成双击；d3-drag 在触摸结束后 500ms 内忽略鼠标
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let k = 1; k <= 10; k++) await page.mouse.move(from.x + (dx * k) / 10, from.y + (dy * k) / 10);
  await page.mouse.up();
}

async function touch(page: Page, starts: Pt[], deltas: Pt[]) {
  await page.waitForTimeout(700);
  const cdp = await page.context().newCDPSession(page);
  const at = (k: number) => starts.map((s, i) => ({ x: Math.round(s.x + (deltas[i]!.x * k) / 10), y: Math.round(s.y + (deltas[i]!.y * k) / 10), id: i }));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(0) });
  for (let k = 1; k <= 10; k++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(k) });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

async function emptySpot(page: Page): Promise<Pt> {
  const spot = await page.evaluate(() => {
    const pane = document.querySelector('.react-flow__pane')!.getBoundingClientRect();
    for (let y = pane.bottom - 140; y > pane.top + 20; y -= 20)
      for (let x = pane.left + 60; x < pane.right - 120; x += 20)
        if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')) return { x, y };
    return null;
  });
  expect(spot, '画布上要有空白').not.toBeNull();
  return spot!;
}

const scale = async (page: Page) => Number(/scale\(([\d.]+)\)/.exec(await viewport(page))?.[1] ?? 'NaN');

test.describe('画布交互分区', () => {
  test.use({ hasTouch: true });
  for (const width of [1280, 390]) {
    test(`${width}px：每个区只做自己的事`, async ({ page, baseURL }) => {
      await page.setViewportSize({ width, height: 844 });
      await setup(page, baseURL!);
      const card = page.locator('.react-flow__node-session').first();
      const other = page.locator('.react-flow__node-session').nth(1);
      const frame = page.locator('.react-flow__node-frame').first();
      const taskNode = page.locator('.react-flow__node-task').first();

      // 卡片顶栏 / 把手：鼠标、单指都能拖卡（在 worker 框里）
      for (const [how, target] of [['鼠标·把手', card.getByTestId('card-drag-handle')], ['鼠标·顶栏', card.locator('header')]] as const) {
        const before = await pos(card);
        const vp = await viewport(page);
        await mouseDrag(page, await center(target), 30, 20);
        await expect.poll(() => pos(card), { message: `${how}拖动卡片` }).not.toBe(before);
        expect(await viewport(page), `${how}不平移画布`).toBe(vp);
      }
      for (const [how, target] of [['单指·把手', card.getByTestId('card-drag-handle')], ['单指·顶栏', card.locator('header')]] as const) {
        const before = await pos(card);
        const vp = await viewport(page);
        await touch(page, [await center(target)], [{ x: 30, y: 20 }]);
        await expect.poll(() => pos(card), { message: `${how}拖动卡片` }).not.toBe(before);
        expect(await viewport(page), `${how}不平移画布`).toBe(vp);
      }
      // 框里的第二张卡也能拖
      {
        const before = await pos(other);
        await mouseDrag(page, await center(other.getByTestId('card-drag-handle')), 20, 20);
        await expect.poll(() => pos(other), { message: '框里第二张卡能拖' }).not.toBe(before);
      }

      // 对话区：拖它、在上面滚轮、单指滑动都不动卡片、不动画布
      for (const how of ['鼠标', '滚轮', '单指'] as const) {
        const log = card.getByTestId('session-card-log');
        const before = await pos(card);
        const vp = await viewport(page);
        const at = await center(log);
        if (how === '鼠标') await mouseDrag(page, at, 30, 20);
        if (how === '滚轮') {
          await page.mouse.move(at.x, at.y);
          await page.mouse.wheel(0, 200);
        }
        if (how === '单指') await touch(page, [at], [{ x: 0, y: -40 }]);
        await page.waitForTimeout(400);
        expect(await pos(card), `对话区${how}不拖卡`).toBe(before);
        expect(await viewport(page), `对话区${how}不动画布`).toBe(vp);
      }

      // 卡内输入区：正常打字，在上面拖不动卡
      {
        const input = card.locator('textarea').first();
        const before = await pos(card);
        await mouseDrag(page, await center(input), 30, 0);
        await input.click();
        await page.keyboard.type('输入区正常');
        await expect(input).toHaveValue('输入区正常');
        expect(await pos(card), '输入区里拖不动卡').toBe(before);
        await input.fill('');
      }

      // 框标题栏：拖整个框，框里的卡跟着走
      for (const how of ['鼠标', '单指'] as const) {
        const handle = page.getByTestId('worker-frame-handle').first();
        const cardBefore = await pos(card);
        const frameBefore = await pos(frame);
        const at = await center(handle);
        if (how === '鼠标') await mouseDrag(page, at, 25, 25);
        else await touch(page, [at], [{ x: 25, y: 25 }]);
        await expect.poll(() => pos(frame), { message: `${how}拖框标题栏移动整框` }).not.toBe(frameBefore);
        await expect.poll(() => pos(card), { message: `${how}拖框时卡片跟着走` }).not.toBe(cardBefore);
      }

      // 任务卡：鼠标、单指都能拖
      for (const how of ['单指', '鼠标', '单指'] as const) {
        const before = await pos(taskNode);
        const at = await center(taskNode.locator('span').first());
        if (how === '鼠标') await mouseDrag(page, at, 20, 30);
        else await touch(page, [at], [{ x: 20, y: 30 }]);
        await expect.poll(() => pos(taskNode), { message: `${how}拖任务卡` }).not.toBe(before);
      }

      // 空白：鼠标拖 / 单指拖平移；滚轮、ctrl+滚轮、双指捏合缩放
      for (const how of ['鼠标', '单指'] as const) {
        const vp = await viewport(page);
        const at = await emptySpot(page);
        if (how === '鼠标') await mouseDrag(page, at, 40, 30);
        else await touch(page, [at], [{ x: 40, y: 30 }]);
        await expect.poll(() => viewport(page), { message: `空白${how}拖平移画布` }).not.toBe(vp);
      }
      for (const how of ['滚轮', 'ctrl+滚轮', '双指'] as const) {
        const s = await scale(page);
        const at = await emptySpot(page);
        if (how === '双指') {
          await touch(page, [{ x: at.x - 20, y: at.y }, { x: at.x + 20, y: at.y }], [{ x: -40, y: 0 }, { x: 40, y: 0 }]);
        } else {
          await page.mouse.move(at.x, at.y);
          if (how === 'ctrl+滚轮') await page.keyboard.down('Control');
          await page.mouse.wheel(0, s > 0.6 ? 300 : -300);
          if (how === 'ctrl+滚轮') await page.keyboard.up('Control');
        }
        await expect.poll(() => scale(page), { message: `空白${how}缩放` }).not.toBe(s);
      }

      // 单击只选中；双击打开
      await other.locator('header').click({ position: { x: 60, y: 8 } });
      await expect(other).toHaveClass(/selected/);
      const url = page.url();
      await other.locator('header').dblclick({ position: { x: 60, y: 8 } });
      await expect.poll(() => page.url(), { message: '双击打开会话' }).not.toBe(url);
    });
  }
});
